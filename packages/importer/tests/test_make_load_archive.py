"""The load generator.

A generator nobody checks is a fixture factory that quietly drifts from the contract, and the
archives it makes are the ones used to decide whether an import of real size behaves. So the
things asserted here are the ones a load run depends on: that the output satisfies the contract,
that the same seed gives the same bytes, and that the awkward cases it is meant to produce are
actually in there.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from helpers import PACKAGE, load

GENERATOR = PACKAGE / "make-load-archive.py"
VALIDATOR = PACKAGE / "validate-archive.py"

SMALL = ["--users", "30", "--channels", "12", "--directs", "4",
         "--messages", "400", "--files", "6", "--file-bytes", "600"]


def build(out: Path, *extra: str) -> dict:
    proc = subprocess.run(
        [sys.executable, str(GENERATOR), str(out), *SMALL, *extra],
        capture_output=True, text=True, check=True,
    )
    return json.loads(proc.stdout)


def rows(out: Path, name: str) -> list[dict]:
    return [json.loads(line) for line in (out / name).read_text(encoding="utf-8").splitlines()]


class GeneratedArchive(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.out = Path(self.tmp.name) / "archive"
        self.counts = build(self.out)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_validator_accepts_it(self) -> None:
        """The whole point. A generated archive that the contract refuses tests nothing."""
        proc = subprocess.run([sys.executable, str(VALIDATOR), str(self.out)],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_the_manifest_counts_what_is_there(self) -> None:
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        for name, key in (("users", "users"), ("channels", "channels"),
                          ("messages", "messages"), ("files", "files")):
            self.assertEqual(manifest["counts"][key], len(rows(self.out, f"{name}.jsonl")), name)

    def test_the_checksums_are_of_the_files_as_written(self) -> None:
        import hashlib
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        for name, declared in manifest["checksums"].items():
            actual = "sha256:" + hashlib.sha256((self.out / name).read_bytes()).hexdigest()
            self.assertEqual(declared, actual, name)

    def test_it_says_it_was_generated(self) -> None:
        """Not disguised as a product: the source ends up in every mapping a run records."""
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["source"], "synthetic")
        self.assertTrue(any("generated" in limit for limit in manifest["limits"]))

    def test_some_accounts_have_no_address(self) -> None:
        """The case the import screen must call out rather than count quietly."""
        without = [u for u in rows(self.out, "users.jsonl") if not u.get("email")]
        self.assertGreater(len(without), 0)

    def test_every_blob_a_file_names_is_present_and_is_its_own_hash(self) -> None:
        import hashlib
        for f in rows(self.out, "files.jsonl"):
            digest = f["hash"].removeprefix("sha256:")
            blob = self.out / "blobs" / digest[:2] / digest
            self.assertTrue(blob.exists(), f["name"])
            self.assertEqual(hashlib.sha256(blob.read_bytes()).hexdigest(), digest)
            self.assertEqual(blob.stat().st_size, f["size"])

    def test_messages_only_point_at_conversations_and_people_that_exist(self) -> None:
        channels = {c["id"] for c in rows(self.out, "channels.jsonl")}
        users = {u["id"] for u in rows(self.out, "users.jsonl")}
        ids = set()
        for m in rows(self.out, "messages.jsonl"):
            self.assertIn(m["channel"], channels)
            self.assertIn(m["author"], users)
            ids.add(m["id"])
        self.assertEqual(len(ids), self.counts["messages"], "message ids collide")

    def test_a_thread_reply_points_at_a_message_in_its_own_conversation(self) -> None:
        """A root in another conversation would be a corrupt archive that happens to validate."""
        home = {m["id"]: m["channel"] for m in rows(self.out, "messages.jsonl")}
        replies = 0
        for m in rows(self.out, "messages.jsonl"):
            if m["thread_root"]:
                replies += 1
                self.assertEqual(home.get(m["thread_root"]), m["channel"])
        self.assertGreater(replies, 0, "no thread was generated at all")

    def test_the_awkward_shapes_all_appear(self) -> None:
        """Reactions, pins, edits, saves, notices, attachments: a load run that exercises only the
        simple path proves nothing about the passes that follow the first."""
        messages = rows(self.out, "messages.jsonl")
        self.assertTrue(any(m["reactions"] for m in messages), "reactions")
        self.assertTrue(any(m["saved_by"] for m in messages), "saved")
        self.assertTrue(any(m["edited_at"] for m in messages), "edited")
        self.assertTrue(any(m["system_event"] for m in messages), "notices")
        self.assertTrue(any(m["files"] for m in messages), "attachments")
        channels = rows(self.out, "channels.jsonl")
        self.assertTrue(any(c["kind"] == "direct" for c in channels), "directs")
        self.assertTrue(any(c["archived"] for c in channels), "archived")
        self.assertTrue(
            any(s.get("favorite") for c in channels for s in c["member_state"]), "favourites")

    def test_a_conversation_only_lists_people_that_exist(self) -> None:
        users = {u["id"] for u in rows(self.out, "users.jsonl")}
        for c in rows(self.out, "channels.jsonl"):
            self.assertTrue(set(c["members"]) <= users, c["id"])
            self.assertTrue({s["user"] for s in c["member_state"]} <= set(c["members"]), c["id"])

    def test_the_same_seed_gives_the_same_archive(self) -> None:
        """So a failure on a generated archive can be reproduced rather than described."""
        other = Path(self.tmp.name) / "again"
        build(other)
        for name in ("spaces.jsonl", "users.jsonl", "channels.jsonl", "messages.jsonl", "files.jsonl"):
            self.assertEqual((self.out / name).read_bytes(), (other / name).read_bytes(), name)

    def test_a_different_seed_gives_a_different_archive(self) -> None:
        other = Path(self.tmp.name) / "seeded"
        build(other, "--seed", "8")
        self.assertNotEqual((self.out / "messages.jsonl").read_bytes(),
                            (other / "messages.jsonl").read_bytes())


if __name__ == "__main__":
    unittest.main()
