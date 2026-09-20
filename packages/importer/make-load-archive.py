#!/usr/bin/env python3
"""Builds a large canonical archive, to run the importer against something the size of a real
migration rather than a fixture.

Deterministic: the same seed produces byte-identical output, so two runs can be compared and a
failure can be reproduced. Everything it writes is synthetic; no real export is ever needed.
"""

import argparse
import hashlib
import json
import os
import random
from datetime import datetime, timedelta, timezone

FIRST = ["Camille", "Louis", "Yasmine", "Théo", "Awa", "Mehdi", "Claire", "Jonas", "Inès", "Paul",
         "Nadia", "Hugo", "Salomé", "Karim", "Élodie", "Marc", "Anaïs", "Tarek", "Julie", "Rémi"]
LAST = ["Vilain", "Bertrand", "Nguyen", "Diallo", "Moreau", "Costa", "Lambert", "Haddad", "Roux",
        "Petit", "Girard", "Benali", "Fontaine", "Marchand", "Leroy", "Sow", "Perrin", "Chevalier"]
TOPICS = ["produit", "support", "recrutement", "infra", "design", "compta", "veille", "incidents",
          "clients", "roadmap", "qualité", "logistique", "juridique", "presse", "astreinte"]
WORDS = ("le dossier passe en revue demain matin avec les chiffres consolidés du trimestre et une "
         "note sur les délais de livraison que personne ne trouve raisonnable pour l instant "
         "il faudra trancher avant vendredi sinon la migration glisse encore d une semaine").split()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--spaces", type=int, default=4)
    ap.add_argument("--users", type=int, default=250)
    ap.add_argument("--channels", type=int, default=350)
    ap.add_argument("--directs", type=int, default=50)
    ap.add_argument("--messages", type=int, default=120_000)
    ap.add_argument("--files", type=int, default=600)
    ap.add_argument("--file-bytes", type=int, default=700_000)
    ap.add_argument("--seed", type=int, default=7)
    # Every archive this script writes declares the same source, because `synthetic` is one of the
    # five the contract allows and inventing a sixth to separate two test archives would put a false
    # source in every mapping a run records. The identifiers are the half of the key left to
    # separate them with: correspondences are looked up by source *and* external reference, so two
    # archives that share both are read as one archive imported twice, and the second run resumes
    # the first one's work against rows that may no longer exist. A prefix of its own gives an
    # archive a namespace of its own on an instance that has already imported another.
    ap.add_argument("--id-prefix", default="",
                    help="prepended to every identifier, to keep two generated archives from "
                         "being read as two runs of the same one")
    a = ap.parse_args()

    rng = random.Random(a.seed)
    out = a.out
    os.makedirs(out, exist_ok=True)

    def write(name, rows):
        path = os.path.join(out, name)
        with open(path, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        with open(path, "rb") as fh:
            return "sha256:" + sha(fh.read())

    start = datetime(2024, 1, 8, 9, 0, tzinfo=timezone.utc)

    def when(step):
        return (start + timedelta(minutes=step * 7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Spaces.
    space_ids = [f"{a.id_prefix}espace-{i + 1}" for i in range(a.spaces)]
    spaces = [{"id": s, "name": f"Espace {i + 1}", "description": f"Import de charge, espace {i + 1}",
               "visibility": "private" if i % 3 == 2 else "public"}
              for i, s in enumerate(space_ids)]

    # Accounts. A tenth have no address at all: those are the ones the screen must call out rather
    # than count quietly, and a run of this size is where that path is worth exercising.
    users = []
    for i in range(a.users):
        uid = f"{a.id_prefix}u{i:04d}"
        name = f"{FIRST[i % len(FIRST)]} {LAST[(i // len(FIRST)) % len(LAST)]}"
        row = {"id": uid, "display_name": name, "active": i % 17 != 0}
        if i % 10 != 3:
            row["email"] = f"{uid}@charge.test"
        users.append(row)
    uids = [u["id"] for u in users]

    # Conversations.
    channels = []
    for i in range(a.channels):
        space = space_ids[i % a.spaces]
        members = rng.sample(uids, rng.randint(3, min(40, a.users)))
        channels.append({
            "id": f"{space}/c{i:04d}",
            "space": space,
            "kind": "channel",
            "name": f"{TOPICS[i % len(TOPICS)]}-{i:03d}",
            "topic": "" if i % 4 else "Sujet du salon, pour vérifier que le texte suit",
            "visibility": "private" if i % 5 == 0 else "public",
            "archived": i % 23 == 0,
            "created_at": when(i),
            "members": members,
            # `favorite: false` says nothing that its absence does not, and the contract rejects it.
            "member_state": [
                {"user": m, "read_at": when(i + 50), **({"favorite": True} if rng.random() < 0.15 else {})}
                for m in members[:8]
            ],
        })
    for i in range(a.directs):
        pair = rng.sample(uids, 2)
        channels.append({
            "id": f"{a.id_prefix}direct/d{i:04d}", "space": space_ids[i % a.spaces], "kind": "direct",
            "name": "", "topic": "", "visibility": "private", "archived": False,
            "created_at": when(i), "members": pair,
            "member_state": [{"user": pair[0], "read_at": when(i + 3)}],
        })
    chan_ids = [c["id"] for c in channels]

    # Files, and their bytes. Written first so messages can point at them.
    files = []
    for i in range(a.files):
        # Half of them are text and compress away to nothing, half are opaque bytes that do not:
        # a sealed archive of only compressible files is a fraction of its own size, and would say
        # nothing about how the chain behaves when several hundred megabytes actually travel.
        if i % 2:
            body = f"Pièce jointe {i}\n".encode() + rng.randbytes(a.file_bytes)
            name, kind = f"capture-{i:04d}.bin", "application/octet-stream"
        else:
            body = f"Pièce jointe {i}\n".encode() + (f" ligne {i} ".encode() * (a.file_bytes // 12))
            name, kind = f"rapport-{i:04d}.txt", "text/plain"
        digest = sha(body)
        blob_dir = os.path.join(out, "blobs", digest[:2])
        os.makedirs(blob_dir, exist_ok=True)
        with open(os.path.join(blob_dir, digest), "wb") as fh:
            fh.write(body)
        chan = chan_ids[i % len(chan_ids)]
        files.append({
            "id": f"{a.id_prefix}f{i:04d}", "name": name, "path": f"documents/{name}",
            "size": len(body), "content_type": kind, "hash": "sha256:" + digest,
            "channel": chan, "uploaded_by": rng.choice(uids), "uploaded_at": when(i),
        })

    by_channel = {}
    for f in files:
        by_channel.setdefault(f["channel"], []).append(f["id"])

    # Messages. Threads, reactions, pins, edits and saves all appear, because a load run that only
    # exercises the simple path proves nothing about the passes that follow the first.
    messages = []
    roots = {}
    for i in range(a.messages):
        chan = channels[i % len(channels)]
        cid = chan["id"]
        author = rng.choice(chan["members"])

        # A notice is a different shape, not an ordinary message with its body emptied: nobody
        # pins "Bob joined the channel", edits it, keeps it, reacts to it or attaches a file to it,
        # and the contract refuses several of those outright. Building it separately is the only
        # way the decorations below cannot land on one by arithmetic coincidence.
        if i % 200 == 0:
            messages.append({
                "id": f"{a.id_prefix}m{i:06d}", "channel": cid, "author": author, "sent_at": when(i),
                "body": "", "format": "markdown", "system_event": "channel_joined",
                "thread_root": None, "pinned": False, "edited_at": None,
                "reactions": [], "files": [], "saved_by": [],
            })
            continue

        row = {
            "id": f"{a.id_prefix}m{i:06d}", "channel": cid, "author": author, "sent_at": when(i),
            "body": " ".join(rng.choices(WORDS, k=rng.randint(4, 40))), "format": "markdown",
            "system_event": None, "thread_root": None, "pinned": i % 500 == 0, "edited_at": None,
            "reactions": [], "files": [], "saved_by": [],
        }
        previous = roots.get(cid)
        if previous and rng.random() < 0.25:
            row["thread_root"] = previous
        elif rng.random() < 0.1:
            roots[cid] = row["id"]
        if i % 7 == 0:
            # `by`, as the contract spells it, and the character rather than a name.
            row["reactions"] = [{"emoji": e, "by": rng.sample(chan["members"], min(3, len(chan["members"])))}
                                for e in rng.sample(["👍", "🎉", "😀", "❤️"], rng.randint(1, 2))]
        if i % 40 == 0:
            row["saved_by"] = rng.sample(chan["members"], 1)
        if i % 60 == 0:
            row["edited_at"] = when(i + 1)
        messages.append(row)

    # Attachments are hung on afterwards rather than during, because a message and a file only meet
    # if they are in the same conversation, and testing that with a modulus made it a coincidence:
    # on a small archive it stopped happening at all and nothing exercised the pass that links
    # them. Every third file is attached to the first ordinary message of its own conversation.
    first_ordinary: dict[str, dict] = {}
    for row in messages:
        if row["system_event"] is None:
            first_ordinary.setdefault(row["channel"], row)
    for n, f in enumerate(files):
        host = first_ordinary.get(f["channel"])
        if host is not None and n % 3 == 0:
            host["files"].append(f["id"])

    checksums = {
        "spaces.jsonl": write("spaces.jsonl", spaces),
        "users.jsonl": write("users.jsonl", users),
        "channels.jsonl": write("channels.jsonl", channels),
        "messages.jsonl": write("messages.jsonl", messages),
        "files.jsonl": write("files.jsonl", files),
    }

    manifest = {
        "format_version": 1,
        "source": "synthetic",
        "source_version": f"load generator, seed {a.seed}",
        "producer": "ruchoir-make-load-archive 0.1.0",
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "counts": {"spaces": len(spaces), "users": len(users), "channels": len(channels),
                   "messages": len(messages), "files": len(files)},
        "checksums": checksums,
        "limits": [
            "This archive is generated, not exported: every name, address and message in it is "
            "invented, and nothing here comes from a real workspace.",
            "A tenth of the accounts deliberately carry no address, to exercise the accounts that "
            "arrive placed and cannot be invited.",
        ],
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(json.dumps(manifest["counts"]))


if __name__ == "__main__":
    main()
