#!/usr/bin/env python3
"""Reads a Microsoft Teams tenant through Microsoft Graph and writes a Ruchoir import archive.

Teams has no export a customer can download: the only complete way out is Microsoft Graph, read by
an application the customer registers in their own Entra ID and grants read permissions to. This
adapter is that reader. It writes the archive described in docs/import-archive.md, so the importer
never learns Teams' shape.

    convert-teams.py --tenant <tenant id or domain> --client-id <application id> \\
        --secret-file <file holding the client secret> --out <archive dir>

    convert-teams.py ... --list          the teams this application can read, and nothing else

**What crosses.** Every team becomes a space and every channel a conversation: standard channels
public, private and shared ones private with their own members. Messages cross with their replies,
their reactions, their mentions, their edit date, the files attached to them and the images pasted
into them, and the arrivals and departures Teams records as notices. The files of each team's
document library (the "Files" tab of its standard channels) cross into the space's files, folders
and all, except those already posted in a message, which travel with the message.

**What does not**, in plain words, is in the manifest's `limits`: chats (one-to-one and group
conversations, left in Teams by decision), what Graph does not expose (saved messages, favourite
channels, reading positions, a channel's pinned posts, edit history), and whatever this adapter met
and could not carry.

**It can be stopped and run again.** Every answer Graph gives is kept in a cache directory, and every
file fetched is kept there by its digest, so a second run after a failure starts from where the first
one stopped instead of from the beginning: a large tenant is hours of reading. The cache holds the
conversations in clear, like the archive before it is sealed: it is created readable by its owner
only, and it should be deleted once the archive is delivered (`--fresh` starts over).

This is the only part of the product that talks to Microsoft, and it talks to it once, during a
migration a customer asked for. It is not a runtime dependency.

Written against Microsoft Graph v1.0 as documented in September 2026, and not yet run against a real
tenant: its fixtures are shaped like the documentation's own examples. Treat its first real run as a
rehearsal, and read the counts it prints.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator

FORMAT_VERSION = 1
PRODUCER = "ruchoir-convert-teams 0.1.0"

# Where Microsoft lives. Named so that a test can point the whole conversation at a local server and
# check what actually goes over the wire, rather than a stand-in for it.
GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"

# How long one request is given, and how many times a refusal worth retrying is retried. Graph
# throttles per application and per tenant, and a migration reads everything: giving up on the
# first 429 would hand over an archive with holes in it.
TIMEOUT = 120
TRIES = 8

# Teams' six reactions from before it took any emoji, still spelled by name on old messages.
LEGACY_REACTIONS = {
    "like": "\U0001f44d",
    "heart": "❤️",
    "laugh": "\U0001f606",
    "surprised": "\U0001f62e",
    "sad": "\U0001f622",
    "angry": "\U0001f621",
}

# The permissions this reads with, each for one thing. Listed once, because the help below and the
# error that sends somebody to it must name the same ones.
PERMISSIONS = [
    ("Team.ReadBasic.All", "the list of teams and their names"),
    ("TeamMember.Read.All", "who is in each team"),
    ("Channel.ReadBasic.All", "the channels of each team"),
    ("ChannelMember.Read.All", "who is in each private or shared channel"),
    ("ChannelMessage.Read.All", "the messages, their replies and the images pasted into them"),
    ("User.Read.All", "the names and addresses of the people"),
    ("Files.Read.All", "the files posted in channels and the teams' document libraries"),
]

APP_HELP = """
This reads Teams through Microsoft Graph, as an application registered in your own Entra ID. It
needs one, allowed to read and nothing else, and removed once the migration is done:

  1. Sign in to https://entra.microsoft.com as an administrator and open
     Identity -> Applications -> App registrations -> New registration.
     Name it anything (for instance "Ruchoir migration"), keep "Accounts in this organizational
     directory only", leave the redirect URI empty, and register it.
  2. On its page, copy the "Application (client) ID" and the "Directory (tenant) ID".
  3. Open "API permissions" -> "Add a permission" -> "Microsoft Graph" -> "Application
     permissions", and add these, each of which reads one thing:
{permissions}
     Then select "Grant admin consent for <your organisation>" and confirm.
  4. Open "Certificates & secrets" -> "New client secret", give it a short life (a week is plenty),
     and copy its Value (not its ID) into a file readable only by you:

       umask 077; printf '%s' '<the secret value>' > ~/teams-secret

  5. Run this again with:
       --tenant <Directory (tenant) ID> --client-id <Application (client) ID> --secret-file ~/teams-secret
  6. Once the archive is delivered, delete the secret file and the application registration.
""".format(permissions="\n".join(f"       {name:26} {why}" for name, why in PERMISSIONS))


class Refused(Exception):
    """Graph said no, in a way no retry fixes: a missing permission, or no such thing."""

    def __init__(self, status: int, url: str, message: str) -> None:
        super().__init__(f"{status} on {url}: {message}")
        self.status = status
        self.url = url
        self.message = message


class NotFound(Refused):
    """The thing asked for is not there: a channel with no files folder, a user long gone."""


# -- time ----------------------------------------------------------------------------------------

def iso(value) -> str | None:
    """A Graph instant as the archive writes one: UTC, to the second.

    Graph spells them with three or seven decimals, with a `Z` or an offset, and uses the year one to
    mean "never". The archive has one spelling, so every one of those becomes it or nothing.
    """
    if not value or not isinstance(value, str) or value.startswith("0001-"):
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    match = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:\d{2})?$", text)
    if not match:
        return None
    moment = datetime.fromisoformat(match.group(1) + (match.group(3) or "+00:00"))
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -- the body: Teams HTML, as the Markdown the product reads --------------------------------------

VOID = {"br", "img", "hr", "input", "meta", "link", "source", "col", "wbr", "area", "base", "embed"}
BLOCK = {
    "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "figure",
    "ul", "ol", "li", "blockquote", "pre", "codeblock", "table", "thead", "tbody", "tfoot", "tr",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "dt", "dd",
}
# A soft line break: "a block ended or began here". Runs of them, and the spaces around them,
# collapse into one line break, because Teams wraps every line in a <div> and often in two.
SOFT = "\x01"
# Code is set aside while everything around it is tidied, then put back untouched.
KEEP = "\x02"


class Node:
    __slots__ = ("tag", "attrs", "children", "text")

    def __init__(self, tag: str | None, attrs: dict | None = None, text: str = "") -> None:
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[Node] = []
        self.text = text


class _TreeBuilder(HTMLParser):
    """Teams' HTML as a tree. Forgiving, the way a browser is: a tag closed twice or never is fine."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs})
        self.stack[-1].children.append(node)
        if node.tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag.lower(), {k.lower(): (v or "") for k, v in attrs}))

    def handle_endtag(self, tag):
        tag = tag.lower()
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(Node(None, text=data))


class Body:
    """What rendering one message body found besides its text."""

    def __init__(self) -> None:
        self.markdown = ""
        # `<attachment id=...>` placeholders the body carried, in order.
        self.placeholders: list[str] = []
        # Images pasted into the message, by the URL Graph serves their bytes from.
        self.hosted: list[str] = []


def to_markdown(content: str, content_type: str, mentions: list[dict], person) -> Body:
    """A message body as the Markdown the product reads.

    `person(user, name)` is asked for every person mentioned (`user` as Graph describes them) and
    answers with the archive's identifier for them, or None when they cannot be one (someone from
    outside the organisation):
    a mention crosses as `@{id}` when there is an account for it to name, and as the name it showed
    otherwise, because `@{8ea0e38b-...}` in a message means nothing to anyone.

    The product's reader is narrower than CommonMark and this writes only what it reads: `**`,
    `_`, `~~`, backticks, fences, `## ` headings, `- ` and `1. ` lists, `> ` quotes, bare links,
    named links `[text](address)` and pipe tables. A link whose text is not its address is written
    named when both can be (`named_link`), and as "text (address)" when they cannot.
    """
    body = Body()
    if not content:
        return body
    if (content_type or "").lower() != "html":
        body.markdown = content.replace("\r\n", "\n").strip()
        return body

    builder = _TreeBuilder()
    builder.feed(content)
    builder.close()
    kept: list[str] = []
    by_id = {str(m.get("id")): m for m in mentions or []}
    renderer = _Renderer(body, by_id, person, kept)
    text = _finish(renderer.children(builder.root))
    # One person written as two mentions ("Jane" and "Smith", which Teams does with a full name)
    # is one mention.
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"@\{([^}]+)\}[ \xa0]*@\{\1\}", r"@{\1}", text)
    for index, block in enumerate(kept):
        text = text.replace(f"{KEEP}{index}{KEEP}", block)
    body.markdown = text.strip()
    return body


def _finish(text: str) -> str:
    """Soft breaks collapsed into line breaks, spaces tidied, at most one blank line in a row."""
    text = text.replace("\xa0", " ")
    text = re.sub(rf"[ \t]*{SOFT}[{SOFT}\s]*", "\n", text)
    # Two spaces where two pieces met (an image's address beside the text around it). Code is set
    # aside at this point, so its own spacing is not touched.
    text = re.sub(r"(?<=\S)  +", " ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n")


def _wrap(marker: str, text: str) -> str:
    """`**text**`, keeping the spaces outside the markers: `**hello **` is not bold."""
    core = text.strip()
    if not core:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    return f"{lead}{marker}{core}{marker}{trail}"


def _classes(node: Node) -> list[str]:
    return node.attrs.get("class", "").split()


class _Renderer:
    def __init__(self, body: Body, mentions: dict, person, kept: list[str]) -> None:
        self.body = body
        self.mentions = mentions
        self.person = person
        self.kept = kept

    def children(self, node: Node) -> str:
        return "".join(self.render(child) for child in node.children)

    def keep(self, block: str) -> str:
        self.kept.append(block)
        return f"{KEEP}{len(self.kept) - 1}{KEEP}"

    def raw(self, node: Node) -> str:
        """The text of a node as written, line breaks included: code keeps its shape."""
        if node.tag is None:
            return node.text
        if node.tag == "br":
            return "\n"
        inner = "".join(self.raw(child) for child in node.children)
        if node.tag in ("div", "p") and inner and not inner.endswith("\n"):
            inner += "\n"
        return inner

    def render(self, node: Node) -> str:
        if node.tag is None:
            return re.sub(r"[ \t\r\n\f]+", " ", node.text)
        tag = node.tag
        if tag in ("script", "style", "head", "title", "systemeventmessage"):
            return ""
        if tag == "br":
            return "\n"
        if tag in ("b", "strong"):
            return _wrap("**", self.children(node))
        if tag in ("i", "em"):
            return _wrap("_", self.children(node))
        if tag in ("s", "strike", "del"):
            return _wrap("~~", self.children(node))
        if tag == "code":
            code = self.raw(node)
            if "\n" in code.strip("\n"):
                return self.keep(f"\n```\n{code.strip(chr(10))}\n```\n") + SOFT
            return self.keep("`" + code.replace("`", "'") + "`") if code.strip() else ""
        if tag in ("pre", "codeblock"):
            language = next(
                (c[len("language-"):].lower() for c in _classes(node) if c.startswith("language-")), ""
            )
            code = self.raw(node).strip("\n")
            return SOFT + self.keep(f"```{language}\n{code}\n```") + SOFT
        if tag == "a":
            text = _finish(self.children(node)).strip()
            href = node.attrs.get("href", "").strip()
            if not href or href.startswith("#"):
                return text
            if href.startswith("mailto:"):
                return text or href[len("mailto:"):]
            if not text or text == href or text.rstrip("/") == href.rstrip("/"):
                return href
            return named_link(text, href)
        if tag == "at":
            return self.mention(node)
        if tag in ("emoji", "customemoji"):
            return node.attrs.get("alt") or (f":{node.attrs['title']}:" if node.attrs.get("title") else "")
        if tag == "img":
            return self.image(node)
        if tag == "attachment":
            self.body.placeholders.append(node.attrs.get("id", ""))
            return ""
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            # One hash is a channel here: headings start at two.
            level = min(int(tag[1]) + 1, 6)
            text = _finish(self.children(node)).replace("\n", " ").strip()
            return f"{SOFT}{'#' * level} {text}{SOFT}" if text else SOFT
        if tag == "blockquote":
            text = _finish(self.children(node))
            if not text.strip():
                return SOFT
            return SOFT + "\n".join(f"> {line}" if line else ">" for line in text.split("\n")) + SOFT
        if tag in ("ul", "ol"):
            return self.listing(node, ordered=tag == "ol")
        if tag == "table":
            return self.table(node)
        if tag == "hr":
            return f"{SOFT}---{SOFT}"
        if tag in BLOCK:
            return SOFT + self.children(node) + SOFT
        return self.children(node)

    def mention(self, node: Node) -> str:
        shown = _finish(self.children(node)).strip()
        entry = self.mentions.get(node.attrs.get("id", ""))
        if not entry:
            return f"@{shown}" if shown else ""
        mentioned = entry.get("mentioned") or {}
        user = mentioned.get("user") or {}
        if user.get("id"):
            name = user.get("displayName") or entry.get("mentionText") or shown
            identifier = self.person(user, name)
            if identifier:
                return "@{" + identifier + "}"
        conversation = mentioned.get("conversation") or {}
        if conversation.get("conversationIdentityType") in ("channel", "team"):
            # Everyone in the room was called, which is what @channel says here.
            return "@channel"
        return "@" + (entry.get("mentionText") or shown)

    def image(self, node: Node) -> str:
        src = node.attrs.get("src", "")
        alt = node.attrs.get("alt", "")
        if "emoji" in node.attrs.get("itemtype", "").lower() or "emoji" in _classes(node):
            return alt
        if "/hostedContents/" in src:
            # Pasted into the message: its bytes cross as an attachment, and the body keeps no trace
            # of an address nobody outside Teams could open.
            self.body.hosted.append(html.unescape(src))
            return ""
        if src.startswith("http"):
            # Shown from elsewhere (an animated GIF, a linked picture): its address, which the
            # product turns back into a link.
            return f" {src} "
        return alt

    def listing(self, node: Node, ordered: bool) -> str:
        lines: list[str] = []
        number = 0
        for child in node.children:
            if child.tag != "li":
                continue
            number += 1
            text = _finish(self.children(child))
            if not text.strip():
                continue
            first, *rest = text.split("\n")
            lines.append((f"{number}. " if ordered else "- ") + first)
            # The product draws no nested list: an inner item stays an item, one level up.
            lines.extend(rest)
        return SOFT + "\n".join(lines) + SOFT if lines else SOFT

    def table(self, node: Node) -> str:
        """A pipe table: the first row is the header, then the dashed row that makes it a table.

        Teams tables often have no header row of their own, and the format needs one, so the first row
        stands as it. A bar inside a cell would cut the row in two (the reader has no escape for it),
        so it is written as the look-alike bar.
        """
        rows: list[list[str]] = []

        def walk(parent: Node) -> None:
            for child in parent.children:
                if child.tag == "tr":
                    cells = [
                        _finish(self.children(cell)).replace("\n", " ").replace("|", "\u00a6").strip()
                        for cell in child.children
                        if cell.tag in ("td", "th")
                    ]
                    if any(cells):
                        rows.append(cells)
                elif child.tag in ("thead", "tbody", "tfoot"):
                    walk(child)

        walk(node)
        if not rows:
            return SOFT
        width = max(len(row) for row in rows)
        lines = ["| " + " | ".join(row + [""] * (width - len(row))) + " |" for row in rows]
        lines.insert(1, "|" + " --- |" * width)
        return SOFT + "\n".join(lines) + SOFT


# An address the reader can close a named link on: http(s), no space, and any bracket balanced.
_NAMED_ADDRESS = re.compile(r"https?://[^\s()]*(?:\([^\s()]*\)[^\s()]*)*")


def named_link(text: str, href: str) -> str:
    """A link as the reader draws it: `[text](address)`, or `text (address)` when it cannot be one.

    The reader closes a named link at the first bracket or the first unbalanced parenthesis, so an
    address with a space or a stray bracket, or words with a bracket in them, would arrive cut in the
    middle. Those keep the older form, which is at worst a little plainer.
    """
    if _NAMED_ADDRESS.fullmatch(href) and not any(c in text for c in "[]\n"):
        return f"[{text}]({href})"
    return f"{text} ({href})"


def reaction_emoji(reaction: dict) -> str:
    """The character a reaction shows, or `:name:` for one this cannot draw.

    Teams now reacts with any emoji and stores the character itself. Its first six are still spelled
    by name on older messages, and a reaction an organisation drew itself is `custom`, whose picture
    lives in Teams and crosses as its name.
    """
    kind = (reaction.get("reactionType") or "").strip()
    if kind in LEGACY_REACTIONS:
        return LEGACY_REACTIONS[kind]
    if kind and not kind.isascii():
        return kind
    name = (reaction.get("displayName") or kind or "reaction").strip().lower()
    name = re.sub(r"[^a-z0-9_+-]+", "_", name).strip("_") or "reaction"
    return f":{name}:"


def sniff(data: bytes) -> str | None:
    """The media type of an image pasted into a message, from its first bytes."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


# -- Graph -----------------------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Hands a redirect back instead of following it, so the token never follows it elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib's name
        return None


class Graph:
    """Microsoft Graph, read with an application's own token, every answer kept on disk.

    The token goes to Graph and to the sign-in service and to nothing else. A file's bytes are
    served from a SharePoint address Graph redirects to, signed for the purpose, and that address is
    fetched without the token.
    """

    def __init__(
        self,
        tenant: str,
        client_id: str,
        secret: str,
        cache: Path,
        *,
        graph: str | None = None,
        login: str | None = None,
        pause=time.sleep,
    ) -> None:
        self.tenant = tenant
        self.client_id = client_id
        self.secret = secret
        self.graph = (graph or GRAPH).rstrip("/")
        self.login = (login or LOGIN).rstrip("/")
        self.cache = cache
        self.pause = pause
        self._token: str | None = None
        self._expires = 0.0
        # The organisation being read, as its identifier: `--tenant` may be a domain name, and a
        # person from another organisation is told apart by theirs. Read off the token.
        self.home_tenant: str | None = None
        self.requests = 0
        (cache / "json").mkdir(parents=True, exist_ok=True)
        (cache / "blobs").mkdir(parents=True, exist_ok=True)
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._downloads: dict[str, dict] = {}
        index = cache / "downloads.jsonl"
        if index.exists():
            for line in index.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    row = json.loads(line)
                    self._downloads[row["key"]] = row

    # the token ------------------------------------------------------------------------------
    def token(self, fresh: bool = False) -> str:
        if self._token and not fresh and time.time() < self._expires:
            return self._token
        form = urllib.parse.urlencode(
            {
                "client_id": self.client_id,
                "client_secret": self.secret,
                "scope": "https://graph.microsoft.com/.default",
                "grant_type": "client_credentials",
            }
        ).encode()
        url = f"{self.login}/{urllib.parse.quote(self.tenant)}/oauth2/v2.0/token"
        request = urllib.request.Request(url, data=form, method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:
                reason = json.loads(error.read()).get("error_description", "")
            except (ValueError, OSError):
                reason = ""
            # The sign-in service's own sentence names what is wrong (no such tenant, no such
            # application, a secret that expired), and it is the most useful thing to show.
            first = reason.split("\r\n")[0].split("\n")[0]
            raise SystemExit(
                f"Microsoft refused to sign this application in ({error.code}): {first}\n{APP_HELP}"
            ) from error
        self._token = payload["access_token"]
        # A minute early, so that a token never expires in the middle of a page.
        self._expires = time.time() + int(payload.get("expires_in", 3599)) - 60
        self.home_tenant = _claim(self._token, "tid") or self.home_tenant
        return self._token

    # plain requests ---------------------------------------------------------------------------
    def _url(self, path: str, params: dict | None = None) -> str:
        url = path if path.startswith("http") else f"{self.graph}{path}"
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, safe="$,:'()/ ")
        return url.replace(" ", "%20")

    def _is_graph(self, url: str) -> bool:
        return url.startswith(self.graph + "/") or url == self.graph

    def _send(self, url: str, *, accept_json: bool) -> tuple[bytes, str]:
        """One GET, retried through throttling and flaky networks, token refreshed once if refused.

        Returns the body and its media type. A redirect is followed here, without the token.
        """
        if not self._is_graph(url):
            raise ValueError(f"not a Graph address: {url}")
        refreshed = False
        last: Exception | None = None
        for attempt in range(TRIES):
            request = urllib.request.Request(url)
            request.add_header("Authorization", f"Bearer {self.token()}")
            if accept_json:
                request.add_header("Accept", "application/json")
                # Without it, a notice arrives as `unknownFutureValue` rather than as what it is.
                request.add_header("Prefer", "include-unknown-enum-members")
            self.requests += 1
            try:
                with self._opener.open(request, timeout=TIMEOUT) as response:
                    return response.read(), response.headers.get("Content-Type", "")
            except urllib.error.HTTPError as error:
                last = error
                message = _graph_error(error)
                error.close()
                if error.code in (301, 302, 303, 307, 308) and error.headers.get("Location"):
                    return self._fetch_elsewhere(error.headers["Location"])
                if error.code == 401 and not refreshed:
                    refreshed = True
                    self.token(fresh=True)
                    continue
                if error.code in (429, 500, 502, 503, 504):
                    self.pause(_retry_after(error, attempt))
                    continue
                if error.code == 404:
                    raise NotFound(404, url, message) from error
                raise Refused(error.code, url, message) from error
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                last = error
                self.pause(min(2**attempt, 60))
        raise RuntimeError(f"Graph kept failing on {url}: {last}")

    def _fetch_elsewhere(self, url: str) -> tuple[bytes, str]:
        """A redirect target: signed by Graph for this one download, so asked without the token."""
        last: Exception | None = None
        for attempt in range(TRIES):
            try:
                with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
                    return response.read(), response.headers.get("Content-Type", "")
            except urllib.error.HTTPError as error:
                last = error
                error.close()
                if error.code in (429, 500, 502, 503, 504):
                    self.pause(_retry_after(error, attempt))
                    continue
                raise Refused(error.code, url.split("?")[0], "the file's address refused") from error
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                last = error
                self.pause(min(2**attempt, 60))
        raise RuntimeError(f"kept failing to download {url.split('?')[0]}: {last}")

    # answers, kept -----------------------------------------------------------------------------
    def get(self, path: str, params: dict | None = None) -> dict:
        """One JSON answer, from the cache when an earlier run already asked the same question."""
        url = self._url(path, params)
        kept = self.cache / "json" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
        if kept.exists():
            payload = json.loads(kept.read_text(encoding="utf-8"))
            if payload.get("__not_found__"):
                raise NotFound(404, url, "not found (remembered from an earlier run)")
            return payload
        try:
            data, _ = self._send(url, accept_json=True)
        except NotFound:
            _write_atomically(kept, json.dumps({"__not_found__": True}))
            raise
        payload = json.loads(data or b"{}")
        _write_atomically(kept, json.dumps(payload, ensure_ascii=False))
        return payload

    def pages(self, path: str, params: dict | None = None) -> Iterator[dict]:
        """Every item of a collection, following `@odata.nextLink` to its last page."""
        payload = self.get(path, params)
        while True:
            yield from payload.get("value") or []
            following = payload.get("@odata.nextLink")
            if not following:
                return
            payload = self.get(following)

    def more(self, first: list[dict], following: str | None) -> list[dict]:
        """A collection that arrived inline (replies expanded into their message) and its rest."""
        items = list(first)
        while following:
            payload = self.get(following)
            items.extend(payload.get("value") or [])
            following = payload.get("@odata.nextLink")
        return items

    # bytes, kept ------------------------------------------------------------------------------
    def download(self, key: str, path: str) -> dict:
        """A file's bytes, stored by digest in the cache. Returns `hash`, `size` and `type`.

        `key` names the file for the cache, so that a second run does not fetch it again.
        """
        known = self._downloads.get(key)
        if known and (self.cache / "blobs" / known["hash"][:2] / known["hash"]).exists():
            return known
        data, content_type = self._send(self._url(path), accept_json=False)
        digest = hashlib.sha256(data).hexdigest()
        destination = self.cache / "blobs" / digest[:2] / digest
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            _write_atomically(destination, data)
        row = {
            "key": key,
            "hash": digest,
            "size": len(data),
            "type": (content_type or "").split(";")[0].strip(),
            "sniffed": sniff(data[:16]),
        }
        with (self.cache / "downloads.jsonl").open("a", encoding="utf-8") as sink:
            sink.write(json.dumps(row) + "\n")
        self._downloads[key] = row
        return row


def _claim(token: str, name: str) -> str | None:
    """One claim of an access token, read without checking its signature: only to learn which
    organisation it was issued for, never to trust it with anything."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get(name)
    except (IndexError, ValueError):
        return None


def _retry_after(error: urllib.error.HTTPError, attempt: int) -> float:
    """What Graph asks to wait, or a backoff when it does not say."""
    try:
        return max(1.0, min(float(error.headers.get("Retry-After", "")), 300.0))
    except (TypeError, ValueError):
        return float(min(2**attempt, 60))


def _graph_error(error: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(error.read())
        detail = payload.get("error") or {}
        return f"{detail.get('code', '')}: {detail.get('message', '')}".strip(": ")
    except (ValueError, OSError, AttributeError):
        return error.reason if isinstance(error.reason, str) else ""


def _write_atomically(path: Path, content) -> None:
    temporary = path.with_name(path.name + ".part")
    if isinstance(content, bytes):
        temporary.write_bytes(content)
    else:
        temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def _quoted(identifier: str) -> str:
    """A Teams identifier in a URL path. Channel identifiers carry `:` and `@`, which Graph takes."""
    return urllib.parse.quote(identifier, safe=":@")


# -- the conversion ------------------------------------------------------------------------------

class Converter:
    def __init__(self, graph: Graph, out: Path | None, *, fetch_files: bool = True, libraries: bool = True) -> None:
        self.graph = graph
        self.out = out
        self.fetch_files = fetch_files
        self.libraries = libraries
        if out is not None:
            out.mkdir(parents=True, exist_ok=True)
            # Messages are written channel by channel as they are read, so a run starts them over.
            (out / "messages.jsonl").write_text("", encoding="utf-8")
        # Everyone in the directory, by object identifier, read once.
        self.directory: dict[str, dict] = {}
        # The people the archive carries: a person is written when something names them.
        self.people: dict[str, dict] = {}
        self.spaces: list[dict] = []
        self.channels: list[dict] = []
        self.files: dict[str, dict] = {}
        self.message_count = 0
        # Document libraries by their address, so a link to a file resolves to the file.
        self.drives: dict[str, str] = {}
        self.personal_drives: set[str] = set()
        # What could not cross, counted or named, for the manifest.
        self.deleted = 0
        self.promoted = 0
        self.empty = 0
        self.dropped_events: set[str] = set()
        self.dropped_attachments: set[str] = set()
        self.cards = 0
        self.custom_reactions: set[str] = set()
        self.outsiders: set[str] = set()
        self.missing_files: list[str] = []
        self.external_images = 0
        self.skipped_items: set[str] = set()
        self.private_libraries = 0
        self.shared_channels = 0
        self.archived_teams = 0

    # people -------------------------------------------------------------------------------------
    def read_directory(self) -> None:
        for user in self.graph.pages(
            "/users",
            {"$select": "id,displayName,mail,userPrincipalName,accountEnabled,userType", "$top": "999"},
        ):
            self.directory[user["id"]] = user

    def person(self, user_id: str | None, name: str | None = None) -> str | None:
        """The archive's identifier for a person of this organisation, written the first time.

        Somebody the directory no longer holds (they left, and Entra forgot them) still wrote what
        they wrote: they cross as an account with no address, switched off, under the name their
        messages carried, which is how the other producers carry a person who is gone.
        """
        if not user_id:
            return None
        if user_id in self.people:
            return user_id
        entry = self.directory.get(user_id)
        if entry:
            email = (entry.get("mail") or "").strip()
            principal = (entry.get("userPrincipalName") or "").strip()
            if not email and "@" in principal and "#EXT#" not in principal:
                email = principal
            self.people[user_id] = {
                "id": user_id,
                "email": email,
                "display_name": entry.get("displayName") or email or principal or user_id,
                "active": bool(entry.get("accountEnabled", True)),
            }
        else:
            self.people[user_id] = {
                "id": user_id,
                "email": "",
                "display_name": (name or "").strip() or f"Former member {user_id[:8]}",
                "active": False,
            }
        return user_id

    def ours(self, user: dict) -> bool:
        """Whether a person Teams names belongs to the organisation being read."""
        if (user.get("userIdentityType") or "aadUser") != "aadUser":
            return False
        tenant = user.get("tenantId")
        home = self.graph.home_tenant
        return not (tenant and home and tenant != home)

    def mentioned(self, user: dict, name: str | None) -> str | None:
        """The archive's identifier for a person a message mentions, when they can have one."""
        return self.person(user["id"], name) if self.ours(user) else None

    def author(self, sender: dict | None) -> str | None:
        """Who wrote a message: an account, or an absent author the importer keeps apart."""
        sender = sender or {}
        user = sender.get("user") or {}
        if user.get("id"):
            if self.ours(user):
                return self.person(user["id"], user.get("displayName"))
            # A guest from outside, or someone federated from another organisation: they spoke,
            # and there is no account of theirs to give the words to.
            self.outsiders.add(user.get("userIdentityType") or "external")
            return "absent:" + (user.get("displayName") or user["id"])
        application = sender.get("application") or {}
        if application:
            return "absent:" + (application.get("displayName") or "app")
        return None

    # teams --------------------------------------------------------------------------------------
    def list_teams(self) -> list[dict]:
        return sorted(
            self.graph.pages("/teams", {"$select": "id,displayName,description"}),
            key=lambda t: (t.get("displayName") or "").lower(),
        )

    def choose(self, teams: list[dict], wanted: list[str]) -> list[dict]:
        if not wanted:
            return teams
        chosen = []
        for want in wanted:
            match = [
                t for t in teams
                if t["id"] == want or (t.get("displayName") or "").lower() == want.lower()
            ]
            if not match:
                sys.exit(f"no team called {want!r}: --list shows the teams this application can read")
            chosen.extend(m for m in match if m not in chosen)
        return chosen

    def read_team(self, summary: dict) -> None:
        team_id = summary["id"]
        team = self.graph.get(f"/teams/{team_id}")
        archived = bool(team.get("isArchived"))
        self.archived_teams += int(archived)
        name = team.get("displayName") or summary.get("displayName") or team_id
        print(f"team {name}", flush=True)
        self.spaces.append(
            {
                "id": team_id,
                "name": name,
                "description": team.get("description") or "",
                # A public team is one anyone in the organisation may join, which is what a public
                # space is here.
                "visibility": "public" if team.get("visibility") == "public" else "private",
            }
        )

        members = []
        for member in self.graph.pages(f"/teams/{team_id}/members"):
            if member.get("userId") in self.directory:
                members.append(self.person(member["userId"]))

        try:
            primary = self.graph.get(f"/teams/{team_id}/primaryChannel", {"$select": "id"}).get("id")
        except NotFound:
            primary = None
        channels = list(self.graph.pages(f"/teams/{team_id}/channels"))
        # The General channel first: the notices announcing the other channels are posted there,
        # and they say who created each one.
        channels.sort(key=lambda c: (c["id"] != primary, (c.get("displayName") or "").lower()))

        creators: dict[str, str] = {}
        team_drive: str | None = None
        for channel in channels:
            kind = channel.get("membershipType") or "standard"
            if kind == "shared":
                self.shared_channels += 1
            record = self.channel_record(team_id, channel, kind, members, archived)
            self.channels.append(record)
            drive = self.files_folder(team_id, channel)
            if drive and kind == "standard":
                team_drive = team_drive or drive
            elif drive:
                self.private_libraries += 1
            self.read_messages(team_id, channel, record, is_primary=channel["id"] == primary, creators=creators)

        if self.fetch_files and self.libraries and team_drive:
            self.read_library(team_id, team_drive)

    def channel_record(self, team_id: str, channel: dict, kind: str, team_members: list[str], archived: bool) -> dict:
        if kind == "standard":
            members = list(team_members)
        else:
            members = []
            for member in self.graph.pages(f"/teams/{team_id}/channels/{_quoted(channel['id'])}/members"):
                user = member.get("userId")
                if user in self.directory:
                    members.append(self.person(user))
                elif user:
                    # Someone from another organisation, in a shared channel: no account to be.
                    self.outsiders.add("shared channel member from another organisation")
        return {
            "id": channel["id"],
            "space": team_id,
            "kind": "channel",
            "name": channel.get("displayName") or "channel",
            "topic": channel.get("description") or "",
            "visibility": "public" if kind == "standard" else "private",
            "archived": archived or bool(channel.get("isArchived")),
            "members": list(dict.fromkeys(members)),
            "member_state": [],
            "created_at": iso(channel.get("createdDateTime")),
        }

    def files_folder(self, team_id: str, channel: dict) -> str | None:
        """The document library a channel's files live in, remembered by its address."""
        try:
            folder = self.graph.get(f"/teams/{team_id}/channels/{_quoted(channel['id'])}/filesFolder")
        except (NotFound, Refused):
            return None
        drive_id = (folder.get("parentReference") or {}).get("driveId")
        if not drive_id:
            return None
        if drive_id not in self.drives.values():
            self.remember_library(f"/drives/{drive_id}/root", drive_id)
        return drive_id

    def remember_library(self, root: str, drive_id: str | None = None) -> str | None:
        """Learns a document library's address from its root folder, so a link into it resolves.

        Through the root folder and not the library itself: Graph documents reading a drive
        (`/drives/{id}`, `/users/{id}/drive`) as closed to an application, while a drive's items,
        root included, are open to `Files.Read.All`. A root folder's address is its library's.
        """
        try:
            item = self.graph.get(root, {"$select": "id,webUrl,parentReference"})
        except (NotFound, Refused):
            return None
        drive_id = drive_id or (item.get("parentReference") or {}).get("driveId")
        if item.get("webUrl") and drive_id:
            self.drives[_plain_url(item["webUrl"])] = drive_id
        return drive_id

    # messages -----------------------------------------------------------------------------------
    def read_messages(self, team_id: str, channel: dict, record: dict, *, is_primary: bool, creators: dict) -> None:
        channel_id = channel["id"]
        rows: list[dict] = []
        path = f"/teams/{team_id}/channels/{_quoted(channel_id)}/messages"
        for root in self.graph.pages(path, {"$top": "50", "$expand": "replies"}):
            rows.extend(self.message(root, record, None, is_primary, creators))
            replies = self.graph.more(root.get("replies") or [], root.get("replies@odata.nextLink"))
            for reply in replies:
                rows.extend(self.message(reply, record, root, is_primary, creators))

        # A channel opens on its creation, as the source recorded it: an imported conversation that
        # starts on nothing reads as if it had been cut.
        if record.get("created_at"):
            rows.append(
                {
                    "id": f"{channel_id}/created",
                    "channel": channel_id,
                    "author": creators.get(channel_id),
                    "sent_at": record["created_at"],
                    "body": "",
                    "system_event": "channel_created",
                }
            )

        # A reply whose first message did not cross (deleted, or nothing left of it) would point at
        # nothing: it stands on its own instead.
        roots = {row["id"] for row in rows if not row.get("thread_root")}
        for row in rows:
            if row.get("thread_root") and row["thread_root"] not in roots:
                row["thread_root"] = None
                self.promoted += 1

        rows.sort(key=lambda row: (row["sent_at"] or "", row["id"]))
        with (self.out / "messages.jsonl").open("a", encoding="utf-8") as sink:
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.message_count += len(rows)
        print(f"  {record['name']}: {len(rows)} messages", flush=True)

    def message(self, raw: dict, record: dict, root: dict | None, is_primary: bool, creators: dict) -> list[dict]:
        channel_id = record["id"]
        identifier = f"{channel_id}/{raw['id']}" if root is None else f"{channel_id}/{root['id']}/{raw['id']}"
        thread_root = None if root is None else f"{channel_id}/{root['id']}"
        sent_at = iso(raw.get("createdDateTime"))
        if not sent_at:
            return []

        detail = raw.get("eventDetail")
        if detail or raw.get("messageType") == "systemEventMessage":
            return self.notice(detail or {}, identifier, channel_id, sent_at, record, is_primary, creators)
        if raw.get("deletedDateTime"):
            self.deleted += 1
            return []

        author = self.author(raw.get("from"))
        payload = raw.get("body") or {}
        mentions = raw.get("mentions") or []
        body = to_markdown(
            payload.get("content") or "", payload.get("contentType") or "text", mentions, self.mentioned
        )
        text = body.markdown

        quotes: list[str] = []
        extra: list[str] = []
        attached: list[str] = []
        sender = author if author in self.people else None
        for attachment in raw.get("attachments") or []:
            kind = attachment.get("contentType") or ""
            if kind == "reference":
                reference = self.reference(attachment, channel_id, sender)
                if reference:
                    attached.append(reference)
            elif kind in ("messageReference", "forwardedMessageReference"):
                quote = self.quote(attachment)
                if quote:
                    quotes.append(quote)
            elif kind.startswith("application/vnd.microsoft.card.") or kind.startswith(
                "application/vnd.microsoft.teams.card."
            ):
                card = self.card(attachment)
                if card:
                    extra.append(card)
            else:
                self.dropped_attachments.add(kind or "unnamed")

        for index, src in enumerate(body.hosted):
            reference = self.hosted(src, identifier, index, channel_id, sent_at, sender)
            if reference:
                attached.append(reference)

        subject = (raw.get("subject") or "").strip()
        parts = [p for p in ("\n".join(quotes), f"**{subject}**" if subject else "", text, "\n\n".join(extra)) if p]
        markdown = "\n\n".join(parts).strip()
        if not markdown and not attached:
            self.empty += 1
            return []

        reactions: dict[str, list[str]] = {}
        for reaction in raw.get("reactions") or []:
            emoji = reaction_emoji(reaction)
            if emoji.startswith(":"):
                self.custom_reactions.add(emoji.strip(":"))
            who = self.author({"user": (reaction.get("user") or {}).get("user")})
            if who and who not in reactions.setdefault(emoji, []):
                reactions[emoji].append(who)

        return [
            {
                "id": identifier,
                "channel": channel_id,
                "author": author,
                "sent_at": sent_at,
                "body": markdown,
                "format": "markdown",
                "thread_root": thread_root,
                "pinned": False,
                "edited_at": iso(raw.get("lastEditedDateTime")),
                "reactions": [{"emoji": e, "by": by} for e, by in reactions.items() if by],
                "files": list(dict.fromkeys(attached)),
            }
        ]

    def notice(self, detail: dict, identifier: str, channel_id: str, sent_at: str, record: dict,
               is_primary: bool, creators: dict) -> list[dict]:
        """A Teams notice, as the event it names, once per person it is about.

        Only events with an equivalent here cross, and they cross as an event name: the sentence is
        the product's, in the reader's language. The rest is dropped and declared.
        """
        kind = (detail.get("@odata.type") or "").rsplit(".", 1)[-1]
        initiator = ((detail.get("initiator") or {}).get("user") or {}).get("id")
        team_level = is_primary or record["visibility"] == "public"
        if kind == "channelAddedEventMessageDetail":
            if detail.get("channelId") and initiator:
                creators[detail["channelId"]] = self.person(initiator)
            return []
        if kind == "teamCreatedEventMessageDetail":
            return []
        events = []
        if kind == "membersAddedEventMessageDetail":
            name = "member_joined" if team_level else "channel_joined"
            events = [(m, name) for m in detail.get("members") or []]
        elif kind == "membersJoinedEventMessageDetail":
            events = [(m, "channel_joined") for m in detail.get("members") or []]
        elif kind in ("membersDeletedEventMessageDetail", "membersLeftEventMessageDetail"):
            for member in detail.get("members") or []:
                left = kind == "membersLeftEventMessageDetail" or member.get("id") == initiator
                if team_level:
                    events.append((member, "member_left" if left else "member_removed"))
                else:
                    events.append((member, "channel_left" if left else "channel_removed"))
        else:
            self.dropped_events.add(kind.removesuffix("EventMessageDetail") or "unnamed")
            return []

        rows = []
        for member, name in events:
            if (member.get("userIdentityType") or "aadUser") != "aadUser" or not member.get("id"):
                continue
            who = self.person(member["id"], member.get("displayName"))
            rows.append(
                {
                    "id": f"{identifier}/{member['id']}",
                    "channel": channel_id,
                    "author": who,
                    "sent_at": sent_at,
                    "body": "",
                    "system_event": name,
                }
            )
        return rows

    def quote(self, attachment: dict) -> str | None:
        """A reply quoting another message, as the quotation it showed."""
        try:
            content = json.loads(attachment.get("content") or "{}")
        except ValueError:
            return None
        preview = (content.get("messagePreview") or "").strip()
        if not preview:
            return None
        sender = ((content.get("messageSender") or {}).get("user") or {}).get("displayName")
        lines = preview.replace("\r\n", "\n").split("\n")
        if sender:
            lines[0] = f"**{sender}**: {lines[0]}"
        return "\n".join(f"> {line}" if line else ">" for line in lines)

    def card(self, attachment: dict) -> str | None:
        """A card an app posted, as the text on it: its layout has no equivalent here."""
        self.cards += 1
        try:
            content = json.loads(attachment.get("content") or "{}")
        except ValueError:
            return None
        texts: list[str] = []

        def walk(value) -> None:
            if isinstance(value, dict):
                for key in ("title", "subtitle", "text"):
                    if isinstance(value.get(key), str) and value[key].strip():
                        texts.append(value[key].strip())
                for key, child in value.items():
                    if key not in ("title", "subtitle", "text"):
                        walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(content)
        cleaned = [to_markdown(t, "html", [], lambda *_: None).markdown if "<" in t else t for t in texts]
        return "\n".join(dict.fromkeys(c for c in cleaned if c)) or None

    # files --------------------------------------------------------------------------------------
    def reference(self, attachment: dict, channel_id: str, sender: str | None) -> str | None:
        """A file posted in a message: resolved to the drive item behind its link, and fetched."""
        url = attachment.get("contentUrl") or ""
        name = attachment.get("name") or url.rsplit("/", 1)[-1] or "file"
        if not self.fetch_files:
            return None
        item, drive_id = self.resolve_link(url, sender)
        if not item:
            self.missing_files.append(f"{name} (its link no longer leads to a file)")
            return None
        return self.store_item(item, drive_id, channel=channel_id)

    def resolve_link(self, url: str, sender: str | None) -> tuple[dict | None, str | None]:
        """The drive item a link names: through the library it lives in, then through Graph's own
        link resolution, which needs more than reading and may be refused."""
        plain = _plain_url(url)
        for attempt in range(2):
            for prefix, drive_id in sorted(self.drives.items(), key=lambda kv: -len(kv[0])):
                if plain.startswith(prefix + "/"):
                    relative = plain[len(prefix) + 1:]
                    try:
                        item = self.graph.get(f"/drives/{drive_id}/root:/{urllib.parse.quote(relative)}")
                        return item, drive_id
                    except (NotFound, Refused):
                        return None, None
            # A file from somebody's own OneDrive, most often the sender's.
            if attempt == 0 and sender and sender not in self.personal_drives and "/personal/" in plain:
                self.personal_drives.add(sender)
                if self.remember_library(f"/users/{sender}/drive/root"):
                    continue
            break
        encoded = "u!" + base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        try:
            item = self.graph.get(f"/shares/{encoded}/driveItem")
            return item, (item.get("parentReference") or {}).get("driveId")
        except (NotFound, Refused):
            return None, None

    def store_item(self, item: dict, drive_id: str | None, *, channel: str | None = None,
                   space: str | None = None, folder: str | None = None) -> str | None:
        """Fetches a drive item's bytes and records it once, however many messages carry it."""
        drive_id = drive_id or (item.get("parentReference") or {}).get("driveId")
        if not drive_id or not item.get("id"):
            return None
        identifier = f"drive:{drive_id}/{item['id']}"
        if identifier in self.files:
            return identifier
        name = item.get("name") or item["id"]
        try:
            fetched = self.graph.download(identifier, f"/drives/{drive_id}/items/{item['id']}/content")
        except (Refused, RuntimeError) as error:
            self.missing_files.append(f"{name} ({error})")
            return None
        expected = item.get("size")
        if isinstance(expected, int) and expected and expected != fetched["size"]:
            self.missing_files.append(f"{name} (expected {expected} bytes, got {fetched['size']})")
            return None
        creator = ((item.get("createdBy") or {}).get("user") or {}).get("id")
        record = {
            "id": identifier,
            "name": name,
            "size": fetched["size"],
            "content_type": (item.get("file") or {}).get("mimeType")
            or mimetypes.guess_type(name)[0]
            or "application/octet-stream",
            "hash": f"sha256:{fetched['hash']}",
            "uploaded_by": self.person(creator) if creator in self.directory or creator in self.people else None,
            "uploaded_at": iso(item.get("createdDateTime")),
        }
        if channel:
            record["channel"] = channel
        if space:
            record["space"] = space
        if folder:
            record["folder"] = folder
        self.files[identifier] = record
        return identifier

    def hosted(self, src: str, message_id: str, index: int, channel_id: str, sent_at: str, sender: str | None) -> str | None:
        """An image pasted into a message: its bytes, served by Graph, cross as an attachment."""
        if not self.fetch_files:
            return None
        if not src.startswith(self.graph.graph + "/"):
            self.external_images += 1
            return None
        piece = hashlib.sha256(src.encode()).hexdigest()[:16]
        identifier = f"hosted:{message_id}/{piece}"
        if identifier in self.files:
            return identifier
        try:
            fetched = self.graph.download(identifier, src)
        except (Refused, RuntimeError) as error:
            self.missing_files.append(f"an image pasted in a message of {sent_at} ({error})")
            return None
        content_type = fetched.get("sniffed") or fetched.get("type") or "image/png"
        extension = mimetypes.guess_extension(content_type) or ".png"
        self.files[identifier] = {
            "id": identifier,
            "name": f"image-{index + 1}{extension}",
            "size": fetched["size"],
            "content_type": content_type,
            "hash": f"sha256:{fetched['hash']}",
            "channel": channel_id,
            "uploaded_by": sender,
            "uploaded_at": sent_at,
        }
        return identifier

    def read_library(self, team_id: str, drive_id: str) -> None:
        """The team's document library, folders and all, into the space's files.

        A file already posted in a message travels with the message, and is not brought a second
        time: the library holds every file ever posted in a standard channel.
        """
        before = len(self.files)

        def walk(path: str, folder: list[str]) -> None:
            for item in self.graph.pages(path):
                if item.get("folder") is not None:
                    walk(f"/drives/{drive_id}/items/{item['id']}/children", folder + [item.get("name") or item["id"]])
                elif item.get("file") is not None:
                    identifier = f"drive:{drive_id}/{item['id']}"
                    if identifier not in self.files:
                        self.store_item(item, drive_id, space=team_id, folder="/".join(folder) or None)
                elif item.get("package") is not None:
                    self.skipped_items.add((item.get("package") or {}).get("type") or "package")
                else:
                    self.skipped_items.add("item that is neither a file nor a folder")

        walk(f"/drives/{drive_id}/root/children", [])
        print(f"  document library: {len(self.files) - before} files", flush=True)

    # writing ------------------------------------------------------------------------------------
    def write(self) -> None:
        self._write_jsonl("spaces.jsonl", self.spaces)
        self._write_jsonl("users.jsonl", list(self.people.values()))
        self._write_jsonl("channels.jsonl", self.channels)
        self._write_jsonl("files.jsonl", list(self.files.values()))
        blobs = self.out / "blobs"
        for record in self.files.values():
            digest = record["hash"].split(":", 1)[1]
            source = self.graph.cache / "blobs" / digest[:2] / digest
            destination = blobs / digest[:2] / digest
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(source, destination)
            except OSError:
                shutil.copyfile(source, destination)

        manifest = {
            "format_version": FORMAT_VERSION,
            "source": "teams",
            "source_version": "Microsoft Graph v1.0",
            "producer": PRODUCER,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "counts": {
                "spaces": len(self.spaces),
                "users": len(self.people),
                "channels": len(self.channels),
                "messages": self.message_count,
                "files": len(self.files),
            },
            "checksums": {},
            "limits": self.declare(),
        }
        (self.out / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def declare(self) -> list[str]:
        """What did not cross, said before anybody discovers it. Each line names one thing."""
        limits = [
            "Chats (one-to-one and group conversations, meeting chats included) are not imported: "
            "they stay in Teams. Only the teams' channels cross.",
            "Microsoft Graph does not give an application the saved messages, the favourite channels, "
            "the reading positions or a channel's pinned posts, so nobody arrives with any of them.",
            "A message crosses with its current text and the date it was last edited: Teams keeps its "
            "earlier versions only under a retention policy, out of reach of this export.",
            "Team owners arrive as ordinary members of their space: the archive carries no roles.",
            "Profile pictures do not cross.",
        ]
        if self.deleted:
            limits.append(f"{self.deleted} deleted message(s) are absent: Teams keeps their place, not their text.")
        if self.promoted:
            limits.append(
                "Replies whose first message was deleted, or could not cross, now stand on their own "
                f"rather than under it: {self.promoted} of them."
            )
        if self.empty:
            limits.append(f"{self.empty} message(s) with nothing this could show (no text, no file) were left out.")
        if self.private_libraries:
            limits.append(
                f"The document libraries of {self.private_libraries} private or shared channel(s) are not "
                "imported, only the files posted in their messages: their files belong to the channel's "
                "members, and the space's files would show them to everyone in the space."
            )
        if self.shared_channels:
            limits.append(
                "Shared channels cross as private channels of the team that owns them; the people from "
                "other organisations in them do not cross as members."
            )
        if self.outsiders:
            limits.append(
                "People from outside the organisation (guests who are not in its directory, federated or "
                "anonymous participants) have no account here: what they wrote is kept under their name "
                "as an absent author."
            )
        if self.cards:
            limits.append(
                f"{self.cards} card(s) posted by apps and connectors cross as the text on them, without "
                "their layout or their buttons."
            )
        if self.dropped_attachments:
            limits.append(
                "Attachments of these kinds have no equivalent here and are left out: "
                + ", ".join(sorted(self.dropped_attachments)) + "."
            )
        if self.dropped_events:
            limits.append(
                "Teams notices with no equivalent here are dropped rather than phrased in Teams' words: "
                + ", ".join(sorted(self.dropped_events)) + "."
            )
        if self.custom_reactions:
            limits.append(
                "Reactions drawn by the organisation itself cross as their name, :like_this:, since the "
                "picture stays in Teams: " + ", ".join(sorted(self.custom_reactions)[:20])
            )
        if self.external_images:
            limits.append(
                f"{self.external_images} image(s) shown in messages from outside Teams (animated GIFs, "
                "linked pictures) cross as their address."
            )
        if not self.fetch_files:
            limits.append("Files were not fetched: this conversion was asked to leave them behind.")
        elif not self.libraries:
            limits.append(
                "The teams' document libraries were not read: only the files posted in messages cross."
            )
        if self.skipped_items:
            limits.append(
                "Library items that are not plain files are left out: " + ", ".join(sorted(self.skipped_items)) + "."
            )
        if self.missing_files:
            limits.append(
                "Files this conversion could not fetch, so they are absent from this archive: "
                + "; ".join(self.missing_files[:20])
                + (f"; and {len(self.missing_files) - 20} more" if len(self.missing_files) > 20 else "")
            )
        limits.append(
            "Calls, meetings, recordings, tabs, apps, Loop components and wikis are not imported."
        )
        return limits

    def _write_jsonl(self, name: str, rows) -> None:
        with (self.out / name).open("w", encoding="utf-8") as sink:
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")


def _plain_url(url: str) -> str:
    """An address as a comparable string: decoded, without its query, without a trailing slash."""
    return urllib.parse.unquote(url.split("?")[0]).rstrip("/")


def missing_permission(error: Refused) -> str:
    return (
        f"Microsoft Graph refused {error.url.split('?')[0]} ({error.status}): {error.message}\n"
        "The application is most likely missing a permission, or its administrator consent."
        f"\n{APP_HELP}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tenant", required=True, help="Directory (tenant) ID, or the organisation's domain")
    parser.add_argument("--client-id", required=True, help="Application (client) ID of the registered application")
    parser.add_argument(
        "--secret-file",
        required=True,
        type=Path,
        help="file holding the application's client secret. Read from a file, never an argument, so it "
        "stays out of the shell history.",
    )
    parser.add_argument("--out", type=Path, help="archive directory to write")
    parser.add_argument("--list", action="store_true", help="list the teams this application can read, and stop")
    parser.add_argument(
        "--team",
        action="append",
        default=[],
        help="bring only this team (its name or identifier). Repeatable. Every team, when absent.",
    )
    parser.add_argument("--cache", type=Path, help="where Graph's answers are kept between runs (default: <out>.cache)")
    parser.add_argument("--fresh", action="store_true", help="forget what an earlier run read and start over")
    parser.add_argument("--no-files", action="store_true", help="leave every file behind (declared in the manifest)")
    parser.add_argument(
        "--no-libraries",
        action="store_true",
        help="bring the files posted in messages, but not the teams' document libraries",
    )
    parser.add_argument("--help-app", action="store_true", help="print how to register the application, and stop")
    args = parser.parse_args()

    if args.help_app:
        print(APP_HELP)
        return
    if not args.list and not args.out:
        parser.error("--out is required, unless --list is given")

    secret = args.secret_file.read_text(encoding="utf-8").strip()
    # The cache holds the conversations in clear, and so does the archive before it is sealed: their
    # owner reads them, nobody else.
    old_mask = os.umask(0o077)
    try:
        if args.list:
            listing = Path(tempfile.mkdtemp(prefix="ruchoir-teams-list-"))
            try:
                converter = Converter(Graph(args.tenant, args.client_id, secret, listing), None)
                teams = converter.list_teams()
            except Refused as error:
                raise SystemExit(missing_permission(error)) from error
            finally:
                shutil.rmtree(listing, ignore_errors=True)
            for team in teams:
                print(f"{team['id']}  {team.get('displayName') or ''}")
            print(f"{len(teams)} team(s)")
            return

        cache = args.cache or Path(f"{args.out}.cache")
        if args.fresh and cache.exists():
            shutil.rmtree(cache)
        cache.mkdir(parents=True, exist_ok=True)
        graph = Graph(args.tenant, args.client_id, secret, cache)
        converter = Converter(graph, args.out, fetch_files=not args.no_files, libraries=not args.no_libraries)
        try:
            chosen = converter.choose(converter.list_teams(), args.team)
            converter.read_directory()
            for team in chosen:
                converter.read_team(team)
        except Refused as error:
            raise SystemExit(missing_permission(error)) from error
        except RuntimeError as error:
            # Everything read so far is in the cache: running the same command again resumes.
            raise SystemExit(
                f"{error}\nMicrosoft Graph is not answering. Run the same command again later: what was "
                f"already read is kept in {cache} and is not read twice."
            ) from error
        converter.write()
    finally:
        os.umask(old_mask)

    print(f"done: {args.out}")
    print(
        f"  {len(converter.spaces)} space(s), {len(converter.people)} accounts, "
        f"{len(converter.channels)} conversations, {converter.message_count} messages, "
        f"{len(converter.files)} files ({graph.requests} requests to Graph)"
    )
    if converter.missing_files:
        print(f"  {len(converter.missing_files)} file(s) could not be fetched, see the manifest")
    print(f"  read {args.out}/manifest.json for what was deliberately left behind")
    print(f"  the archive and {cache} are in clear: seal the first, delete the second once delivered")


if __name__ == "__main__":
    main()
