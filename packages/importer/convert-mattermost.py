#!/usr/bin/env python3
"""Turns a Mattermost bulk export into a Ruchoir import archive.

Mattermost, unlike Nextcloud, has an export of its own: an administrator runs `mmctl export create`
and gets a ZIP holding `import.jsonl` plus an attachment tree. This adapter reads that and writes
the archive described in docs/import-archive.md, so the importer never learns Mattermost's shape.

It runs on the Ruchoir host, on an export the customer hands over. It only reads its input.

    convert-mattermost.py --export <unpacked export dir> --out <archive dir>

What the bulk export actually contains was established by running one, not by reading the
documentation, and two common beliefs turned out to be wrong: private channels and direct messages
DO come out. What does not come out is in the manifest's `limits`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

FORMAT_VERSION = 1
PRODUCER = "ruchoir-convert-mattermost 0.1.0"

# Mattermost narrates events as posts with a `type`. Only the ones with an equivalent here cross,
# and they cross as an event name: the sentence stays ours, in the reader's language. The rest
# (purpose and header changes, channel renames, team removals) is dropped and declared.
SYSTEM_EVENTS = {
    "system_join_channel": "channel_joined",
    "system_add_to_channel": "channel_joined",
    "system_leave_channel": "channel_left",
    "system_remove_from_channel": "channel_left",
    "system_join_team": "member_joined",
    "system_leave_team": "member_left",
}


def iso(ms: int | None) -> str | None:
    """Mattermost timestamps are milliseconds since the epoch; 0 means unset."""
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class Converter:
    def __init__(self, export: Path, out: Path) -> None:
        self.export = export
        self.out = out
        self.spaces: dict[str, dict] = {}
        self.users: dict[str, dict] = {}
        self.channels: dict[str, dict] = {}
        self.messages: list[dict] = []
        self.files: dict[str, dict] = {}
        # Which spaces each account belongs to, so a direct conversation can be placed in one.
        self.user_spaces: dict[str, list[str]] = defaultdict(list)
        self.dropped_system: set[str] = set()
        self.source_version = "unknown"

    # -- reading ---------------------------------------------------------------------------
    def read(self) -> None:
        source = self.export / "import.jsonl"
        if not source.is_file():
            sys.exit(f"{source} not found: point --export at an unpacked Mattermost bulk export")

        with source.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                kind = row.get("type")
                handler = getattr(self, f"_read_{kind}", None)
                if handler:
                    handler(row[kind])

        self._place_direct_conversations()

    def _read_version(self, payload) -> None:
        if isinstance(payload, dict):
            self.source_version = str(payload.get("version", "unknown"))
        else:
            self.source_version = str(payload)

    def _read_team(self, team: dict) -> None:
        self.spaces[team["name"]] = {
            "id": team["name"],
            "name": team.get("display_name") or team["name"],
            "description": team.get("description", ""),
            # 'O' lets anyone in the instance join, 'I' is invitation only.
            "visibility": "public" if team.get("type") == "O" else "private",
        }

    def _read_user(self, user: dict) -> None:
        username = user["username"]
        name = " ".join(p for p in (user.get("first_name"), user.get("last_name")) if p)
        self.users[username] = {
            "id": username,
            "email": user.get("email", ""),
            "display_name": name or username,
            "active": not user.get("delete_at"),
        }
        # Membership lives on the account, not on the channel: this is where a channel's roster
        # comes from, and where we learn which spaces someone belongs to.
        for team in user.get("teams") or []:
            self.user_spaces[username].append(team["name"])
            for channel in team.get("channels") or []:
                key = f"{team['name']}/{channel['name']}"
                self.channels.setdefault(key, {"members": []})
                self.channels[key]["members"].append(username)

    def _read_channel(self, channel: dict) -> None:
        key = f"{channel['team']}/{channel['name']}"
        entry = self.channels.setdefault(key, {"members": []})
        entry.update(
            {
                "id": key,
                "space": channel["team"],
                "kind": "channel",
                "name": channel.get("display_name") or channel["name"],
                # Mattermost splits what we keep as one topic: purpose says what the channel is
                # for, header is a pinned line of text. Purpose first, header as a fallback.
                "topic": channel.get("purpose") or channel.get("header") or "",
                "visibility": "public" if channel.get("type") == "O" else "private",
                "archived": bool(channel.get("deleted_at")),
                "created_at": None,
            }
        )

    def _read_direct_channel(self, channel: dict) -> None:
        members = sorted(p["username"] for p in channel.get("participants") or [])
        key = "direct:" + "+".join(members)
        self.channels[key] = {
            "id": key,
            "space": None,  # decided once every account's spaces are known
            "kind": "direct",
            "name": "",
            "topic": channel.get("header", ""),
            "visibility": "private",
            "archived": False,
            "members": members,
            "created_at": None,
        }

    def _read_post(self, post: dict) -> None:
        key = f"{post['team']}/{post['channel']}"
        self._add_post(post, key)

    def _read_direct_post(self, post: dict) -> None:
        members = sorted(post.get("channel_members") or [])
        self._add_post(post, "direct:" + "+".join(members))

    # -- messages --------------------------------------------------------------------------
    def _message_id(self, channel: str, post: dict) -> str:
        """A bulk export carries no post id, so one is built from what it does spell.

        Deterministic is the whole requirement: the same export has to yield the same identifier
        twice, or replaying an archive duplicates every message instead of recognising it.
        """
        seed = f"{channel}|{post.get('create_at')}|{post.get('user')}|{post.get('message', '')}"
        return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]

    def _add_post(self, post: dict, channel: str, root: str | None = None) -> None:
        post_type = post.get("type") or ""
        if post_type:
            event = SYSTEM_EVENTS.get(post_type)
            if not event:
                self.dropped_system.add(post_type)
                return
            # A notice is about someone rather than written by them: an arrival carries the person
            # who arrived, not the administrator who added them.
            props = post.get("props") or {}
            about = props.get("addedUsername") or props.get("username") or post.get("user")
            self.messages.append(
                {
                    "id": self._message_id(channel, post),
                    "channel": channel,
                    "author": about,
                    "sent_at": iso(post.get("create_at")),
                    "body": "",
                    "format": "markdown",
                    "system_event": event,
                    "thread_root": None,
                    "pinned": False,
                    "edited_at": None,
                    "reactions": [],
                    "files": [],
                }
            )
            return

        message_id = self._message_id(channel, post)
        by_emoji: dict[str, list[str]] = defaultdict(list)
        for reaction in post.get("reactions") or []:
            by_emoji[reaction["emoji_name"]].append(reaction["user"])

        self.messages.append(
            {
                "id": message_id,
                "channel": channel,
                "author": post.get("user"),
                "sent_at": iso(post.get("create_at")),
                "body": post.get("message", ""),
                "format": "markdown",
                "thread_root": root,
                "pinned": bool(post.get("is_pinned")),
                "edited_at": iso(post.get("edit_at")),
                "reactions": [{"emoji": e, "by": sorted(u)} for e, u in sorted(by_emoji.items())],
                "files": [
                    self._add_attachment(a, post) for a in (post.get("attachments") or [])
                ],
            }
        )

        # Mattermost nests a thread inside its root post; we carry it flat, every reply pointing
        # at the root, which is the shape every other source produces too.
        for reply in post.get("replies") or []:
            reply.setdefault("channel", post.get("channel"))
            reply.setdefault("team", post.get("team"))
            self._add_post(reply, channel, root=message_id)

    # -- files -----------------------------------------------------------------------------
    def _add_attachment(self, attachment: dict, post: dict) -> str:
        relative = attachment["path"]
        source = self.export / "data" / relative
        if not source.is_file():
            sys.exit(f"the export references {relative}, which is not in it")

        checksum = digest(source)
        blob = self.out / "blobs" / checksum[:2] / checksum
        if not blob.exists():
            blob.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, blob)

        name = Path(relative).name
        self.files[relative] = {
            "id": relative,
            "name": name,
            "path": name,
            "size": source.stat().st_size,
            "content_type": mimetypes.guess_type(name)[0] or "application/octet-stream",
            "hash": f"sha256:{checksum}",
            "channel": None,
            # The export says nothing about a file on its own; who posted it and when is the only
            # provenance available, and it is the provenance that matters.
            "uploaded_by": post.get("user"),
            "uploaded_at": iso(post.get("create_at")),
        }
        return relative

    # -- placing direct conversations --------------------------------------------------------
    def _place_direct_conversations(self) -> None:
        """A direct conversation has no team in Mattermost, but every conversation here lives in a
        space. It goes to a space its participants share, the first in alphabetical order when
        they share several, and that choice is declared in the manifest."""
        fallback = sorted(self.spaces)[0] if self.spaces else None
        for channel in self.channels.values():
            if channel.get("kind") != "direct":
                continue
            shared: set[str] | None = None
            for member in channel["members"]:
                spaces = set(self.user_spaces.get(member, []))
                shared = spaces if shared is None else (shared & spaces)
            channel["space"] = sorted(shared)[0] if shared else fallback

    # -- writing ---------------------------------------------------------------------------
    def write(self) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "blobs").mkdir(exist_ok=True)

        channels = [c for c in self.channels.values() if c.get("id")]
        self._write_jsonl("spaces.jsonl", self.spaces.values())
        self._write_jsonl("users.jsonl", self.users.values())
        self._write_jsonl("channels.jsonl", channels)
        self._write_jsonl("messages.jsonl", self.messages)
        self._write_jsonl("files.jsonl", self.files.values())

        limits = [
            "Archived channels are absent from a Mattermost bulk export: what was archived there does not arrive here at all.",
            "Deleted messages are absent from the export.",
            "A bulk export carries no post identifier, so each message is identified by a digest of its channel, author, time and text. Two identical messages sent in the same millisecond by the same person would collapse into one.",
            "Direct conversations carry no team in Mattermost: each one is placed in a space its participants share, the first alphabetically when they share several.",
            "Only Mattermost notices with an equivalent here cross (joining or leaving a channel or a team). Purpose, header and rename notices are dropped.",
            "Saved messages (flagged posts) are not carried over.",
            "Channel notification preferences, favourites and read positions are not carried over.",
            "Bots are not imported as accounts: their posts arrive attributed to an absent author.",
        ]
        if self.dropped_system:
            limits.append(
                "Notices dropped in this export: " + ", ".join(sorted(self.dropped_system)) + "."
            )

        manifest = {
            "format_version": FORMAT_VERSION,
            "source": "mattermost",
            "source_version": self.source_version,
            "producer": PRODUCER,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "counts": {
                "spaces": len(self.spaces),
                "users": len(self.users),
                "channels": len(channels),
                "messages": len(self.messages),
                "files": len(self.files),
            },
            "checksums": {
                name: "sha256:" + digest(self.out / name)
                for name in ("spaces.jsonl", "users.jsonl", "channels.jsonl", "messages.jsonl", "files.jsonl")
            },
            "limits": limits,
        }
        (self.out / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    def _write_jsonl(self, name: str, rows) -> None:
        with (self.out / name).open("w", encoding="utf-8") as sink:
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", required=True, type=Path, help="unpacked Mattermost bulk export")
    parser.add_argument("--out", required=True, type=Path, help="archive directory to write")
    args = parser.parse_args()

    converter = Converter(args.export, args.out)
    converter.read()
    converter.write()

    counts = json.loads((args.out / "manifest.json").read_text(encoding="utf-8"))["counts"]
    print(f"done: {args.out}")
    print(
        "  {spaces} spaces, {users} accounts, {channels} conversations, "
        "{messages} messages, {files} files".format(**counts)
    )
    print(f"  read {args.out}/manifest.json for what was deliberately left behind")
    print("  the archive is in clear: seal it before it goes anywhere (see docs/import-archive.md)")


if __name__ == "__main__":
    main()
