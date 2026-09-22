"""Shared plumbing for the importer tests.

The two scripts under test have dashes in their names, because they are commands rather than
modules, so they are loaded by path instead of imported.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
from types import ModuleType

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent


def load(script: str) -> ModuleType:
    path = PACKAGE / script
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    assert spec and spec.loader, f"cannot load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_export(directory: Path, rows: list[dict]) -> Path:
    """Writes a Mattermost bulk export: import.jsonl plus its data tree."""
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "import.jsonl").open("w", encoding="utf-8") as sink:
        for row in rows:
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")
    return directory


def add_attachment(export: Path, relative: str, content: bytes = b"hello") -> str:
    path = export / "data" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return relative


def read_jsonl(archive: Path, name: str) -> list[dict]:
    return [json.loads(l) for l in (archive / name).read_text(encoding="utf-8").splitlines() if l.strip()]


def by_id(archive: Path, name: str) -> dict[str, dict]:
    return {row["id"]: row for row in read_jsonl(archive, name)}


# --- a minimal archive, valid by construction, for the validator's tests -------------------------

def blob(archive: Path, content: bytes) -> str:
    checksum = hashlib.sha256(content).hexdigest()
    path = archive / "blobs" / checksum[:2] / checksum
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return checksum


def build_archive(root: Path, **overrides) -> Path:
    """A small archive holding one of everything the contract allows."""
    archive = root / "archive"
    archive.mkdir(parents=True, exist_ok=True)
    content = b"a note"
    checksum = blob(archive, content)

    data = {
        "spaces": [{"id": "atelier", "name": "Atelier", "description": "", "visibility": "public"}],
        "users": [
            {"id": "alice", "email": "alice@example.org", "display_name": "Alice", "active": True},
            {"id": "bob", "email": "bob@example.org", "display_name": "Bob", "active": True},
        ],
        "channels": [
            {
                "id": "atelier/general",
                "space": "atelier",
                "kind": "channel",
                "name": "General",
                "topic": "",
                "visibility": "public",
                "archived": False,
                "members": ["alice", "bob"],
                "created_at": "2026-09-13T10:00:00Z",
                "member_state": [{"user": "alice", "favorite": True, "read_message": "m1"}],
            }
        ],
        "messages": [
            {
                "id": "m1",
                "channel": "atelier/general",
                "author": "alice",
                "sent_at": "2026-09-13T10:01:00Z",
                "body": "bonjour",
                "format": "markdown",
                "thread_root": None,
                "pinned": True,
                "edited_at": None,
                "reactions": [{"emoji": "\U0001f389", "by": ["bob"]}],
                "files": ["note.txt"],
                "saved_by": ["bob"],
            },
            {
                "id": "m2",
                "channel": "atelier/general",
                "author": "bob",
                "sent_at": "2026-09-13T10:02:00Z",
                "body": "une réponse",
                "format": "markdown",
                "thread_root": "m1",
                "pinned": False,
                "edited_at": None,
                "reactions": [],
                "files": [],
            },
            {
                "id": "m3",
                "channel": "atelier/general",
                "author": "bob",
                "sent_at": "2026-09-13T10:00:30Z",
                "body": "",
                "format": "markdown",
                "system_event": "channel_joined",
                "thread_root": None,
                "pinned": False,
                "edited_at": None,
                "reactions": [],
                "files": [],
            },
        ],
        "files": [
            {
                "id": "note.txt",
                "name": "note.txt",
                "path": "note.txt",
                "size": len(content),
                "content_type": "text/plain",
                "hash": f"sha256:{checksum}",
                "channel": None,
                "uploaded_by": "alice",
                "uploaded_at": "2026-09-13T10:01:00Z",
            }
        ],
    }
    data.update(overrides)

    for name, rows in data.items():
        with (archive / f"{name}.jsonl").open("w", encoding="utf-8") as sink:
            for row in rows:
                sink.write(json.dumps(row, ensure_ascii=False) + "\n")

    manifest = {
        "format_version": 1,
        "source": "mattermost",
        "source_version": "10.5",
        "producer": "test",
        "created_at": "2026-09-13T10:05:00Z",
        "counts": {name: len(rows) for name, rows in data.items()},
        "checksums": {
            f"{name}.jsonl": "sha256:"
            + hashlib.sha256((archive / f"{name}.jsonl").read_bytes()).hexdigest()
            for name in data
        },
        "limits": ["nothing in particular"],
    }
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return archive


def rewrite(archive: Path, name: str, rows: list[dict]) -> None:
    """Replaces a file and repairs the manifest, so a test changes one thing at a time."""
    with (archive / name).open("w", encoding="utf-8") as sink:
        for row in rows:
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest = json.loads((archive / "manifest.json").read_text(encoding="utf-8"))
    manifest["counts"][name.removesuffix(".jsonl")] = len(rows)
    manifest["checksums"][name] = "sha256:" + hashlib.sha256((archive / name).read_bytes()).hexdigest()
    (archive / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
