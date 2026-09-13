#!/usr/bin/env python3
"""Checks an import archive against the contract in docs/import-archive.md.

Every producer runs this on its output, the test suite runs it on crafted archives, and the
importer will run it on an archive an administrator uploads, before writing a single row. One
checker rather than three keeps the contract from drifting into three different beliefs about it.

    validate-archive.py <archive dir> [--strict]

Exit code 0 means the archive is coherent. Warnings are printed but do not fail unless --strict:
they cover the cases the contract explicitly allows a producer to leave rough, such as a reading
position that names a message which did not cross.

The checks are deliberately paranoid about references. A dangling identifier in an import is not a
cosmetic problem: it becomes a message attributed to nobody, an attachment pointing at no bytes, or
a conversation in a space that does not exist.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

FORMAT_VERSIONS = {1}
SOURCES = {"nextcloud", "mattermost", "slack", "teams"}
KINDS = {"channel", "direct"}
VISIBILITIES = {"public", "private"}
SYSTEM_EVENTS = {
    "member_joined",
    "member_left",
    "member_removed",
    "channel_joined",
    "channel_left",
    "channel_removed",
    "channel_created",
}
FILES = ("spaces.jsonl", "users.jsonl", "channels.jsonl", "messages.jsonl", "files.jsonl")
HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
# An author that matches no account: a guest, a bot, someone the producer could not resolve. The
# importer attributes these to an absent author rather than dropping the message.
ABSENT_AUTHOR = re.compile(r"^[a-z_]+:.+$")


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def read_jsonl(path: Path, report: Report) -> list[dict]:
    rows: list[dict] = []
    if not path.is_file():
        report.error(f"{path.name} is missing")
        return rows
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            report.error(f"{path.name}:{number} is not JSON ({exc.msg})")
            continue
        if not isinstance(row, dict):
            report.error(f"{path.name}:{number} is not an object")
            continue
        rows.append(row)
    return rows


def is_timestamp(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def unique_ids(rows: list[dict], name: str, report: Report) -> dict[str, dict]:
    by_id: dict[str, dict] = {}
    for row in rows:
        identifier = row.get("id")
        if not isinstance(identifier, str) or not identifier:
            report.error(f"{name}: a record has no usable id")
            continue
        if identifier in by_id:
            report.error(f"{name}: {identifier!r} appears twice")
            continue
        by_id[identifier] = row
    return by_id


def validate(archive: Path) -> Report:
    report = Report()

    manifest_path = archive / "manifest.json"
    manifest: dict = {}
    if not manifest_path.is_file():
        report.error("manifest.json is missing")
    else:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            report.error(f"manifest.json is not JSON ({exc.msg})")

    spaces = unique_ids(read_jsonl(archive / "spaces.jsonl", report), "spaces.jsonl", report)
    users = unique_ids(read_jsonl(archive / "users.jsonl", report), "users.jsonl", report)
    channels = unique_ids(read_jsonl(archive / "channels.jsonl", report), "channels.jsonl", report)
    messages_rows = read_jsonl(archive / "messages.jsonl", report)
    messages = unique_ids(messages_rows, "messages.jsonl", report)
    files = unique_ids(read_jsonl(archive / "files.jsonl", report), "files.jsonl", report)

    _check_manifest(archive, manifest, spaces, users, channels, messages_rows, files, report)
    _check_spaces(spaces, report)
    _check_users(users, report)
    _check_channels(channels, spaces, users, report)
    _check_messages(messages, channels, users, files, report)
    _check_files(archive, files, messages, report)
    _check_member_state(channels, messages, report)

    return report


def _check_manifest(archive, manifest, spaces, users, channels, messages, files, report) -> None:
    if not manifest:
        return

    version = manifest.get("format_version")
    if version not in FORMAT_VERSIONS:
        report.error(f"format_version {version!r} is not one this build reads {sorted(FORMAT_VERSIONS)}")
    if manifest.get("source") not in SOURCES:
        report.error(f"source {manifest.get('source')!r} is not one of {sorted(SOURCES)}")
    for field in ("producer", "created_at"):
        if not manifest.get(field):
            report.error(f"manifest has no {field}")
    if manifest.get("created_at") and not is_timestamp(manifest["created_at"]):
        report.error("manifest created_at is not an ISO instant like 2026-09-13T11:40:00Z")

    limits = manifest.get("limits")
    if not isinstance(limits, list):
        report.error("manifest has no limits list")
    elif not limits:
        # An empty list means a producer that takes everything, which no source allows.
        report.warn("manifest declares no limits at all, which no real source justifies")

    actual = {
        "spaces": len(spaces),
        "users": len(users),
        "channels": len(channels),
        "messages": len(messages),
        "files": len(files),
    }
    counts = manifest.get("counts") or {}
    for name, value in actual.items():
        if name in counts and counts[name] != value:
            report.error(f"manifest counts {counts[name]} {name}, the archive holds {value}")

    for name, declared in (manifest.get("checksums") or {}).items():
        path = archive / name
        if not path.is_file():
            report.error(f"manifest checksums {name}, which is not in the archive")
            continue
        actual_digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if declared != actual_digest:
            report.error(f"{name} does not match its declared checksum")


def _check_spaces(spaces, report) -> None:
    if not spaces:
        report.error("the archive names no space: every conversation has to live in one")
    for identifier, space in spaces.items():
        if not space.get("name"):
            report.error(f"space {identifier}: no name")
        if space.get("visibility") not in VISIBILITIES:
            report.error(f"space {identifier}: visibility {space.get('visibility')!r}")


def _check_users(users, report) -> None:
    for identifier, user in users.items():
        if not isinstance(user.get("display_name"), str) or not user["display_name"]:
            report.error(f"user {identifier}: no display name")
        if not isinstance(user.get("active"), bool):
            report.error(f"user {identifier}: active is not a boolean")
        email = user.get("email", "")
        if not isinstance(email, str):
            report.error(f"user {identifier}: email is not a string")
        elif email and "@" not in email:
            report.error(f"user {identifier}: {email!r} is not an address")


def _check_channels(channels, spaces, users, report) -> None:
    for identifier, channel in channels.items():
        space = channel.get("space")
        if space not in spaces:
            report.error(f"channel {identifier}: space {space!r} is not in spaces.jsonl")
        if channel.get("kind") not in KINDS:
            report.error(f"channel {identifier}: kind {channel.get('kind')!r}")
        if channel.get("visibility") not in VISIBILITIES:
            report.error(f"channel {identifier}: visibility {channel.get('visibility')!r}")
        if not isinstance(channel.get("archived"), bool):
            report.error(f"channel {identifier}: archived is not a boolean")
        members = channel.get("members")
        if not isinstance(members, list):
            report.error(f"channel {identifier}: members is not a list")
            continue
        if len(set(members)) != len(members):
            report.error(f"channel {identifier}: the same person is listed twice")
        for member in members:
            if member not in users:
                report.error(f"channel {identifier}: member {member!r} is not in users.jsonl")
        if channel.get("kind") == "direct" and len(members) < 2:
            report.error(f"channel {identifier}: a direct conversation needs at least two people")
        if channel.get("created_at") is not None and not is_timestamp(channel["created_at"]):
            report.error(f"channel {identifier}: created_at is not an ISO instant")


def _check_messages(messages, channels, users, files, report) -> None:
    for identifier, message in messages.items():
        channel = message.get("channel")
        if channel not in channels:
            report.error(f"message {identifier}: channel {channel!r} is not in channels.jsonl")

        author = message.get("author")
        event = message.get("system_event")
        if event is not None:
            if event not in SYSTEM_EVENTS:
                report.error(f"message {identifier}: system_event {event!r} is not one we have")
            if message.get("body"):
                report.error(
                    f"message {identifier}: a notice carries an event, never a sentence, "
                    "and this one has a body"
                )
        if author is not None and author not in users and not ABSENT_AUTHOR.match(str(author)):
            report.error(f"message {identifier}: author {author!r} is neither an account nor marked absent")
        if author is None and event is None:
            report.error(f"message {identifier}: an ordinary message needs an author")

        if not is_timestamp(message.get("sent_at")):
            report.error(f"message {identifier}: sent_at is not an ISO instant")
        if message.get("edited_at") is not None and not is_timestamp(message["edited_at"]):
            report.error(f"message {identifier}: edited_at is not an ISO instant")

        root = message.get("thread_root")
        if root is not None:
            if root not in messages:
                report.error(f"message {identifier}: thread_root {root!r} is not a message here")
            elif messages[root].get("channel") != channel:
                report.error(f"message {identifier}: its thread root is in another conversation")
            elif messages[root].get("thread_root") is not None:
                report.error(f"message {identifier}: a reply to a reply, which our threads do not have")

        for reaction in message.get("reactions") or []:
            if not isinstance(reaction, dict) or "emoji" not in reaction:
                report.error(f"message {identifier}: a reaction with no emoji")
                continue
            for who in reaction.get("by") or []:
                if who not in users and not ABSENT_AUTHOR.match(str(who)):
                    report.error(f"message {identifier}: reaction by {who!r}, who is not an account")

        for who in message.get("saved_by") or []:
            if who not in users:
                report.error(f"message {identifier}: saved by {who!r}, who is not an account")

        for reference in message.get("files") or []:
            if reference not in files:
                report.error(f"message {identifier}: attachment {reference!r} is not in files.jsonl")


def _check_files(archive, files, messages, report) -> None:
    referenced_blobs: set[str] = set()
    for identifier, entry in files.items():
        checksum = entry.get("hash")
        if not isinstance(checksum, str) or not HASH.match(checksum):
            report.error(f"file {identifier}: hash {checksum!r} is not sha256:<64 hex>")
            continue
        digest = checksum.split(":", 1)[1]
        referenced_blobs.add(digest)
        blob = archive / "blobs" / digest[:2] / digest
        if not blob.is_file():
            report.error(f"file {identifier}: its bytes are not in blobs/")
            continue
        size = entry.get("size")
        if isinstance(size, int) and blob.stat().st_size != size:
            report.error(f"file {identifier}: declares {size} bytes, the blob holds {blob.stat().st_size}")
        if entry.get("uploaded_at") is not None and not is_timestamp(entry["uploaded_at"]):
            report.error(f"file {identifier}: uploaded_at is not an ISO instant")

    blobs_dir = archive / "blobs"
    if blobs_dir.is_dir():
        for blob in blobs_dir.rglob("*"):
            if blob.is_file() and blob.name not in referenced_blobs:
                report.error(f"blobs/{blob.parent.name}/{blob.name} is in the archive and nothing points at it")


def _check_member_state(channels, messages, report) -> None:
    for identifier, channel in channels.items():
        state = channel.get("member_state")
        if state is None:
            continue
        if not isinstance(state, list):
            report.error(f"channel {identifier}: member_state is not a list")
            continue
        seen: set[str] = set()
        members = set(channel.get("members") or [])
        for entry in state:
            who = entry.get("user")
            if who in seen:
                report.error(f"channel {identifier}: two entries for {who!r} in member_state")
            seen.add(who)
            if who not in members:
                report.error(
                    f"channel {identifier}: member_state names {who!r}, who is not a member. "
                    "The producer disagrees with itself about who is in this conversation."
                )
            if "favorite" in entry and not isinstance(entry["favorite"], bool):
                report.error(f"channel {identifier}: favorite for {who!r} is not a boolean")
            if entry.get("favorite") is False:
                report.warn(
                    f"channel {identifier}: an entry for {who!r} says favorite false, which says nothing"
                )
            if "read_at" in entry and not is_timestamp(entry["read_at"]):
                report.error(f"channel {identifier}: read_at for {who!r} is not an ISO instant")
            read_message = entry.get("read_message")
            if read_message is not None and read_message not in messages:
                # Allowed: a position can name a message that did not cross. The importer moves it
                # back to the nearest one it holds.
                report.warn(
                    f"channel {identifier}: {who!r} had read up to {read_message!r}, "
                    "a message that is not in this archive"
                )
            if not ({"favorite", "read_at", "read_message"} & set(entry)):
                report.error(f"channel {identifier}: the entry for {who!r} says nothing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    args = parser.parse_args()

    if not args.archive.is_dir():
        sys.exit(f"{args.archive} is not a directory")

    report = validate(args.archive)
    for warning in report.warnings:
        print(f"warning: {warning}")
    for error in report.errors:
        print(f"error: {error}", file=sys.stderr)

    if report.errors:
        sys.exit(f"\n{args.archive}: {len(report.errors)} problem(s)")
    if report.warnings and args.strict:
        sys.exit(f"\n{args.archive}: {len(report.warnings)} warning(s), and --strict was asked for")
    print(f"{args.archive}: coherent" + (f", {len(report.warnings)} warning(s)" if report.warnings else ""))


if __name__ == "__main__":
    main()
