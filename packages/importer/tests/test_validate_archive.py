"""The contract checker has to catch every way an archive can lie.

Each test breaks exactly one thing in an otherwise valid archive and asserts it is caught. A
checker that passes everything is worse than no checker: it is a green light on a broken import.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from helpers import build_archive, load, rewrite, set_format

validator = load("validate-archive.py")


class ValidatorCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.archive = build_archive(self.root)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def errors(self) -> list[str]:
        return validator.validate(self.archive).errors

    def warnings(self) -> list[str]:
        return validator.validate(self.archive).warnings

    def assert_caught(self, fragment: str) -> None:
        errors = self.errors()
        self.assertTrue(
            any(fragment in e for e in errors),
            f"nothing mentioning {fragment!r} was reported; got {errors}",
        )

    def channels(self) -> list[dict]:
        return [json.loads(l) for l in (self.archive / "channels.jsonl").read_text().splitlines() if l]

    def messages(self) -> list[dict]:
        return [json.loads(l) for l in (self.archive / "messages.jsonl").read_text().splitlines() if l]

    # -- the archive we build must itself be valid, or every other test proves nothing ---------
    def test_a_sound_archive_passes(self) -> None:
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [], f"the reference archive should be clean: {report.errors}")
        self.assertEqual(report.warnings, [])

    # -- manifest ------------------------------------------------------------------------------
    def test_a_newer_format_is_refused_rather_than_guessed_at(self) -> None:
        manifest = json.loads((self.archive / "manifest.json").read_text())
        manifest["format_version"] = 3
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        self.assert_caught("format_version")

    def test_an_unknown_source_is_refused(self) -> None:
        manifest = json.loads((self.archive / "manifest.json").read_text())
        manifest["source"] = "hipchat"
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        self.assert_caught("source")

    def test_a_count_that_disagrees_with_the_content_is_caught(self) -> None:
        manifest = json.loads((self.archive / "manifest.json").read_text())
        manifest["counts"]["messages"] = 99
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        self.assert_caught("manifest counts")

    def test_a_tampered_file_fails_its_checksum(self) -> None:
        # Rewritten without repairing the manifest: exactly what a corrupted transfer looks like.
        (self.archive / "users.jsonl").write_text(
            json.dumps({"id": "alice", "email": "", "display_name": "Alice", "active": True}) + "\n"
        )
        self.assert_caught("checksum")

    def test_a_missing_file_is_caught(self) -> None:
        (self.archive / "files.jsonl").unlink()
        self.assert_caught("files.jsonl is missing")

    def test_a_line_that_is_not_json_is_caught(self) -> None:
        with (self.archive / "users.jsonl").open("a", encoding="utf-8") as sink:
            sink.write("{not json\n")
        self.assert_caught("is not JSON")

    # -- references ----------------------------------------------------------------------------
    def test_a_conversation_in_a_space_that_does_not_exist(self) -> None:
        channels = self.channels()
        channels[0]["space"] = "ailleurs"
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("is not in spaces.jsonl")

    def test_a_message_in_a_conversation_that_does_not_exist(self) -> None:
        messages = self.messages()
        messages[0]["channel"] = "atelier/nowhere"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("is not in channels.jsonl")

    def test_a_member_who_is_not_an_account(self) -> None:
        channels = self.channels()
        channels[0]["members"].append("ghost")
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("is not in users.jsonl")

    def test_an_author_who_is_neither_an_account_nor_marked_absent(self) -> None:
        messages = self.messages()
        messages[0]["author"] = "someone"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("neither an account nor marked absent")

    def test_a_guest_author_is_accepted_because_that_is_how_we_mark_them(self) -> None:
        messages = self.messages()
        messages[0]["author"] = "guests:sample"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assertEqual(self.errors(), [])

    def test_an_attachment_pointing_at_nothing(self) -> None:
        messages = self.messages()
        messages[0]["files"] = ["absent.txt"]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("is not in files.jsonl")

    def test_a_saved_by_naming_a_stranger(self) -> None:
        messages = self.messages()
        messages[0]["saved_by"] = ["ghost"]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("saved by")

    def test_a_reaction_by_a_stranger(self) -> None:
        messages = self.messages()
        messages[0]["reactions"] = [{"emoji": "\U0001f389", "by": ["ghost"]}]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("reaction by")

    def test_a_reaction_nobody_gave(self) -> None:
        """The one that got away. A producer that spelled the people some other way (`users`
        instead of `by`) produced a hundred and twenty thousand reactions attributed to nobody, and
        this side of the contract said the archive was fine."""
        messages = self.messages()
        messages[0]["reactions"] = [{"emoji": "\U0001f389", "users": ["bob"]}]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("by nobody")

    def test_a_reaction_that_is_a_name_rather_than_an_emoji(self) -> None:
        """It would arrive as the word `tada` sitting under the message."""
        messages = self.messages()
        messages[0]["reactions"] = [{"emoji": "tada", "by": ["bob"]}]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("is a name, not an emoji")

    def test_a_reaction_whose_emoji_is_blank(self) -> None:
        messages = self.messages()
        messages[0]["reactions"] = [{"emoji": "   ", "by": ["bob"]}]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("a reaction with no emoji")

    def test_a_shortcode_the_producer_admits_it_could_not_translate_is_allowed(self) -> None:
        """`:shipit:` crosses and is shown as text. Dropping it would be worse, and the producer
        said plainly what it did."""
        messages = self.messages()
        messages[0]["reactions"] = [{"emoji": ":shipit:", "by": ["bob"]}]
        rewrite(self.archive, "messages.jsonl", messages)
        self.assertEqual(self.errors(), [])
        self.assertTrue(any("shown as text" in w for w in self.warnings()), self.warnings())

    def test_two_records_sharing_an_identifier(self) -> None:
        messages = self.messages()
        messages.append(dict(messages[0]))
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("appears twice")

    # -- threads -------------------------------------------------------------------------------
    def test_a_reply_to_a_message_that_is_not_here(self) -> None:
        messages = self.messages()
        messages[1]["thread_root"] = "gone"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("thread_root")

    def test_a_reply_whose_root_is_in_another_conversation(self) -> None:
        channels = self.channels()
        other = dict(channels[0])
        other["id"] = "atelier/other"
        other["member_state"] = []
        channels.append(other)
        rewrite(self.archive, "channels.jsonl", channels)
        messages = self.messages()
        messages[1]["channel"] = "atelier/other"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("another conversation")

    def test_a_reply_to_a_reply_is_refused(self) -> None:
        messages = self.messages()
        messages.append(
            {
                **messages[1],
                "id": "m4",
                "thread_root": "m2",
                "sent_at": "2026-09-13T10:03:00Z",
            }
        )
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("a reply to a reply")

    # -- notices -------------------------------------------------------------------------------
    def test_a_notice_carrying_a_sentence(self) -> None:
        messages = self.messages()
        messages[2]["body"] = "bob a rejoint le canal."
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("never a sentence")

    def test_an_event_we_have_no_notice_for(self) -> None:
        messages = self.messages()
        messages[2]["system_event"] = "moderator_promoted"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("system_event")

    def test_an_ordinary_message_with_no_author(self) -> None:
        messages = self.messages()
        messages[0]["author"] = None
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("needs an author")

    # -- files and blobs -------------------------------------------------------------------------
    def test_a_file_whose_bytes_are_absent(self) -> None:
        for blob in (self.archive / "blobs").rglob("*"):
            if blob.is_file():
                blob.unlink()
        self.assert_caught("its bytes are not in blobs")

    def test_a_declared_size_that_does_not_match_the_blob(self) -> None:
        files = [json.loads(l) for l in (self.archive / "files.jsonl").read_text().splitlines() if l]
        files[0]["size"] = 9999
        rewrite(self.archive, "files.jsonl", files)
        self.assert_caught("declares 9999 bytes")

    def test_a_blob_nothing_points_at(self) -> None:
        # An orphan blob means the archive carries someone's file for no reason: at best waste, at
        # worst a document that should not have travelled.
        orphan = self.archive / "blobs" / "ff" / ("f" * 64)
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(b"orphan")
        self.assert_caught("nothing points at it")

    def test_a_hash_that_is_not_a_hash(self) -> None:
        files = [json.loads(l) for l in (self.archive / "files.jsonl").read_text().splitlines() if l]
        files[0]["hash"] = "md5:whatever"
        rewrite(self.archive, "files.jsonl", files)
        self.assert_caught("is not sha256")

    # -- what each person kept ---------------------------------------------------------------
    def test_member_state_for_someone_who_is_not_a_member(self) -> None:
        channels = self.channels()
        channels[0]["member_state"].append({"user": "ghost", "favorite": True})
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("disagrees with itself")

    def test_two_entries_for_the_same_person(self) -> None:
        channels = self.channels()
        channels[0]["member_state"].append({"user": "alice", "favorite": True})
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("two entries")

    def test_an_entry_that_says_nothing(self) -> None:
        channels = self.channels()
        channels[0]["member_state"] = [{"user": "alice"}]
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("says nothing")

    def test_a_reading_position_on_a_message_that_did_not_cross_is_only_a_warning(self) -> None:
        # Explicitly allowed by the contract: the importer moves it back to the nearest message.
        channels = self.channels()
        channels[0]["member_state"] = [{"user": "alice", "read_message": "m99"}]
        rewrite(self.archive, "channels.jsonl", channels)
        self.assertEqual(self.errors(), [])
        self.assertTrue(any("had read up to" in w for w in self.warnings()))

    def test_favorite_false_is_noise_and_says_so(self) -> None:
        channels = self.channels()
        channels[0]["member_state"] = [{"user": "alice", "favorite": False}]
        rewrite(self.archive, "channels.jsonl", channels)
        self.assertTrue(any("says nothing" in w for w in self.warnings()))

    # -- shapes --------------------------------------------------------------------------------
    def test_a_direct_conversation_with_one_person(self) -> None:
        channels = self.channels()
        channels[0]["kind"] = "direct"
        channels[0]["members"] = ["alice"]
        channels[0]["member_state"] = []
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("at least two people")

    def test_a_timestamp_that_is_not_one(self) -> None:
        messages = self.messages()
        messages[0]["sent_at"] = "hier"
        rewrite(self.archive, "messages.jsonl", messages)
        self.assert_caught("sent_at")

    def test_an_archive_with_no_space(self) -> None:
        rewrite(self.archive, "spaces.jsonl", [])
        self.assert_caught("names no space")

    def test_the_same_person_listed_twice_in_a_conversation(self) -> None:
        channels = self.channels()
        channels[0]["members"] = ["alice", "alice", "bob"]
        rewrite(self.archive, "channels.jsonl", channels)
        self.assert_caught("listed twice")

    # -- format 2: people, groups and roles --------------------------------------------------------
    def v2(self, members=None, groups=None, roles=None, moderators=None) -> None:
        set_format(self.archive, 2)
        if members is not None:
            rewrite(self.archive, "members.jsonl", members)
        if groups is not None:
            rewrite(self.archive, "groups.jsonl", groups)
        if roles is not None:
            rewrite(self.archive, "roles.jsonl", roles)
        if moderators is not None:
            channels = self.channels()
            channels[0]["moderators"] = moderators
            rewrite(self.archive, "channels.jsonl", channels)

    @staticmethod
    def person(user, role="member", roles=(), space="atelier") -> dict:
        return {"space": space, "user": user, "role": role, "roles": list(roles)}

    def test_a_format_2_archive_reads_members_groups_and_roles(self) -> None:
        self.v2(
            members=[self.person("alice", "admin", ["r1"]), self.person("bob")],
            groups=[{"id": "g1", "space": "atelier", "name": "Design", "description": "", "members": ["alice"]}],
            roles=[{"id": "r1", "space": "atelier", "name": "Moderators", "based_on": "member"}],
            moderators=["alice"],
        )
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [])
        self.assertEqual(report.warnings, [])

    def test_a_format_1_archive_still_reads_and_ignores_people_files(self) -> None:
        self.v2(members=[self.person("ghost", "owner", ["nope"])], moderators=["ghost"])
        set_format(self.archive, 1)
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [])
        self.assertTrue(any("belongs to format 2" in w for w in report.warnings), report.warnings)

    def test_format_3_is_refused_with_the_newer_producer_message(self) -> None:
        set_format(self.archive, 3)
        self.assert_caught("format_version 3")
        self.assertFalse(any("says format 1" in w for w in self.warnings()))

    def test_moderators_in_a_format_1_archive_are_only_a_warning(self) -> None:
        channels = self.channels()
        channels[0]["moderators"] = ["alice"]
        rewrite(self.archive, "channels.jsonl", channels)
        self.assertEqual(self.errors(), [])
        self.assertTrue(any("moderators belong to format 2" in w for w in self.warnings()))

    def test_a_member_line_for_an_unknown_user_is_an_error(self) -> None:
        self.v2(members=[self.person("ghost")])
        self.assert_caught("member ghost: not an account")

    def test_a_member_line_for_an_unknown_space_or_role_is_an_error(self) -> None:
        self.v2(members=[self.person("alice", space="nowhere")])
        self.assert_caught("space 'nowhere' is not in this archive")
        self.v2(members=[self.person("alice", role="owner")])
        self.assert_caught("role 'owner' is not one we have")

    def test_two_lines_for_one_person_and_space_is_an_error(self) -> None:
        self.v2(members=[self.person("alice"), self.person("alice", "admin")])
        self.assert_caught("listed twice in space atelier")

    def test_one_person_two_spaces_two_roles(self) -> None:
        spaces = [
            {"id": "atelier", "name": "Atelier", "description": "", "visibility": "public"},
            {"id": "bureau", "name": "Bureau", "description": "", "visibility": "private"},
        ]
        rewrite(self.archive, "spaces.jsonl", spaces)
        self.v2(members=[self.person("alice", "admin"), self.person("alice", "guest", space="bureau")])
        self.assertEqual(self.errors(), [])

    def test_a_moderator_outside_the_members_is_an_error(self) -> None:
        self.v2(moderators=["stranger"])
        self.assert_caught("moderator 'stranger' is not one of its members")

    def test_two_groups_with_one_name_is_an_error(self) -> None:
        group = {"space": "atelier", "description": "", "members": []}
        self.v2(groups=[{**group, "id": "g1", "name": "Design"}, {**group, "id": "g2", "name": "DESIGN"}])
        self.assert_caught("has the same name")

    def test_a_role_id_nobody_defined_is_an_error(self) -> None:
        self.v2(members=[self.person("alice", roles=["ghost-role"])])
        self.assert_caught("role 'ghost-role' is not defined for space atelier")

    def test_a_guest_with_roles_is_only_a_warning(self) -> None:
        self.v2(
            members=[self.person("alice", "guest", ["r1"])],
            roles=[{"id": "r1", "space": "atelier", "name": "R", "based_on": "admin"}],
            moderators=["alice"],
        )
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [])
        self.assertTrue(any("a guest carries roles" in w for w in report.warnings))
        self.assertTrue(any("a guest is listed as moderator" in w for w in report.warnings))

    def test_a_person_in_no_conversation_and_no_group_is_only_a_warning(self) -> None:
        channels = self.channels()
        channels[0]["members"] = ["bob"]
        channels[0]["member_state"] = []
        rewrite(self.archive, "channels.jsonl", channels)
        self.v2(members=[self.person("alice")])
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [])
        self.assertTrue(any("no conversation and no group" in w for w in report.warnings))

    def test_declared_counts_of_members_groups_roles_are_held(self) -> None:
        self.v2(members=[self.person("alice")])
        manifest = json.loads((self.archive / "manifest.json").read_text())
        manifest["counts"].update({"members": 2, "groups": 1})
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        self.assert_caught("counts 2 members, the archive holds 1")
        self.assert_caught("counts 1 groups, the archive holds 0")

    def test_a_listed_checksum_covers_the_people_files(self) -> None:
        self.v2(members=[self.person("alice")])
        manifest = json.loads((self.archive / "manifest.json").read_text())
        manifest["checksums"]["members.jsonl"] = "sha256:" + "0" * 64
        (self.archive / "manifest.json").write_text(json.dumps(manifest))
        self.assert_caught("members.jsonl does not match its declared checksum")


if __name__ == "__main__":
    unittest.main()
