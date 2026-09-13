"""What the Mattermost adapter must get right, one behaviour at a time.

Every case here is either something the real export taught us (threads nested inside their root,
membership written on the account, notices as typed posts) or something that would silently lose
data if it broke. The last test runs the contract checker over the output, so the adapter cannot
produce an archive the importer would refuse.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from helpers import add_attachment, by_id, load, read_jsonl, write_export

converter = load("convert-mattermost.py")
validator = load("validate-archive.py")

MS = 1789301261000  # a fixed instant, so the tests do not depend on the clock


def user(name: str, teams=("atelier",), channels=(), **extra) -> dict:
    return {
        "type": "user",
        "user": {
            "username": name,
            "email": f"{name}@seed.local",
            "first_name": name.capitalize(),
            "last_name": "Seed",
            "delete_at": 0,
            "teams": [
                {"name": team, "channels": [dict(c) for c in channels]} for team in teams
            ],
            **extra,
        },
    }


def team(name: str, kind: str = "O") -> dict:
    return {"type": "team", "team": {"name": name, "display_name": name.capitalize(), "type": kind}}


def channel(name: str, team_name: str = "atelier", kind: str = "O", **extra) -> dict:
    return {
        "type": "channel",
        "channel": {
            "team": team_name,
            "name": name,
            "display_name": name.capitalize(),
            "type": kind,
            "deleted_at": 0,
            **extra,
        },
    }


def post(message: str, author: str = "alice", channel_name: str = "general", **extra) -> dict:
    return {
        "type": "post",
        "post": {
            "team": "atelier",
            "channel": channel_name,
            "user": author,
            "type": "",
            "message": message,
            "create_at": MS,
            "edit_at": 0,
            **extra,
        },
    }


class ConverterCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def convert(self, rows: list[dict], prepare=None) -> Path:
        export = write_export(self.root / "export", rows)
        if prepare:
            prepare(export)
        out = self.root / "archive"
        instance = converter.Converter(export, out)
        instance.read()
        instance.write()
        return out

    def base(self, *extra: dict) -> list[dict]:
        return [
            team("atelier"),
            channel("general"),
            user("alice", channels=[{"name": "general"}]),
            user("bob", channels=[{"name": "general"}]),
            *extra,
        ]

    # -- organisation ---------------------------------------------------------------------------
    def test_a_team_becomes_a_space_with_its_visibility(self) -> None:
        out = self.convert([team("atelier", "O"), team("direction", "I")])
        spaces = by_id(out, "spaces.jsonl")
        self.assertEqual(spaces["atelier"]["visibility"], "public")
        self.assertEqual(spaces["direction"]["visibility"], "private")

    def test_a_deactivated_account_arrives_marked_as_such(self) -> None:
        rows = [team("atelier"), user("alice"), user("emma")]
        rows[2]["user"]["delete_at"] = MS
        out = self.convert(rows)
        users = by_id(out, "users.jsonl")
        self.assertTrue(users["alice"]["active"])
        self.assertFalse(users["emma"]["active"])

    def test_membership_is_read_off_the_accounts_because_that_is_where_it_lives(self) -> None:
        out = self.convert(self.base())
        self.assertEqual(sorted(by_id(out, "channels.jsonl")["atelier/general"]["members"]), ["alice", "bob"])

    def test_a_private_channel_stays_private(self) -> None:
        out = self.convert([team("atelier"), channel("cloison", kind="P"), user("alice")])
        self.assertEqual(by_id(out, "channels.jsonl")["atelier/cloison"]["visibility"], "private")

    def test_purpose_wins_over_header_because_it_says_what_the_channel_is_for(self) -> None:
        out = self.convert(
            [team("atelier"), channel("general", purpose="ce qu'on fait", header="standup 9h30")]
        )
        self.assertEqual(by_id(out, "channels.jsonl")["atelier/general"]["topic"], "ce qu'on fait")

    def test_the_header_is_kept_when_there_is_no_purpose(self) -> None:
        out = self.convert([team("atelier"), channel("general", header="standup 9h30")])
        self.assertEqual(by_id(out, "channels.jsonl")["atelier/general"]["topic"], "standup 9h30")

    # -- messages -------------------------------------------------------------------------------
    def test_a_message_keeps_its_author_text_and_time(self) -> None:
        out = self.convert(self.base(post("bonjour")))
        message = next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])
        self.assertEqual(message["author"], "alice")
        self.assertEqual(message["sent_at"], "2026-09-13T12:07:41Z")
        self.assertIsNone(message["edited_at"])

    def test_an_edit_keeps_its_date(self) -> None:
        out = self.convert(self.base(post("corrigé", edit_at=MS + 60000)))
        message = next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])
        self.assertEqual(message["edited_at"], "2026-09-13T12:08:41Z")

    def test_a_nested_thread_is_flattened_onto_its_root(self) -> None:
        rows = self.base(
            post(
                "racine",
                replies=[
                    {"user": "bob", "type": "", "message": "réponse", "create_at": MS + 1000},
                    {"user": "alice", "type": "", "message": "suite", "create_at": MS + 2000},
                ],
            )
        )
        out = self.convert(rows)
        messages = {m["body"]: m for m in read_jsonl(out, "messages.jsonl") if m["body"]}
        root = messages["racine"]
        self.assertIsNone(root["thread_root"])
        self.assertEqual(messages["réponse"]["thread_root"], root["id"])
        self.assertEqual(messages["suite"]["thread_root"], root["id"])
        # A reply belongs to the same conversation as its root, or the thread lands nowhere.
        self.assertEqual(messages["réponse"]["channel"], root["channel"])

    def test_reactions_are_grouped_by_emoji_with_everyone_who_reacted(self) -> None:
        rows = self.base(
            post(
                "bonjour",
                reactions=[
                    {"user": "bob", "emoji_name": "tada", "create_at": MS},
                    {"user": "alice", "emoji_name": "tada", "create_at": MS},
                    {"user": "bob", "emoji_name": "thumbsup", "create_at": MS},
                ],
            )
        )
        out = self.convert(rows)
        message = next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])
        self.assertEqual(
            message["reactions"],
            [{"emoji": "tada", "by": ["alice", "bob"]}, {"emoji": "thumbsup", "by": ["bob"]}],
        )

    def test_a_pinned_message_stays_pinned(self) -> None:
        out = self.convert(self.base(post("bonjour", is_pinned=True)))
        self.assertTrue(next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])["pinned"])

    def test_a_saved_message_carries_who_kept_it(self) -> None:
        out = self.convert(self.base(post("bonjour", flagged_by=["bob"])))
        self.assertEqual(next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])["saved_by"], ["bob"])

    # -- notices --------------------------------------------------------------------------------
    def test_joining_a_channel_becomes_our_own_notice(self) -> None:
        rows = self.base(post("", author="alice", type="system_join_channel", props={"username": "alice"}))
        out = self.convert(rows)
        notice = next(m for m in read_jsonl(out, "messages.jsonl") if m.get("system_event"))
        self.assertEqual(notice["system_event"], "channel_joined")
        self.assertEqual(notice["body"], "", "a notice carries an event, never a sentence")

    def test_a_notice_is_about_the_person_it_concerns_not_the_one_who_acted(self) -> None:
        rows = self.base(
            post(
                "bob added to the channel by admin.",
                author="admin",
                type="system_add_to_channel",
                props={"addedUsername": "bob", "username": "admin"},
            )
        )
        out = self.convert(rows)
        notice = next(m for m in read_jsonl(out, "messages.jsonl") if m.get("system_event"))
        self.assertEqual(notice["author"], "bob")

    def test_an_event_we_have_no_notice_for_is_dropped_and_declared(self) -> None:
        rows = self.base(
            post("admin updated the purpose", type="system_purpose_change", props={"username": "admin"})
        )
        out = self.convert(rows)
        self.assertEqual([m for m in read_jsonl(out, "messages.jsonl")], [])
        limits = json.loads((out / "manifest.json").read_text())["limits"]
        self.assertTrue(
            any("system_purpose_change" in limit for limit in limits),
            "a dropped notice has to be named in the limits, not swallowed",
        )

    # -- direct conversations ---------------------------------------------------------------------
    def test_a_direct_conversation_is_identified_by_its_participants_in_order(self) -> None:
        rows = self.base(
            {
                "type": "direct_channel",
                "direct_channel": {"participants": [{"username": "bob"}, {"username": "alice"}]},
            }
        )
        out = self.convert(rows)
        self.assertIn("direct:alice+bob", by_id(out, "channels.jsonl"))

    def test_a_direct_conversation_lands_in_a_space_its_participants_share(self) -> None:
        rows = [
            team("atelier"),
            team("direction"),
            user("alice", teams=("atelier", "direction")),
            user("bob", teams=("direction",)),
            {
                "type": "direct_channel",
                "direct_channel": {"participants": [{"username": "alice"}, {"username": "bob"}]},
            },
        ]
        out = self.convert(rows)
        self.assertEqual(by_id(out, "channels.jsonl")["direct:alice+bob"]["space"], "direction")

    def test_when_they_share_several_spaces_the_first_one_wins_and_it_is_deterministic(self) -> None:
        rows = [
            team("atelier"),
            team("direction"),
            user("alice", teams=("atelier", "direction")),
            user("bob", teams=("atelier", "direction")),
            {
                "type": "direct_channel",
                "direct_channel": {"participants": [{"username": "alice"}, {"username": "bob"}]},
            },
        ]
        self.assertEqual(
            by_id(self.convert(rows), "channels.jsonl")["direct:alice+bob"]["space"], "atelier"
        )

    def test_a_direct_message_reaches_its_conversation(self) -> None:
        rows = self.base(
            {
                "type": "direct_channel",
                "direct_channel": {"participants": [{"username": "alice"}, {"username": "bob"}]},
            },
            {
                "type": "direct_post",
                "direct_post": {
                    "channel_members": ["bob", "alice"],
                    "user": "alice",
                    "type": "",
                    "message": "en direct",
                    "create_at": MS,
                    "edit_at": 0,
                },
            },
        )
        out = self.convert(rows)
        message = next(m for m in read_jsonl(out, "messages.jsonl") if m["body"] == "en direct")
        self.assertEqual(message["channel"], "direct:alice+bob")

    # -- what each person kept -----------------------------------------------------------------
    def test_a_favourite_and_a_reading_position_travel_with_the_person(self) -> None:
        rows = [
            team("atelier"),
            channel("general"),
            user("alice", channels=[{"name": "general", "favorite": True, "last_viewed_at": MS}]),
            user("bob", channels=[{"name": "general"}]),
        ]
        out = self.convert(rows)
        state = by_id(out, "channels.jsonl")["atelier/general"]["member_state"]
        self.assertEqual(state, [{"user": "alice", "favorite": True, "read_at": "2026-09-13T12:07:41Z"}])

    def test_someone_with_nothing_to_say_gets_no_entry(self) -> None:
        out = self.convert(self.base())
        self.assertNotIn("member_state", by_id(out, "channels.jsonl")["atelier/general"])

    # -- files ------------------------------------------------------------------------------------
    def test_an_attachment_is_copied_addressed_by_content_and_tied_to_its_message(self) -> None:
        relative = "20260913/teams/x/channels/y/users/z/1/note.txt"
        rows = self.base(post("voici", attachments=[{"path": relative}]))
        out = self.convert(rows, prepare=lambda export: add_attachment(export, relative, b"contenu"))

        files = by_id(out, "files.jsonl")
        self.assertIn(relative, files)
        entry = files[relative]
        self.assertEqual(entry["name"], "note.txt")
        self.assertEqual(entry["size"], len(b"contenu"))
        self.assertEqual(entry["uploaded_by"], "alice", "provenance is the only thing the export gives")
        blob = out / "blobs" / entry["hash"][7:9] / entry["hash"][7:]
        self.assertEqual(blob.read_bytes(), b"contenu")
        message = next(m for m in read_jsonl(out, "messages.jsonl") if m["body"])
        self.assertEqual(message["files"], [relative])

    def test_the_same_bytes_twice_are_stored_once(self) -> None:
        first = "a/note.txt"
        second = "b/note.txt"
        rows = self.base(
            post("un", attachments=[{"path": first}]),
            post("deux", author="bob", attachments=[{"path": second}]),
        )

        def prepare(export: Path) -> None:
            add_attachment(export, first, b"identique")
            add_attachment(export, second, b"identique")

        out = self.convert(rows, prepare=prepare)
        blobs = [p for p in (out / "blobs").rglob("*") if p.is_file()]
        self.assertEqual(len(blobs), 1)
        self.assertEqual(len(by_id(out, "files.jsonl")), 2, "two files, one blob")

    def test_an_attachment_the_export_promises_and_does_not_hold_stops_everything(self) -> None:
        rows = self.base(post("voici", attachments=[{"path": "absent/note.txt"}]))
        with self.assertRaises(SystemExit) as caught:
            self.convert(rows)
        self.assertIn("absent/note.txt", str(caught.exception))

    # -- replay ------------------------------------------------------------------------------------
    def test_converting_the_same_export_twice_yields_the_same_identifiers(self) -> None:
        # The whole resumability of an import rests on this: an identifier that changes between
        # runs turns a replay into a duplicate of every message.
        rows = self.base(post("bonjour"), post("encore", author="bob"))
        first = [m["id"] for m in read_jsonl(self.convert(rows), "messages.jsonl")]
        self._tmp.cleanup()
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        second = [m["id"] for m in read_jsonl(self.convert(rows), "messages.jsonl")]
        self.assertEqual(first, second)

    def test_two_different_messages_do_not_collapse_into_one_identifier(self) -> None:
        rows = self.base(post("un"), post("deux"))
        messages = read_jsonl(self.convert(rows), "messages.jsonl")
        self.assertEqual(len({m["id"] for m in messages}), 2)

    # -- the whole thing ---------------------------------------------------------------------------
    def test_the_output_satisfies_the_contract_checker(self) -> None:
        relative = "20260913/x/note.txt"
        rows = [
            team("atelier"),
            team("direction", "I"),
            channel("general"),
            channel("cloison", kind="P"),
            user("alice", teams=("atelier", "direction"), channels=[{"name": "general", "favorite": True}]),
            user("bob", channels=[{"name": "general", "last_viewed_at": MS}]),
            post("racine", replies=[{"user": "bob", "type": "", "message": "réponse", "create_at": MS + 1}]),
            post("épinglé", is_pinned=True, flagged_by=["bob"],
                 reactions=[{"user": "bob", "emoji_name": "tada", "create_at": MS}]),
            post("pièce jointe", attachments=[{"path": relative}]),
            post("", type="system_join_channel", props={"username": "bob"}),
            {
                "type": "direct_channel",
                "direct_channel": {"participants": [{"username": "alice"}, {"username": "bob"}]},
            },
        ]
        out = self.convert(rows, prepare=lambda export: add_attachment(export, relative))
        report = validator.validate(out)
        self.assertEqual(report.errors, [], f"the adapter produced an archive the importer would refuse: {report.errors}")


if __name__ == "__main__":
    unittest.main()
