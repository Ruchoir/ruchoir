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


# Mattermost names its reactions rather than storing the character, so the names have to be turned
# back into emoji here: the product stores native Unicode, and an untranslated name arrives as the
# word `tada` sitting under a message where a face should be. This is the producer's job because
# the producer is the only thing that knows its source's vocabulary.
#
# The common set, not the whole of it. A name missing from here is not dropped: it crosses as
# `:name:`, which the archive contract allows, and the export says so in its limits so that nobody
# discovers it a week later.
EMOJI = {
    "+1": "\U0001f44d", "thumbsup": "\U0001f44d", "-1": "\U0001f44e", "thumbsdown": "\U0001f44e",
    "smile": "\U0001f604", "smiley": "\U0001f603", "grinning": "\U0001f600", "grin": "\U0001f601",
    "laughing": "\U0001f606", "satisfied": "\U0001f606", "sweat_smile": "\U0001f605",
    "joy": "\U0001f602", "rofl": "\U0001f923", "slightly_smiling_face": "\U0001f642",
    "upside_down_face": "\U0001f643", "wink": "\U0001f609", "blush": "\U0001f60a",
    "innocent": "\U0001f607", "heart_eyes": "\U0001f60d", "kissing_heart": "\U0001f618",
    "yum": "\U0001f60b", "stuck_out_tongue": "\U0001f61b", "stuck_out_tongue_winking_eye": "\U0001f61c",
    "zany_face": "\U0001f92a", "raised_eyebrow": "\U0001f928", "neutral_face": "\U0001f610",
    "expressionless": "\U0001f611", "no_mouth": "\U0001f636", "smirk": "\U0001f60f",
    "unamused": "\U0001f612", "roll_eyes": "\U0001f644", "grimacing": "\U0001f62c",
    "lying_face": "\U0001f925", "relieved": "\U0001f60c", "pensive": "\U0001f614",
    "sleepy": "\U0001f62a", "sleeping": "\U0001f634", "mask": "\U0001f637",
    "face_with_thermometer": "\U0001f912", "nauseated_face": "\U0001f922", "sneezing_face": "\U0001f927",
    "hot_face": "\U0001f975", "cold_face": "\U0001f976", "woozy_face": "\U0001f974",
    "dizzy_face": "\U0001f635", "exploding_head": "\U0001f92f", "cowboy_hat_face": "\U0001f920",
    "partying_face": "\U0001f973", "sunglasses": "\U0001f60e", "nerd_face": "\U0001f913",
    "monocle_face": "\U0001f9d0", "confused": "\U0001f615", "worried": "\U0001f61f",
    "slightly_frowning_face": "\U0001f641", "frowning_face": "\u2639\ufe0f", "open_mouth": "\U0001f62e",
    "hushed": "\U0001f62f", "astonished": "\U0001f632", "flushed": "\U0001f633",
    "pleading_face": "\U0001f97a", "frowning": "\U0001f626", "anguished": "\U0001f627",
    "fearful": "\U0001f628", "cold_sweat": "\U0001f630", "disappointed_relieved": "\U0001f625",
    "cry": "\U0001f622", "sob": "\U0001f62d", "scream": "\U0001f631", "confounded": "\U0001f616",
    "persevere": "\U0001f623", "disappointed": "\U0001f61e", "sweat": "\U0001f613",
    "weary": "\U0001f629", "tired_face": "\U0001f62b", "triumph": "\U0001f624",
    "rage": "\U0001f621", "angry": "\U0001f620", "exploding": "\U0001f92f",
    "thinking_face": "\U0001f914", "thinking": "\U0001f914", "shushing_face": "\U0001f92b",
    "zipper_mouth_face": "\U0001f910", "hugs": "\U0001f917", "star_struck": "\U0001f929",
    "face_with_monocle": "\U0001f9d0", "money_mouth_face": "\U0001f911", "shrug": "\U0001f937",
    "man_shrugging": "\U0001f937", "woman_shrugging": "\U0001f937",
    "heart": "\u2764\ufe0f", "orange_heart": "\U0001f9e1", "yellow_heart": "\U0001f49b",
    "green_heart": "\U0001f49a", "blue_heart": "\U0001f499", "purple_heart": "\U0001f49c",
    "black_heart": "\U0001f5a4", "broken_heart": "\U0001f494", "two_hearts": "\U0001f495",
    "sparkling_heart": "\U0001f496", "heartpulse": "\U0001f497", "cupid": "\U0001f498",
    "tada": "\U0001f389", "confetti_ball": "\U0001f38a", "sparkles": "\u2728", "star": "\u2b50",
    "star2": "\U0001f31f", "dizzy": "\U0001f4ab", "boom": "\U0001f4a5", "fire": "\U0001f525",
    "collision": "\U0001f4a5", "zap": "\u26a1", "sunny": "\u2600\ufe0f", "rainbow": "\U0001f308",
    "cloud": "\u2601\ufe0f", "snowflake": "\u2744\ufe0f", "droplet": "\U0001f4a7",
    "ok_hand": "\U0001f44c", "pinching_hand": "\U0001f90f", "v": "\u270c\ufe0f",
    "crossed_fingers": "\U0001f91e", "love_you_gesture": "\U0001f91f", "metal": "\U0001f918",
    "call_me_hand": "\U0001f919", "point_left": "\U0001f448", "point_right": "\U0001f449",
    "point_up_2": "\U0001f446", "point_down": "\U0001f447", "point_up": "\u261d\ufe0f",
    "raised_hand": "\u270b", "raised_back_of_hand": "\U0001f91a", "wave": "\U0001f44b",
    "call_me": "\U0001f919", "muscle": "\U0001f4aa", "pray": "\U0001f64f",
    "handshake": "\U0001f91d", "clap": "\U0001f44f", "raised_hands": "\U0001f64c",
    "open_hands": "\U0001f450", "writing_hand": "\u270d\ufe0f", "nail_care": "\U0001f485",
    "eyes": "\U0001f440", "eye": "\U0001f441\ufe0f", "brain": "\U0001f9e0", "ear": "\U0001f442",
    "white_check_mark": "\u2705", "heavy_check_mark": "\u2714\ufe0f", "ballot_box_with_check": "\u2611\ufe0f",
    "x": "\u274c", "negative_squared_cross_mark": "\u274e", "heavy_multiplication_x": "\u2716\ufe0f",
    "warning": "\u26a0\ufe0f", "no_entry": "\u26d4", "no_entry_sign": "\U0001f6ab",
    "question": "\u2753", "grey_question": "\u2754", "exclamation": "\u2757",
    "bangbang": "\u203c\ufe0f", "interrobang": "\u2049\ufe0f", "100": "\U0001f4af",
    "ok": "\U0001f197", "new": "\U0001f195", "top": "\U0001f51d", "soon": "\U0001f51c",
    "arrow_up": "\u2b06\ufe0f", "arrow_down": "\u2b07\ufe0f", "arrow_left": "\u2b05\ufe0f",
    "arrow_right": "\u27a1\ufe0f", "recycle": "\u267b\ufe0f", "repeat": "\U0001f501",
    "rocket": "\U0001f680", "airplane": "\u2708\ufe0f", "car": "\U0001f697", "bike": "\U0001f6b2",
    "anchor": "\u2693", "construction": "\U0001f6a7", "hammer": "\U0001f528", "wrench": "\U0001f527",
    "gear": "\u2699\ufe0f", "nut_and_bolt": "\U0001f529", "hammer_and_wrench": "\U0001f6e0\ufe0f",
    "bug": "\U0001f41b", "spider": "\U0001f577\ufe0f", "snail": "\U0001f40c", "turtle": "\U0001f422",
    "rabbit": "\U0001f430", "cat": "\U0001f431", "dog": "\U0001f436", "fox_face": "\U0001f98a",
    "bear": "\U0001f43b", "panda_face": "\U0001f43c", "penguin": "\U0001f427", "owl": "\U0001f989",
    "unicorn": "\U0001f984", "whale": "\U0001f433", "dolphin": "\U0001f42c", "fish": "\U0001f41f",
    "coffee": "\u2615", "tea": "\U0001f375", "beer": "\U0001f37a", "beers": "\U0001f37b",
    "champagne": "\U0001f37e", "clinking_glasses": "\U0001f942", "wine_glass": "\U0001f377",
    "cake": "\U0001f370", "birthday": "\U0001f382", "pizza": "\U0001f355", "hamburger": "\U0001f354",
    "fries": "\U0001f35f", "bread": "\U0001f35e", "cheese": "\U0001f9c0", "croissant": "\U0001f950",
    "apple": "\U0001f34e", "banana": "\U0001f34c", "strawberry": "\U0001f353", "watermelon": "\U0001f349",
    "bulb": "\U0001f4a1", "moneybag": "\U0001f4b0", "dollar": "\U0001f4b5", "euro": "\U0001f4b6",
    "chart_with_upwards_trend": "\U0001f4c8", "chart_with_downwards_trend": "\U0001f4c9",
    "bar_chart": "\U0001f4ca", "clipboard": "\U0001f4cb", "pushpin": "\U0001f4cc",
    "paperclip": "\U0001f4ce", "lock": "\U0001f512", "unlock": "\U0001f513", "key": "\U0001f511",
    "mag": "\U0001f50d", "bell": "\U0001f514", "no_bell": "\U0001f515", "loudspeaker": "\U0001f4e2",
    "mega": "\U0001f4e3", "envelope": "\u2709\ufe0f", "email": "\U0001f4e7", "inbox_tray": "\U0001f4e5",
    "outbox_tray": "\U0001f4e4", "package": "\U0001f4e6", "calendar": "\U0001f4c5",
    "date": "\U0001f4c6", "alarm_clock": "\u23f0", "hourglass": "\u231b", "watch": "\u231a",
    "computer": "\U0001f4bb", "desktop_computer": "\U0001f5a5\ufe0f", "iphone": "\U0001f4f1",
    "floppy_disk": "\U0001f4be", "cd": "\U0001f4bf", "battery": "\U0001f50b", "electric_plug": "\U0001f50c",
    "books": "\U0001f4da", "book": "\U0001f4d6", "memo": "\U0001f4dd", "pencil2": "\u270f\ufe0f",
    "page_facing_up": "\U0001f4c4", "file_folder": "\U0001f4c1", "open_file_folder": "\U0001f4c2",
    "trophy": "\U0001f3c6", "medal_sports": "\U0001f3c5", "1st_place_medal": "\U0001f947",
    "dart": "\U0001f3af", "game_die": "\U0001f3b2", "musical_note": "\U0001f3b5", "notes": "\U0001f3b6",
    "art": "\U0001f3a8", "clapper": "\U0001f3ac", "microphone": "\U0001f3a4", "headphones": "\U0001f3a7",
    "house": "\U0001f3e0", "office": "\U0001f3e2", "hospital": "\U0001f3e5", "school": "\U0001f3eb",
    "earth_africa": "\U0001f30d", "earth_americas": "\U0001f30e", "earth_asia": "\U0001f30f",
    "globe_with_meridians": "\U0001f310", "world_map": "\U0001f5fa\ufe0f", "compass": "\U0001f9ed",
    "ghost": "\U0001f47b", "alien": "\U0001f47d", "robot": "\U0001f916", "skull": "\U0001f480",
    "poop": "\U0001f4a9", "hankey": "\U0001f4a9", "smiling_imp": "\U0001f608", "imp": "\U0001f47f",
    "crown": "\U0001f451", "gem": "\U0001f48e", "ring": "\U0001f48d", "gift": "\U0001f381",
    "balloon": "\U0001f388", "christmas_tree": "\U0001f384", "jack_o_lantern": "\U0001f383",
    "sos": "\U0001f198", "vs": "\U0001f19a", "free": "\U0001f193", "cool": "\U0001f192",
    "seedling": "\U0001f331", "herb": "\U0001f33f", "four_leaf_clover": "\U0001f340",
    "maple_leaf": "\U0001f341", "cherry_blossom": "\U0001f338", "rose": "\U0001f339",
    "sunflower": "\U0001f33b", "bouquet": "\U0001f490", "cactus": "\U0001f335", "palm_tree": "\U0001f334",
    "mountain": "\u26f0\ufe0f", "volcano": "\U0001f30b", "ocean": "\U0001f30a", "tent": "\u26fa",
    "flag_fr": "\U0001f1eb\U0001f1f7", "fr": "\U0001f1eb\U0001f1f7",
    "eu": "\U0001f1ea\U0001f1fa", "flag_eu": "\U0001f1ea\U0001f1fa",
}


def as_emoji(name: str) -> str:
    """The character for a Mattermost reaction name, or the name spelled as a shortcode.

    A skin tone suffix is dropped rather than guessed at: `+1_dark_skin_tone` is a thumb up, and
    which thumb it was is not worth a second table.
    """
    plain = name.strip().strip(":")
    if plain in EMOJI:
        return EMOJI[plain]
    for suffix in ("_dark_skin_tone", "_medium_dark_skin_tone", "_medium_skin_tone",
                   "_medium_light_skin_tone", "_light_skin_tone"):
        if plain.endswith(suffix) and plain[: -len(suffix)] in EMOJI:
            return EMOJI[plain[: -len(suffix)]]
    return f":{plain}:"


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
        # What each person kept, per conversation: a favourite, a reading position.
        self.member_state: dict[str, list[dict]] = defaultdict(list)
        self.dropped_system: set[str] = set()
        self.untranslated_emoji: set[str] = set()
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
        # The export states the version of its own format, not of the Mattermost that produced it,
        # which the bulk export never says. Labelled for what it is rather than left as a bare
        # number that reads like a product version.
        version = payload.get("version", "?") if isinstance(payload, dict) else payload
        self.source_version = f"bulk export format {version}"

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
                self._remember_state(key, username, channel)

    def _remember_state(self, channel_key: str, username: str, membership: dict) -> None:
        """A favourite and a reading position belong to a person, not to the conversation.

        Only people who have something to say about a channel get an entry: a roster of six with
        one favourite is one line here, not six.
        """
        state: dict = {}
        if membership.get("favorite"):
            state["favorite"] = True
        # Mattermost knows a moment, not a message. The importer turns it into the last message
        # sent at or before it, which is the closest true statement a timestamp allows.
        read_at = iso(membership.get("last_viewed_at"))
        if read_at:
            state["read_at"] = read_at
        if state:
            self.member_state[channel_key].append({"user": username, **state})

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
        for participant in channel.get("participants") or []:
            self._remember_state(key, participant["username"], participant)
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
        # Mattermost names its reactions; the product stores the character. Two names can map to
        # the same character (`+1` and `thumbsup`), so the grouping happens after translation or
        # the same face would appear twice under one message.
        by_emoji: dict[str, list[str]] = defaultdict(list)
        for reaction in post.get("reactions") or []:
            emoji = as_emoji(reaction["emoji_name"])
            if emoji.startswith(":"):
                self.untranslated_emoji.add(reaction["emoji_name"])
            by_emoji[emoji].append(reaction["user"])

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
                # Who had kept this message. Small, personal, and the sort of thing a migrating
                # team notices missing on the first morning.
                "saved_by": sorted(post.get("flagged_by") or []),
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
        for channel in channels:
            state = self.member_state.get(channel["id"])
            if state:
                channel["member_state"] = sorted(state, key=lambda e: e["user"])
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
            "Channel notification preferences are not carried over: what someone chose to be notified about in another product is not worth moving.",
            "Bots are not imported as accounts: their posts arrive attributed to an absent author.",
        ]
        if self.dropped_system:
            limits.append(
                "Notices dropped in this export: " + ", ".join(sorted(self.dropped_system)) + "."
            )
        if self.untranslated_emoji:
            limits.append(
                "These reaction names have no emoji here and arrive as text: "
                + ", ".join(f":{name}:" for name in sorted(self.untranslated_emoji))
                + "."
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
