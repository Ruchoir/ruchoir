"""The Nextcloud producer, run for real against a MariaDB.

Its risky half is SQL, and SQL cannot be unit tested by reading it: every defect this script has had
(a client that spoke utf8mb3 and destroyed emoji, a CAST MariaDB does not support, a filter that
silently dropped guests, reactions read from a column that only counts them) was invisible until a
database answered. So this test loads a small Nextcloud into a scratch database, runs the script
end to end, and reads what came out.

It needs a MariaDB. Point it at one:

    RUCHOIR_TEST_MARIADB=host=127.0.0.1,port=3306,user=root,password=secret python3 -m unittest

or, against a container:

    RUCHOIR_TEST_MARIADB_CONTAINER=workchat-db RUCHOIR_TEST_MARIADB=user=root,password=... \\
        python3 -m unittest

With neither set the test skips, and says so. In CI both are set, and a skip there is a failure:
a suite that quietly skips its only real test reports green over an untested feature.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from helpers import by_id, load, read_jsonl

validator = load("validate-archive.py")

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "export-nextcloud.sh"
FIXTURE = HERE / "nextcloud-fixture.sql"


def settings() -> dict[str, str] | None:
    raw = os.environ.get("RUCHOIR_TEST_MARIADB")
    if not raw:
        return None
    out = {"host": "127.0.0.1", "port": "3306", "user": "root", "password": ""}
    for pair in raw.split(","):
        if "=" in pair:
            key, value = pair.split("=", 1)
            out[key.strip()] = value.strip()
    return out


@unittest.skipIf(settings() is None, "set RUCHOIR_TEST_MARIADB to run the Nextcloud producer")
class ExportNextcloudCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = settings()
        cls.container = os.environ.get("RUCHOIR_TEST_MARIADB_CONTAINER", "")
        cls.database = "ruchoir_import_test_" + uuid.uuid4().hex[:8]
        cls.client = cls._pick_client()
        cls._sql(f"CREATE DATABASE `{cls.database}` DEFAULT CHARSET=utf8mb4;", database=None)
        cls._sql(FIXTURE.read_text(encoding="utf-8"))

        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        # The data directory the script walks, laid out the way Nextcloud lays it out.
        data = root / "data"
        for account, files in {
            "alice": {"Documents/note.txt": b"une note", "Photos/x.png": b"\x89PNG fake"},
            "bob": {"Documents/note.txt": b"une note"},  # same bytes: must be stored once
            "appdata_abc": {"cache/thing": b"internal"},  # must be skipped
        }.items():
            for relative, content in files.items():
                path = data / account / "files" / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)

        cls.archive = root / "archive"
        command = [
            str(SCRIPT),
            "--data-dir", str(data),
            "--out", str(cls.archive),
            "--space-name", "Atelier",
            "--no-encrypt",
        ]
        environment = {
            **os.environ,
            "NC_DB_HOST": cls.config["host"],
            "NC_DB_NAME": cls.database,
            "NC_DB_USER": cls.config["user"],
            "NC_DB_PASS": cls.config["password"],
        }
        if cls.container:
            command += ["--docker-db", cls.container]
        result = subprocess.run(command, capture_output=True, text=True, env=environment)
        if result.returncode != 0:
            raise AssertionError(f"the producer failed:\n{result.stdout}\n{result.stderr}")
        cls.output = result.stdout

    @classmethod
    def tearDownClass(cls) -> None:
        cls._sql(f"DROP DATABASE IF EXISTS `{cls.database}`;", database=None)
        cls.tmp.cleanup()

    # -- plumbing --------------------------------------------------------------------------------
    @classmethod
    def _pick_client(cls) -> list[str]:
        if cls.container:
            for candidate in ("mariadb", "mysql"):
                probe = subprocess.run(
                    ["docker", "exec", cls.container, "sh", "-c", f"command -v {candidate}"],
                    capture_output=True,
                )
                if probe.returncode == 0:
                    return ["docker", "exec", "-i", cls.container, candidate]
            raise AssertionError(f"no mariadb or mysql client inside {cls.container}")
        for candidate in ("mariadb", "mysql"):
            if shutil.which(candidate):
                return [candidate]
        raise AssertionError("no mariadb or mysql client on this machine")

    @classmethod
    def _sql(cls, statements: str, database: str | None = "") -> None:
        target = cls.database if database == "" else database
        command = list(cls.client) + [
            "--default-character-set=utf8mb4",
            f"-h{'localhost' if cls.container else cls.config['host']}",
            f"-u{cls.config['user']}",
        ]
        if cls.config["password"]:
            command.append(f"-p{cls.config['password']}")
        if target:
            command.append(target)
        result = subprocess.run(command, input=statements, capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(f"SQL failed: {result.stderr}\n{statements[:200]}")

    def messages(self) -> dict[str, dict]:
        return by_id(self.archive, "messages.jsonl")

    def bodies(self) -> dict[str, dict]:
        return {m["body"]: m for m in read_jsonl(self.archive, "messages.jsonl") if m["body"]}

    # -- the archive itself ------------------------------------------------------------------------
    def test_the_archive_satisfies_the_contract_checker(self) -> None:
        report = validator.validate(self.archive)
        self.assertEqual(report.errors, [], f"the producer wrote an archive the importer would refuse: {report.errors}")

    def test_the_space_is_named_as_asked(self) -> None:
        spaces = read_jsonl(self.archive, "spaces.jsonl")
        self.assertEqual(len(spaces), 1)
        self.assertEqual(spaces[0]["name"], "Atelier")

    # -- accounts ------------------------------------------------------------------------------
    def test_accounts_come_with_their_address_and_their_state(self) -> None:
        users = by_id(self.archive, "users.jsonl")
        self.assertEqual(users["alice"]["email"], "alice@example.org")
        self.assertEqual(users["bob"]["email"], "", "an instance without mail has no addresses")
        self.assertTrue(users["alice"]["active"])
        self.assertFalse(users["emma"]["active"], "a disabled account must arrive disabled")

    # -- conversations ----------------------------------------------------------------------------
    def test_nextclouds_own_conversations_stay_behind(self) -> None:
        channels = by_id(self.archive, "channels.jsonl")
        self.assertEqual(sorted(channels), ["tokdirect", "tokequipe", "tokgeneral"])
        for furniture in ("tokchangelog", "toknote", "toksample"):
            self.assertNotIn(furniture, channels)

    def test_a_one_to_one_becomes_a_direct_conversation(self) -> None:
        self.assertEqual(by_id(self.archive, "channels.jsonl")["tokdirect"]["kind"], "direct")

    def test_a_direct_conversation_carries_no_name(self) -> None:
        # Talk keeps the participant list in the name column of a one-to-one, as JSON. Copying it
        # through would name the conversation ["alice","bob"] for the rest of its life.
        self.assertEqual(by_id(self.archive, "channels.jsonl")["tokdirect"]["name"], "")

    def test_visibility_follows_the_room_type(self) -> None:
        channels = by_id(self.archive, "channels.jsonl")
        self.assertEqual(channels["tokgeneral"]["visibility"], "public")
        self.assertEqual(channels["tokequipe"]["visibility"], "private")

    def test_a_guest_attendee_is_not_a_member(self) -> None:
        self.assertEqual(sorted(by_id(self.archive, "channels.jsonl")["tokgeneral"]["members"]),
                         ["alice", "bob", "carol"])

    def test_a_conversation_never_called_into_still_has_a_date(self) -> None:
        # `active_since` is null on a room nobody called in; last_activity is the fallback.
        self.assertIsNotNone(by_id(self.archive, "channels.jsonl")["tokequipe"]["created_at"])

    # -- messages -----------------------------------------------------------------------------------
    def test_emoji_and_accents_survive_the_crossing(self) -> None:
        # The connection used to negotiate utf8mb3 and turn every four-byte character into '?'.
        self.assertIn("Bonjour 🎉 à toutes et à tous", self.bodies())

    def test_a_reply_points_at_its_root(self) -> None:
        bodies = self.bodies()
        self.assertEqual(bodies["Une réponse"]["thread_root"], bodies["Message épinglé"]["id"])

    def test_a_pinned_message_is_pinned(self) -> None:
        self.assertTrue(self.bodies()["Message épinglé"]["pinned"])
        self.assertFalse(self.bodies()["Bonjour 🎉 à toutes et à tous"]["pinned"])

    def test_reactions_carry_who_reacted(self) -> None:
        reactions = sorted(self.bodies()["Message épinglé"]["reactions"], key=lambda r: r["emoji"])
        self.assertEqual(
            reactions,
            sorted(
                [{"emoji": "👍", "by": ["alice", "carol"]}, {"emoji": "🎉", "by": ["bob"]}],
                key=lambda r: r["emoji"],
            ),
        )

    def test_a_guest_message_is_kept_and_marked_absent(self) -> None:
        message = self.bodies()["Un message d'invité"]
        self.assertEqual(message["author"], "guests:sample")

    def test_deleted_messages_and_reaction_rows_are_not_messages(self) -> None:
        bodies = self.bodies()
        self.assertNotIn("Message supprimé", bodies)
        self.assertNotIn("👍", bodies, "a reaction is a row in oc_comments and must not become a message")

    def test_only_the_two_notices_we_have_cross(self) -> None:
        events = sorted(m["system_event"] for m in read_jsonl(self.archive, "messages.jsonl") if m.get("system_event"))
        self.assertEqual(events, ["channel_created", "channel_joined"])

    def test_a_notice_is_about_the_person_it_concerns(self) -> None:
        joined = next(m for m in read_jsonl(self.archive, "messages.jsonl")
                      if m.get("system_event") == "channel_joined")
        self.assertEqual(joined["author"], "bob", "alice added bob, so the notice is about bob")

    def test_a_creation_notice_is_about_nobody(self) -> None:
        created = next(m for m in read_jsonl(self.archive, "messages.jsonl")
                       if m.get("system_event") == "channel_created")
        self.assertIsNone(created["author"])

    # -- files -----------------------------------------------------------------------------------
    def test_a_shared_file_is_tied_to_its_message(self) -> None:
        shared = next(m for m in read_jsonl(self.archive, "messages.jsonl") if m["files"])
        self.assertEqual(shared["files"], ["alice/Documents/note.txt"])
        self.assertEqual(shared["body"], "", "a share carries a file, not a sentence")

    def test_files_are_read_from_the_directory_and_deduplicated(self) -> None:
        files = by_id(self.archive, "files.jsonl")
        self.assertEqual(sorted(files), ["alice/Documents/note.txt", "alice/Photos/x.png", "bob/Documents/note.txt"])
        blobs = [p for p in (self.archive / "blobs").rglob("*") if p.is_file()]
        self.assertEqual(len(blobs), 2, "two accounts holding the same bytes store them once")

    def test_nextclouds_internal_directories_are_skipped(self) -> None:
        self.assertFalse([f for f in by_id(self.archive, "files.jsonl") if f.startswith("appdata")])

    # -- what each person kept ---------------------------------------------------------------------
    def test_a_favourite_and_a_reading_position_travel(self) -> None:
        state = {e["user"]: e for e in by_id(self.archive, "channels.jsonl")["tokgeneral"]["member_state"]}
        self.assertTrue(state["alice"]["favorite"])
        self.assertEqual(state["alice"]["read_message"], "101")
        self.assertNotIn("favorite", state["bob"], "favorite false says nothing and is left out")
        self.assertNotIn("carol", state, "someone with nothing to say gets no entry")

    # -- the manifest ------------------------------------------------------------------------------
    def test_the_manifest_declares_what_stayed_behind(self) -> None:
        limits = json.loads((self.archive / "manifest.json").read_text(encoding="utf-8"))["limits"]
        joined = " ".join(limits).lower()
        for subject in ("archiv", "contact", "share", "group", "saved", "edit"):
            self.assertIn(subject, joined, f"nothing in limits mentions {subject}")

    def test_the_counts_are_the_truth(self) -> None:
        manifest = json.loads((self.archive / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"]["channels"], 3)
        self.assertEqual(manifest["counts"]["users"], 4)
        self.assertEqual(manifest["counts"]["files"], 3)
        self.assertEqual(manifest["source"], "nextcloud")
        self.assertIn("24.0.4", manifest["source_version"])


class GuardCase(unittest.TestCase):
    """In CI the producer test must actually run. A skip there is a green light over nothing."""

    def test_the_producer_test_is_not_skipped_where_it_matters(self) -> None:
        if os.environ.get("RUCHOIR_TEST_REQUIRE_MARIADB") != "1":
            self.skipTest("only enforced in CI")
        self.assertIsNotNone(
            settings(),
            "RUCHOIR_TEST_REQUIRE_MARIADB is set but RUCHOIR_TEST_MARIADB is not: "
            "the Nextcloud producer would silently not be tested",
        )


if __name__ == "__main__":
    unittest.main()
