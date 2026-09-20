#!/usr/bin/env python3
"""Turns a Slack workspace export into a Ruchoir import archive.

A Slack export is a ZIP an owner asks for in the admin (Settings -> Import/Export Data -> Export).
It holds `users.json`, `channels.json` and one directory per channel containing a `YYYY-MM-DD.json`
file per day. This adapter reads that and writes the archive described in docs/import-archive.md,
so the importer never learns Slack's shape.

    convert-slack.py --export <unpacked export dir> --out <archive dir>

**A Slack export carries links to its files, not the files.** Every attachment is a URL, and that
is the one thing that makes this adapter different from the others: it downloads the bytes. The
export signs its own URLs, so nothing is asked of the customer and nothing has to be explained:
the files simply arrive. That signature dies with the export, which Slack deletes ten days after
download, and only then does a token become the subject: the conversion stops, prints how to make
one, and picks up where it left off when rerun with `--token-file`. Nobody is sent to read about
OAuth scopes for an export that was going to work.

This is the only part of the product that talks to Slack, and it talks to it once, during a
migration a customer asked for. It is not a runtime dependency.

What this reads was established against a real export (Slack export format version 2, September
2026), not from the documentation alone. What a standard export leaves behind is in the manifest's
`limits`, in Slack's own terms: private channels, direct messages, and edit and delete logs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

FORMAT_VERSION = 1
PRODUCER = "ruchoir-convert-slack 0.1.0"

# Slack narrates events as messages with a `subtype`. Only the ones with an equivalent here cross,
# and they cross as an event name: the sentence stays ours, in the reader's language. Everything
# else (renames, topic and purpose changes, archive notices, pinned-item notices) is dropped and
# declared, because a vendor's phrasing in a Ruchoir thread is worse than no line at all.
SYSTEM_EVENTS = {
    "channel_join": "channel_joined",
    "channel_leave": "channel_left",
    "group_join": "channel_joined",
    "group_leave": "channel_left",
}

# Subtypes that are ordinary messages wearing a label. `thread_broadcast` is a reply that was also
# shown in the channel; `me_message` is a /me line; `file_share` is how older exports mark a message
# that carries an attachment, and `bot_message` is a post from an app. All of them have text a
# reader wrote or an app wrote, so they cross as messages.
PLAIN_SUBTYPES = {"thread_broadcast", "me_message", "file_share", "bot_message", "file_comment"}

# Reaction names, turned back into characters: the product stores native Unicode, and an
# untranslated name arrives as the word `tada` sitting under a message where a face should be.
# The table is duplicated from convert-mattermost.py on purpose: each producer is a single file a
# customer fetches and runs, so neither may import the other.
#
# The common set, not the whole of it. A name missing from here crosses as `:name:`, which the
# archive contract allows, and the export says so in its limits so nobody discovers it a week later.
EMOJI = {
    "+1": "\U0001f44d", "thumbsup": "\U0001f44d", "-1": "\U0001f44e", "thumbsdown": "\U0001f44e",
    "smile": "\U0001f604", "smiley": "\U0001f603", "grinning": "\U0001f600", "grin": "\U0001f601",
    "laughing": "\U0001f606", "satisfied": "\U0001f606", "sweat_smile": "\U0001f605",
    "joy": "\U0001f602", "rofl": "\U0001f923", "slightly_smiling_face": "\U0001f642",
    "upside_down_face": "\U0001f643", "wink": "\U0001f609", "blush": "\U0001f60a",
    "innocent": "\U0001f607", "heart_eyes": "\U0001f60d", "kissing_heart": "\U0001f618",
    "yum": "\U0001f60b", "stuck_out_tongue": "\U0001f61b", "neutral_face": "\U0001f610",
    "zany_face": "\U0001f92a", "raised_eyebrow": "\U0001f928", "expressionless": "\U0001f611",
    "smirk": "\U0001f60f", "unamused": "\U0001f612", "roll_eyes": "\U0001f644",
    "grimacing": "\U0001f62c", "relieved": "\U0001f60c", "pensive": "\U0001f614",
    "sleepy": "\U0001f62a", "sleeping": "\U0001f634", "mask": "\U0001f637",
    "hot_face": "\U0001f975", "cold_face": "\U0001f976", "woozy_face": "\U0001f974",
    "dizzy_face": "\U0001f635", "exploding_head": "\U0001f92f", "cowboy_hat_face": "\U0001f920",
    "partying_face": "\U0001f973", "sunglasses": "\U0001f60e", "nerd_face": "\U0001f913",
    "confused": "\U0001f615", "worried": "\U0001f61f", "slightly_frowning_face": "\U0001f641",
    "open_mouth": "\U0001f62e", "hushed": "\U0001f62f", "astonished": "\U0001f632",
    "flushed": "\U0001f633", "pleading_face": "\U0001f97a", "frowning": "\U0001f626",
    "fearful": "\U0001f628", "cry": "\U0001f622", "sob": "\U0001f62d", "scream": "\U0001f631",
    "confounded": "\U0001f616", "disappointed": "\U0001f61e", "sweat": "\U0001f613",
    "weary": "\U0001f629", "tired_face": "\U0001f62b", "triumph": "\U0001f624",
    "rage": "\U0001f621", "angry": "\U0001f620", "thinking_face": "\U0001f914",
    "thinking": "\U0001f914", "shushing_face": "\U0001f92b", "zipper_mouth_face": "\U0001f910",
    "hugs": "\U0001f917", "star_struck": "\U0001f929", "money_mouth_face": "\U0001f911",
    "shrug": "\U0001f937", "man_shrugging": "\U0001f937", "woman_shrugging": "\U0001f937",
    "heart": "❤️", "orange_heart": "\U0001f9e1", "yellow_heart": "\U0001f49b",
    "green_heart": "\U0001f49a", "blue_heart": "\U0001f499", "purple_heart": "\U0001f49c",
    "black_heart": "\U0001f5a4", "broken_heart": "\U0001f494", "two_hearts": "\U0001f495",
    "sparkling_heart": "\U0001f496", "heartpulse": "\U0001f497", "cupid": "\U0001f498",
    "tada": "\U0001f389", "confetti_ball": "\U0001f38a", "sparkles": "✨", "star": "⭐",
    "star2": "\U0001f31f", "dizzy": "\U0001f4ab", "boom": "\U0001f4a5", "fire": "\U0001f525",
    "collision": "\U0001f4a5", "zap": "⚡", "sunny": "☀️", "rainbow": "\U0001f308",
    "cloud": "☁️", "snowflake": "❄️", "droplet": "\U0001f4a7",
    "ok_hand": "\U0001f44c", "pinching_hand": "\U0001f90f", "v": "✌️",
    "crossed_fingers": "\U0001f91e", "love_you_gesture": "\U0001f91f", "metal": "\U0001f918",
    "call_me_hand": "\U0001f919", "point_left": "\U0001f448", "point_right": "\U0001f449",
    "point_up_2": "\U0001f446", "point_down": "\U0001f447", "point_up": "☝️",
    "raised_hand": "✋", "raised_back_of_hand": "\U0001f91a", "wave": "\U0001f44b",
    "raised_hands": "\U0001f64c", "open_hands": "\U0001f450", "handshake": "\U0001f91d",
    "pray": "\U0001f64f", "clap": "\U0001f44f", "muscle": "\U0001f4aa", "eyes": "\U0001f440",
    "eye": "\U0001f441️", "brain": "\U0001f9e0", "white_check_mark": "✅",
    "heavy_check_mark": "✔️", "ballot_box_with_check": "☑️",
    "x": "❌", "negative_squared_cross_mark": "❎", "heavy_plus_sign": "➕",
    "heavy_minus_sign": "➖", "question": "❓", "grey_question": "❔",
    "exclamation": "❗", "warning": "⚠️", "bulb": "\U0001f4a1", "rocket": "\U0001f680",
    "tools": "\U0001f6e0️", "hammer": "\U0001f528", "wrench": "\U0001f527", "gear": "⚙️",
    "lock": "\U0001f512", "unlock": "\U0001f513", "key": "\U0001f511", "bell": "\U0001f514",
    "no_bell": "\U0001f515", "mag": "\U0001f50d", "pushpin": "\U0001f4cc", "paperclip": "\U0001f4ce",
    "memo": "\U0001f4dd", "pencil2": "✏️", "book": "\U0001f4d6", "books": "\U0001f4da",
    "calendar": "\U0001f4c5", "date": "\U0001f4c6", "clock1": "\U0001f550", "hourglass": "⌛",
    "alarm_clock": "⏰", "coffee": "☕", "tea": "\U0001f375", "beer": "\U0001f37a",
    "beers": "\U0001f37b", "wine_glass": "\U0001f377", "champagne": "\U0001f37e",
    "cake": "\U0001f370", "birthday": "\U0001f382", "pizza": "\U0001f355", "hamburger": "\U0001f354",
    "apple": "\U0001f34e", "banana": "\U0001f34c", "eggplant": "\U0001f346",
    "rocket_ship": "\U0001f680", "airplane": "✈️", "car": "\U0001f697",
    "house": "\U0001f3e0", "office": "\U0001f3e2", "computer": "\U0001f4bb", "iphone": "\U0001f4f1",
    "telephone": "☎️", "email": "\U0001f4e7", "envelope": "✉️",
    "package": "\U0001f4e6", "gift": "\U0001f381", "trophy": "\U0001f3c6", "medal": "\U0001f3c5",
    "dart": "\U0001f3af", "game_die": "\U0001f3b2", "musical_note": "\U0001f3b5",
    "headphones": "\U0001f3a7", "camera": "\U0001f4f7", "movie_camera": "\U0001f3a5",
    "tv": "\U0001f4fa", "radio": "\U0001f4fb", "sound": "\U0001f509", "mute": "\U0001f507",
    "dog": "\U0001f436", "cat": "\U0001f431", "mouse": "\U0001f42d", "bear": "\U0001f43b",
    "panda_face": "\U0001f43c", "monkey_face": "\U0001f435", "penguin": "\U0001f427",
    "bird": "\U0001f426", "fish": "\U0001f41f", "whale": "\U0001f433", "turtle": "\U0001f422",
    "bug": "\U0001f41b", "ant": "\U0001f41c", "bee": "\U0001f41d", "snail": "\U0001f40c",
    "seedling": "\U0001f331", "herb": "\U0001f33f", "four_leaf_clover": "\U0001f340",
    "maple_leaf": "\U0001f341", "mushroom": "\U0001f344", "cactus": "\U0001f335",
    "palm_tree": "\U0001f334", "sunflower": "\U0001f33b", "rose": "\U0001f339",
    "bouquet": "\U0001f490", "cherry_blossom": "\U0001f338", "earth_africa": "\U0001f30d",
    "moon": "\U0001f314", "crescent_moon": "\U0001f319", "milky_way": "\U0001f30c",
    "ocean": "\U0001f30a", "umbrella": "☔", "snowman": "⛄", "fire_engine": "\U0001f692",
    "ambulance": "\U0001f691", "construction": "\U0001f6a7", "no_entry": "⛔",
    "recycle": "♻️", "infinity": "♾️", "100": "\U0001f4af", "ok": "\U0001f197",
    "new": "\U0001f195", "top": "\U0001f51d", "cool": "\U0001f192", "free": "\U0001f193",
    "sos": "\U0001f198", "arrow_up": "⬆️", "arrow_down": "⬇️",
    "arrow_left": "⬅️", "arrow_right": "➡️", "arrows_counterclockwise": "\U0001f504",
    "heavy_dollar_sign": "\U0001f4b2", "moneybag": "\U0001f4b0", "chart_with_upwards_trend": "\U0001f4c8",
    "chart_with_downwards_trend": "\U0001f4c9", "bar_chart": "\U0001f4ca", "clipboard": "\U0001f4cb",
    "file_folder": "\U0001f4c1", "open_file_folder": "\U0001f4c2", "page_facing_up": "\U0001f4c4",
    "bookmark": "\U0001f516", "label": "\U0001f3f7️", "flag_fr": "\U0001f1eb\U0001f1f7",
    "tv_happy": "\U0001f4fa", "wastebasket": "\U0001f5d1️", "printer": "\U0001f5a8️",
    "desktop_computer": "\U0001f5a5️", "keyboard": "⌨️", "mag_right": "\U0001f50e",
    "hocho": "\U0001f52a", "pill": "\U0001f48a", "syringe": "\U0001f489", "dna": "\U0001f9ec",
    "microscope": "\U0001f52c", "telescope": "\U0001f52d", "satellite": "\U0001f6f0️",
    "crystal_ball": "\U0001f52e", "joystick": "\U0001f579️", "gem": "\U0001f48e",
    "hot_pepper": "\U0001f336️", "salt": "\U0001f9c2", "honey_pot": "\U0001f36f",
    "poop": "\U0001f4a9", "ghost": "\U0001f47b", "alien": "\U0001f47d", "robot_face": "\U0001f916",
    "jack_o_lantern": "\U0001f383", "christmas_tree": "\U0001f384", "santa": "\U0001f385",
    "snowflake2": "❄️", "balloon": "\U0001f388", "ribbon": "\U0001f380",
    "crown": "\U0001f451", "lipstick": "\U0001f484", "ring": "\U0001f48d", "hibiscus": "\U0001f33a",
}

# How long a download is given, and how many times a refusal is retried. Slack rate-limits an
# export's own URLs, and a migration can pull tens of thousands of files: giving up on the first 429
# would mean an archive missing attachments, which is the one outcome this chain exists to prevent.
DOWNLOAD_TIMEOUT = 120
DOWNLOAD_TRIES = 5

# Exit code for the one failure a person can act on: the export's own links no longer open. Told
# apart from every other failure so the orchestrator around this script can show the way out rather
# than a stack trace.
EXPIRED = 3

# Shown only when the links have actually stopped working. Writing it into the normal path would
# send every customer to read about OAuth scopes for an export that was going to work.
TOKEN_HELP = """
Slack no longer opens this export's file links. They are signed by the export itself and expire
with it (Slack deletes an export ten days after it is downloaded), so a fresh export is the
simplest fix: ask for one in Settings -> Import/Export Data -> Export, and convert it the same day.

To use this export as it is, give the converter a token of your own instead:

  1. Go to https://api.slack.com/apps and select "Create New App", then "From scratch".
     Name it anything (it is never published) and pick the workspace being migrated.
  2. Open "OAuth & Permissions", scroll to "User Token Scopes", and add "files:read".
     That one scope is all this needs: it reads files, and nothing else.
  3. Select "Install to Workspace" at the top of that page and confirm.
  4. Copy the "User OAuth Token" (it starts with xoxp-) into a file, readable only by you:

       umask 077; printf 'xoxp-...' > ~/slack-token

  5. Run this command again with --token-file ~/slack-token. Files already fetched are kept.
  6. Delete the token and the app once the migration is done.
"""


class Expired(Exception):
    """The export's own links no longer open, which no retry will fix."""


def iso(seconds) -> str | None:
    """Slack timestamps are seconds since the epoch, as a float in a string (`ts`) or an int."""
    if seconds in (None, "", 0, "0"):
        return None
    return datetime.fromtimestamp(float(seconds), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def as_emoji(name: str) -> str:
    """The character for a Slack reaction name, or the name spelled as a shortcode.

    Slack appends a skin tone (`+1::skin-tone-3`) and allows custom names an export never defines.
    The tone is dropped rather than approximated, and an unknown name crosses as `:name:`.
    """
    plain = name.split("::")[0]
    if plain in EMOJI:
        return EMOJI[plain]
    return f":{plain}:"


# Slack writes its own markup, and the product stores Markdown. What differs is small and total:
# one asterisk means bold there and italic here, so a message crossing unconverted comes out
# emphasised where it was strong, everywhere, in every imported workspace.
LINK = re.compile(r"<(https?://[^|>]+)(?:\|([^>]*))?>")
MAILTO = re.compile(r"<mailto:([^|>]+)(?:\|([^>]*))?>")
USER = re.compile(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>")
CHANNEL_LINK = re.compile(r"<#(C[A-Z0-9]+)(?:\|([^>]*))?>")
SUBTEAM = re.compile(r"<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>")
BROADCAST = re.compile(r"<!(channel|here|everyone)(?:\|[^>]*)?>")
BOLD = re.compile(r"(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])")
STRIKE = re.compile(r"(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])")


def to_markdown(text: str, channel_names: dict[str, str]) -> str:
    """Slack's mrkdwn as Markdown, with mentions in the archive's own form.

    Mentions are the one thing a producer must not leave in vendor syntax: `<@U123>` means nothing
    on the other side. They cross as `@{U123}`, the source identifier, and the importer resolves it
    to a real account once the accounts are mapped.
    """
    if not text:
        return ""

    out = text
    # Code first, and remembered, so that nothing below rewrites what someone typed inside backticks:
    # a snippet holding `*ptr` is a pointer, not bold.
    fences: list[str] = []

    def keep(match: re.Match) -> str:
        fences.append(match.group(0))
        return f"\x00{len(fences) - 1}\x00"

    out = re.sub(r"```.*?```", keep, out, flags=re.S)
    out = re.sub(r"`[^`\n]+`", keep, out)

    out = USER.sub(lambda m: "@{" + m.group(1) + "}", out)
    # A channel-wide mention keeps its meaning; `@here` does not have one here, since the product
    # has no "the people currently active" notion, so it becomes the closest true thing and is
    # declared in limits.
    out = BROADCAST.sub("@channel", out)
    out = SUBTEAM.sub(lambda m: "@" + (m.group(1) or "group"), out)
    out = CHANNEL_LINK.sub(lambda m: "#" + (m.group(2) or channel_names.get(m.group(1), m.group(1))), out)
    out = LINK.sub(lambda m: f"[{m.group(2)}]({m.group(1)})" if m.group(2) else m.group(1), out)
    out = MAILTO.sub(lambda m: m.group(2) or m.group(1), out)

    out = BOLD.sub(lambda m: f"**{m.group(1)}**", out)
    out = STRIKE.sub(lambda m: f"~~{m.group(1)}~~", out)
    # Slack stores its bullets as the character itself, which Markdown renders as a paragraph.
    out = re.sub(r"^(\s*)•\s+", r"\1- ", out, flags=re.M)
    for index, fence in enumerate(fences):
        out = out.replace(f"\x00{index}\x00", fence)
    # Last, and over the code too: Slack escapes these three wherever they appear, snippets
    # included, so an archive went out holding `buis&lt;vfyifevhfv` where somebody had typed a `<`.
    # After the rewriting above rather than before, so that a `<@U123>` somebody typed as text
    # stays text instead of becoming a mention of a real person.
    return out.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


class Converter:
    def __init__(self, export: Path, out: Path, space_name: str) -> None:
        self.export = export
        self.out = out
        self.space_name = space_name
        self.users: list[dict] = []
        self.bots: set[str] = set()
        self.channels: list[dict] = []
        self.channel_names: dict[str, str] = {}
        self.messages: list[dict] = []
        self.files: dict[str, dict] = {}
        # What could not be carried, in the words of the thing that could not carry it.
        self.limits: list[str] = []
        self.external_files = 0
        self.missing_files: list[str] = []
        self.unknown_emoji: set[str] = set()
        self.dropped_subtypes: set[str] = set()

    # -- reading ---------------------------------------------------------------------------------
    def read(self) -> None:
        self._read_users()
        self._read_channels("channels.json", "channel", "public")
        # A compliance export, which Slack approves per request, adds the private conversations.
        # A standard one carries none of these files, and says so in its limits instead.
        self._read_channels("groups.json", "channel", "private")
        self._read_channels("mpims.json", "direct", "private")
        self._read_channels("dms.json", "direct", "private")
        self._read_messages()

    def _load(self, name: str):
        path = self.export / name
        if not path.exists():
            return None
        with path.open(encoding="utf-8") as fh:
            return json.load(fh)

    def _read_users(self) -> None:
        payload = self._load("users.json")
        if payload is None:
            sys.exit(
                f"{self.export}/users.json not found: point --export at an unpacked Slack export"
            )
        for user in payload:
            profile = user.get("profile") or {}
            if user.get("is_bot") or user.get("id") == "USLACKBOT":
                # Apps are not people. Their posts arrive attributed to an absent author, the way a
                # message from somebody the archive never named does.
                self.bots.add(user["id"])
                continue
            self.users.append(
                {
                    # The Slack identifier, not the handle: messages reference people by it, and a
                    # handle can be taken by somebody else after its owner leaves.
                    "id": user["id"],
                    "email": (profile.get("email") or "").strip(),
                    "display_name": (
                        profile.get("real_name") or profile.get("display_name") or user.get("name") or user["id"]
                    ),
                    "active": not user.get("deleted", False),
                }
            )

    def _read_channels(self, name: str, kind: str, visibility: str) -> None:
        payload = self._load(name)
        if payload is None:
            return
        for channel in payload:
            topic = (channel.get("topic") or {}).get("value") or ""
            purpose = (channel.get("purpose") or {}).get("value") or ""
            title = channel.get("name") or ""
            self.channel_names[channel["id"]] = title
            self.channels.append(
                {
                    "id": channel["id"],
                    "space": "slack",
                    "kind": kind,
                    # A direct conversation is named by who is in it, at the far end.
                    "name": "" if kind == "direct" else title,
                    "topic": topic or purpose,
                    "visibility": visibility,
                    "archived": bool(channel.get("is_archived")),
                    "members": [m for m in (channel.get("members") or []) if m not in self.bots],
                    "member_state": [],
                    "created_at": iso(channel.get("created")),
                }
            )
            # Slack holds the fact of a channel's creation on the channel, not as a message. It is
            # the source's own word, so it crosses: an imported conversation that opens on nothing
            # reads as if it had been cut.
            if channel.get("created") and kind != "direct":
                creator = channel.get("creator")
                self.messages.append(
                    {
                        "id": f"{channel['id']}/created",
                        "channel": channel["id"],
                        "author": creator if creator and creator not in self.bots else None,
                        "sent_at": iso(channel["created"]),
                        "body": "",
                        "system_event": "channel_created",
                    }
                )

    def _day_files(self, channel: dict) -> list[Path]:
        """The day files of one conversation.

        Slack names the directory after the channel handle, not its identifier, and a renamed
        channel carries its current handle. A conversation whose directory is missing is a
        conversation the export listed and did not write: worth saying, not worth inventing.
        """
        title = self.channel_names.get(channel["id"]) or channel["id"]
        directory = self.export / title
        if not directory.is_dir():
            directory = self.export / channel["id"]
        if not directory.is_dir():
            return []
        return sorted(p for p in directory.iterdir() if p.suffix == ".json")

    def _read_messages(self) -> None:
        for channel in self.channels:
            for day in self._day_files(channel):
                with day.open(encoding="utf-8") as fh:
                    payload = json.load(fh)
                for raw in payload:
                    self._read_message(channel, raw)

    def _read_message(self, channel: dict, raw: dict) -> None:
        subtype = raw.get("subtype") or ""
        stamp = raw.get("ts")
        if not stamp:
            return
        identifier = f"{channel['id']}/{stamp}"
        author = raw.get("user")
        if author in self.bots or (author is None and raw.get("bot_id")):
            # An app wrote it. The text is kept, the author is marked absent: attributing it to
            # nobody would lose who spoke, and inventing an account for an app would be worse.
            author = "absent:" + (raw.get("username") or raw.get("bot_id") or "app")
        elif author and author not in {u["id"] for u in self.users}:
            author = "absent:" + author

        if subtype in SYSTEM_EVENTS:
            self.messages.append(
                {
                    "id": identifier,
                    "channel": channel["id"],
                    "author": author,
                    "sent_at": iso(stamp),
                    "body": "",
                    "system_event": SYSTEM_EVENTS[subtype],
                }
            )
            return
        if subtype and subtype not in PLAIN_SUBTYPES:
            self.dropped_subtypes.add(subtype)
            return

        reactions = []
        for reaction in raw.get("reactions") or []:
            people = [u for u in (reaction.get("users") or []) if u not in self.bots]
            if not people:
                # A reaction nobody gave means the producer lost the people, not that nobody
                # reacted. Dropped rather than written as a lie.
                continue
            emoji = as_emoji(reaction.get("name", ""))
            if emoji.startswith(":"):
                self.unknown_emoji.add(emoji.strip(":"))
            reactions.append({"emoji": emoji, "by": people})

        attached = []
        for payload in raw.get("files") or []:
            reference = self._read_file(payload, channel["id"])
            if reference:
                attached.append(reference)

        thread = raw.get("thread_ts")
        body = to_markdown(raw.get("text") or "", self.channel_names)
        if not body and not attached:
            # Nothing a reader would see. Slack writes these for events this archive has no name
            # for; an empty message is not worth a line.
            return

        self.messages.append(
            {
                "id": identifier,
                "channel": channel["id"],
                "author": author,
                "sent_at": iso(stamp),
                "body": body,
                "format": "markdown",
                "thread_root": f"{channel['id']}/{thread}" if thread and thread != stamp else None,
                "pinned": bool(raw.get("pinned_to")),
                "edited_at": iso((raw.get("edited") or {}).get("ts")),
                "reactions": reactions,
                "files": attached,
            }
        )

    def _read_file(self, payload: dict, channel: str) -> str | None:
        """Records a file the export names, without fetching it yet.

        Slack shares one file into several messages by repeating the whole object, so a file is
        recorded once, under the first conversation that showed it.
        """
        identifier = payload.get("id")
        if not identifier:
            return None
        if payload.get("mode") in ("external", "tombstone") or payload.get("is_external"):
            # A link to Google Drive or a file somebody deleted: there are no bytes to fetch.
            self.external_files += 1
            return None
        if identifier in self.files:
            return identifier
        name = payload.get("name") or payload.get("title") or identifier
        owner = payload.get("user")
        self.files[identifier] = {
            "id": identifier,
            "name": name,
            "size": int(payload.get("size") or 0),
            "content_type": payload.get("mimetype") or mimetypes.guess_type(name)[0] or "application/octet-stream",
            "hash": "",  # filled in once the bytes are here
            "channel": channel,
            "uploaded_by": owner if owner and owner not in self.bots else None,
            "uploaded_at": iso(payload.get("created") or payload.get("timestamp")),
            # Not part of the archive: dropped before writing.
            "_url": payload.get("url_private_download") or payload.get("url_private"),
        }
        return identifier

    # -- the bytes -------------------------------------------------------------------------------
    def fetch_files(self, token: str | None) -> None:
        """Downloads what the export only linked to.

        The export signs its own URLs, so this works with no credentials at all, which is the whole
        point: the ordinary migration never hears the word token. When the signature has expired
        the download cannot be retried into working, so the first such refusal stops the conversion
        and says what to do, rather than spending an hour to hand over an archive with no files in
        it. A fetch that fails for any other reason (one file withdrawn, one link broken) is
        recorded and the rest carries on.
        """
        blobs = self.out / "blobs"
        total = len(self.files)
        fetched = 0
        for index, record in enumerate(list(self.files.values()), start=1):
            url = record.pop("_url", None)
            if not url:
                self.missing_files.append(record["name"])
                continue
            print(f"  file {index}/{total}: {record['name'][:60]}", flush=True)
            try:
                data = self._download(url, token)
            except Expired as error:
                # Not this file's problem: the export as a whole is past its date.
                print(f"\n{error}\n{TOKEN_HELP}", file=sys.stderr)
                print(
                    f"stopped after {fetched} of {total} files: "
                    f"rerun with --token-file to finish, or --no-files to go without them",
                    file=sys.stderr,
                )
                raise SystemExit(EXPIRED)
            except Exception as error:  # noqa: BLE001 - the reason is reported, whatever it is
                self.missing_files.append(f"{record['name']} ({error})")
                del self.files[record["id"]]
                continue
            if record["size"] and len(data) != record["size"]:
                self.missing_files.append(
                    f"{record['name']} (expected {record['size']} bytes, got {len(data)})"
                )
                del self.files[record["id"]]
                continue
            checksum = hashlib.sha256(data).hexdigest()
            destination = blobs / checksum[:2] / checksum
            if not destination.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            record["hash"] = f"sha256:{checksum}"
            record["size"] = len(data)
            fetched += 1

    def _download(self, url: str, token: str | None) -> bytes:
        last: Exception | None = None
        for attempt in range(DOWNLOAD_TRIES):
            request = urllib.request.Request(url)
            if token:
                request.add_header("Authorization", f"Bearer {token}")
            try:
                with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response:
                    body = response.read()
                if body.startswith(b"<!DOCTYPE html") or body.startswith(b"<html"):
                    # Slack answers an expired link with its sign-in page rather than a status: a
                    # file that silently became an HTML page is the worst outcome here.
                    raise Expired("Slack returned its sign-in page instead of the file")
                return body
            except urllib.error.HTTPError as error:
                last = error
                if error.code in (429, 500, 502, 503, 504):
                    time.sleep(2**attempt)
                    continue
                if error.code in (401, 403):
                    raise Expired(f"Slack refused the link ({error.code})") from error
                raise
            except urllib.error.URLError as error:
                last = error
                time.sleep(2**attempt)
        raise RuntimeError(str(last))

    # -- writing ---------------------------------------------------------------------------------
    def write(self, fetched: bool) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        self._declare(fetched)

        self._write_jsonl(
            "spaces.jsonl",
            [{"id": "slack", "name": self.space_name, "description": "", "visibility": "private"}],
        )
        self._write_jsonl("users.jsonl", self.users)
        self._write_jsonl("channels.jsonl", self.channels)
        known = set(self.files)
        for message in self.messages:
            if "files" in message:
                message["files"] = [f for f in message["files"] if f in known]
        self._write_jsonl("messages.jsonl", sorted(self.messages, key=lambda m: (m["channel"], m["sent_at"] or "")))
        for record in self.files.values():
            record.pop("_url", None)
        self._write_jsonl("files.jsonl", list(self.files.values()))

        manifest = {
            "format_version": FORMAT_VERSION,
            "source": "slack",
            "source_version": "export format 2",
            "producer": PRODUCER,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "counts": {
                "spaces": 1,
                "users": len(self.users),
                "channels": len(self.channels),
                "messages": len(self.messages),
                "files": len(self.files),
            },
            "checksums": {},
            "limits": self.limits,
        }
        (self.out / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _declare(self, fetched: bool) -> None:
        """What did not cross, said before anybody discovers it.

        A summary of a loss is another way of hiding it, so each of these names one thing and says
        what happens to it.
        """
        if not (self.export / "groups.json").exists() and not (self.export / "dms.json").exists():
            self.limits.append(
                "A standard Slack export carries public channels only: private channels and direct "
                "messages are absent from it, and nothing in this archive replaces them. They need "
                "a compliance export, which Slack approves per request."
            )
        self.limits.append(
            "Slack does not export its edit and delete logs: a message crosses with its current "
            "text, and a deleted message is absent from the export."
        )
        if not fetched:
            self.limits.append(
                "Attachments were not fetched: a Slack export carries links to its files, not the "
                "files, and this conversion was asked to skip them."
            )
        if self.missing_files:
            self.limits.append(
                "Files the export named and this conversion could not fetch, so they are absent "
                "from this archive: " + ", ".join(self.missing_files[:20])
            )
        if self.external_files:
            self.limits.append(
                f"{self.external_files} attachment(s) live outside Slack (a Drive link, or a file "
                "since deleted): the export holds a reference, not the bytes, so they do not cross."
            )
        self.limits.append(
            "Slack's @here means the people currently active, which has no equivalent here: it "
            "crosses as @channel."
        )
        self.limits.append(
            "User groups cross as plain text: a group is not an account and has nothing to resolve "
            "to on the other side."
        )
        if self.dropped_subtypes:
            self.limits.append(
                "Slack notices with no equivalent here are dropped rather than phrased in Slack's "
                "words: " + ", ".join(sorted(self.dropped_subtypes)) + "."
            )
        if self.unknown_emoji:
            self.limits.append(
                "Reactions using an emoji this converter could not name cross as :shortcode:, "
                "including custom emoji, which an export does not carry: "
                + ", ".join(sorted(self.unknown_emoji)[:20])
            )
        self.limits.append(
            "Nobody arrives with saved messages, favourite channels or a reading position: a Slack "
            "export carries none of the three."
        )
        self.limits.append(
            "Huddles, canvases, lists, workflows and app activity are not imported."
        )

    def _write_jsonl(self, name: str, rows) -> None:
        with (self.out / name).open("w", encoding="utf-8") as sink:
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", required=True, type=Path, help="unpacked Slack export")
    parser.add_argument("--out", required=True, type=Path, help="archive directory to write")
    parser.add_argument("--space-name", default="Slack", help="name of the space the workspace lands in")
    parser.add_argument(
        "--no-files",
        action="store_true",
        help="do not download the attachments (they are declared as missing in the manifest)",
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        help="file holding a Slack user token with files:read. Only needed once the export's own "
        "links have expired, and the converter says so when that happens. Read from a file, never "
        "an argument, so it stays out of the shell history.",
    )
    args = parser.parse_args()

    token = None
    if args.token_file:
        token = args.token_file.read_text(encoding="utf-8").strip()

    converter = Converter(args.export, args.out, args.space_name)
    converter.read()
    if args.no_files:
        converter.files.clear()
    else:
        converter.fetch_files(token)
    converter.write(fetched=not args.no_files)

    counts = (
        f"  1 space, {len(converter.users)} accounts, {len(converter.channels)} conversations, "
        f"{len(converter.messages)} messages, {len(converter.files)} files"
    )
    print(f"done: {args.out}")
    print(counts)
    if converter.missing_files:
        print(f"  {len(converter.missing_files)} file(s) could not be fetched, see the manifest")
    print(f"  read {args.out}/manifest.json for what was deliberately left behind")
    print("  the archive is in clear: seal it before it goes anywhere (see docs/import-archive.md)")


if __name__ == "__main__":
    main()
