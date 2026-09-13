"""The two checkers must reach the same verdict.

There are two implementations of one contract: `validate-archive.py`, which runs beside a producer
on the customer's machine, and the checker inside the API, which decides whether an archive is
actually imported. The first exists so that nobody carries a broken archive across the internet
only to be refused on arrival. That promise is worth exactly as much as the agreement between the
two, and twice in one day it was worth nothing:

* a producer spelled a reaction's people `users` instead of `by`. Python said "coherent"; the API
  produced a hundred and twenty thousand errors and refused the whole archive.
* a generated archive pinned a notice every thousandth message. Python said "coherent" again; the
  API refused it again.

Both were one-sided rules. This file makes that impossible to add: every archive below is put to
both checkers and the verdicts have to match. A rule added on one side and not the other fails
here, at the moment it is written, rather than in front of somebody importing a real workspace.

It needs the API binary. Without one the tests skip, except in CI, where the environment says the
binary must be there and a skip is a failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from helpers import PACKAGE, build_archive, load, rewrite

validator = load("validate-archive.py")

REPO = PACKAGE.parent.parent


def find_binary() -> Path | None:
    """The API binary, wherever this machine put it."""
    named = os.environ.get("RUCHOIR_API_BIN")
    if named:
        return Path(named) if Path(named).is_file() else None
    for candidate in (REPO / "target/debug/ruchoir-api", REPO / "target/release/ruchoir-api"):
        if candidate.is_file():
            return candidate
    found = shutil.which("ruchoir-api")
    return Path(found) if found else None


BINARY = find_binary()
REQUIRED = os.environ.get("RUCHOIR_TEST_REQUIRE_RUST_CHECKER") == "1"


def rust_accepts(archive: Path) -> tuple[bool, str]:
    assert BINARY is not None
    # `import-check` is dispatched before the database is touched, so this needs no instance.
    proc = subprocess.run(
        [str(BINARY), "import-check", str(archive)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode == 0, proc.stdout + proc.stderr


def python_accepts(archive: Path) -> tuple[bool, str]:
    report = validator.validate(archive)
    return not report.errors, "\n".join(report.errors)


# Each entry breaks the reference archive in one way. The name is what the break is; the function
# does it. Every one of them must be refused by both checkers.
def _reaction_by_the_wrong_field(archive: Path) -> None:
    """The first divergence: the people were there, under a name the contract does not use."""
    messages = _messages(archive)
    messages[0]["reactions"] = [{"emoji": "\U0001f389", "users": ["bob"]}]
    rewrite(archive, "messages.jsonl", messages)


def _pinned_notice(archive: Path) -> None:
    """The second divergence."""
    messages = _messages(archive)
    messages[0].update({"system_event": "channel_joined", "body": "", "pinned": True})
    rewrite(archive, "messages.jsonl", messages)


def _reaction_named_rather_than_drawn(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["reactions"] = [{"emoji": "tada", "by": ["bob"]}]
    rewrite(archive, "messages.jsonl", messages)


def _notice_with_a_body(archive: Path) -> None:
    messages = _messages(archive)
    messages[0].update({"system_event": "channel_joined", "body": "bonjour"})
    rewrite(archive, "messages.jsonl", messages)


def _notice_nobody_can_say(archive: Path) -> None:
    messages = _messages(archive)
    messages[0].update({"system_event": "someone_did_something", "body": ""})
    rewrite(archive, "messages.jsonl", messages)


def _message_in_no_conversation(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["channel"] = "nowhere"
    rewrite(archive, "messages.jsonl", messages)


def _message_by_a_stranger(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["author"] = "ghost"
    rewrite(archive, "messages.jsonl", messages)


def _message_with_no_author_and_no_event(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["author"] = None
    rewrite(archive, "messages.jsonl", messages)


def _thread_root_that_is_not_here(archive: Path) -> None:
    messages = _messages(archive)
    messages[-1]["thread_root"] = "nothing-like-this"
    rewrite(archive, "messages.jsonl", messages)


def _attachment_that_is_not_in_files(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["files"] = ["not/a/file"]
    rewrite(archive, "messages.jsonl", messages)


def _saved_by_a_stranger(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["saved_by"] = ["ghost"]
    rewrite(archive, "messages.jsonl", messages)


def _reaction_by_a_stranger(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["reactions"] = [{"emoji": "\U0001f389", "by": ["ghost"]}]
    rewrite(archive, "messages.jsonl", messages)


def _a_time_that_is_not_a_time(archive: Path) -> None:
    messages = _messages(archive)
    messages[0]["sent_at"] = "hier soir"
    rewrite(archive, "messages.jsonl", messages)


def _two_messages_with_one_identifier(archive: Path) -> None:
    messages = _messages(archive)
    messages.append(dict(messages[0]))
    rewrite(archive, "messages.jsonl", messages)


def _conversation_in_no_space(archive: Path) -> None:
    channels = _rows(archive, "channels.jsonl")
    channels[0]["space"] = "elsewhere"
    rewrite(archive, "channels.jsonl", channels)


def _conversation_of_a_kind_we_do_not_have(archive: Path) -> None:
    channels = _rows(archive, "channels.jsonl")
    channels[0]["kind"] = "broadcast"
    rewrite(archive, "channels.jsonl", channels)


def _conversation_with_a_member_who_is_nobody(archive: Path) -> None:
    channels = _rows(archive, "channels.jsonl")
    channels[0]["members"] = [*channels[0]["members"], "ghost"]
    rewrite(archive, "channels.jsonl", channels)


def _space_with_no_name(archive: Path) -> None:
    spaces = _rows(archive, "spaces.jsonl")
    spaces[0]["name"] = ""
    rewrite(archive, "spaces.jsonl", spaces)


def _file_whose_bytes_are_missing(archive: Path) -> None:
    for blob in (archive / "blobs").rglob("*"):
        if blob.is_file():
            blob.unlink()


def _file_with_a_hash_that_is_not_one(archive: Path) -> None:
    files = _rows(archive, "files.jsonl")
    files[0]["hash"] = "sha256:not-a-digest"
    rewrite(archive, "files.jsonl", files)


def _a_file_that_lies_about_its_bytes(archive: Path) -> None:
    """The archive was altered or truncated in transit, which is what the digests are there for."""
    for blob in (archive / "blobs").rglob("*"):
        if blob.is_file():
            blob.write_bytes(b"something else entirely")


def _a_manifest_that_miscounts(archive: Path) -> None:
    manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
    manifest["counts"]["messages"] = 999
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def _a_manifest_from_a_newer_producer(archive: Path) -> None:
    manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
    manifest["format_version"] = 99
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


BREAKAGES = [
    ("a reaction whose people are under the wrong field", _reaction_by_the_wrong_field),
    ("a pinned notice", _pinned_notice),
    ("a reaction named rather than drawn", _reaction_named_rather_than_drawn),
    ("a notice with a body", _notice_with_a_body),
    ("a notice nobody can say", _notice_nobody_can_say),
    ("a message in no conversation", _message_in_no_conversation),
    ("a message by a stranger", _message_by_a_stranger),
    ("a message with neither author nor event", _message_with_no_author_and_no_event),
    ("a thread root that is not here", _thread_root_that_is_not_here),
    ("an attachment that is not in files.jsonl", _attachment_that_is_not_in_files),
    ("a message saved by a stranger", _saved_by_a_stranger),
    ("a reaction by a stranger", _reaction_by_a_stranger),
    ("a time that is not a time", _a_time_that_is_not_a_time),
    ("two messages with one identifier", _two_messages_with_one_identifier),
    ("a conversation in no space", _conversation_in_no_space),
    ("a conversation of a kind we do not have", _conversation_of_a_kind_we_do_not_have),
    ("a conversation with a member who is nobody", _conversation_with_a_member_who_is_nobody),
    ("a space with no name", _space_with_no_name),
    ("a file whose bytes are missing", _file_whose_bytes_are_missing),
    ("a file with a hash that is not one", _file_with_a_hash_that_is_not_one),
    ("a file that lies about its bytes", _a_file_that_lies_about_its_bytes),
    ("a manifest that miscounts", _a_manifest_that_miscounts),
    ("a manifest from a newer producer", _a_manifest_from_a_newer_producer),
]


def _rows(archive: Path, name: str) -> list[dict]:
    return [
        json.loads(line)
        for line in (archive / name).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _messages(archive: Path) -> list[dict]:
    return _rows(archive, "messages.jsonl")


@unittest.skipIf(
    BINARY is None and not REQUIRED,
    "no API binary: build one with `cargo build -p ruchoir-api` to run the cross-check",
)
class CheckersAgree(unittest.TestCase):
    def setUp(self) -> None:
        if BINARY is None:
            # In CI the binary is not optional: a silent skip there would leave the two checkers
            # free to drift again, which is the entire thing this file exists to prevent.
            self.fail(
                "RUCHOIR_TEST_REQUIRE_RUST_CHECKER=1 but no API binary was found; "
                "build one with `cargo build -p ruchoir-api`"
            )
        self._tmp = TemporaryDirectory()
        self.archive = build_archive(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_both_accept_a_sound_archive(self) -> None:
        """First, because every disagreement below is meaningless if the reference is refused."""
        py_ok, py_said = python_accepts(self.archive)
        rs_ok, rs_said = rust_accepts(self.archive)
        self.assertTrue(py_ok, py_said)
        self.assertTrue(rs_ok, rs_said)

    def test_both_refuse_each_way_of_breaking_it(self) -> None:
        for name, break_it in BREAKAGES:
            with self.subTest(name):
                tmp = TemporaryDirectory()
                self.addCleanup(tmp.cleanup)
                archive = build_archive(Path(tmp.name))
                break_it(archive)
                py_ok, py_said = python_accepts(archive)
                rs_ok, rs_said = rust_accepts(archive)
                self.assertFalse(
                    py_ok,
                    f"{name}: the checker beside the producer accepted it, and the API will not. "
                    f"The API said:\n{rs_said}",
                )
                self.assertFalse(
                    rs_ok,
                    f"{name}: the API accepted it and the producer's checker did not. "
                    f"The producer's checker said:\n{py_said}",
                )


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
