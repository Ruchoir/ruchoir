#!/usr/bin/env python3
"""Builds a small archive that carries one of everything the format allows.

Its sibling `make-load-archive.py` answers "does the importer survive a real migration"; this one
answers "does every feature actually arrive". It is meant to be read on screen after the import: a
few dozen messages, chosen so that a thread, a pinned message, an edit, a reaction, a saved message,
a favourite, a reading position, an attachment, a notice, an archived conversation, a deactivated
account and a mention are all visible in a couple of minutes of clicking.

Written by hand rather than generated at random, because a demonstration is only worth as much as
the attention paid to what is in it. Deterministic: no clock and no randomness beyond the fixed
content below, so two runs produce the same bytes.
"""

import argparse
import hashlib
import json
import os
import struct
import zlib
from datetime import datetime, timedelta, timezone

# Identifiers carry a prefix for the same reason `make-load-archive.py` takes one: correspondences
# are looked up by source and external reference, and `synthetic` is a source this archive shares
# with every other generated one. A namespace of its own keeps an instance that has already imported
# another generated archive from reading this one as a second run of it.
PREFIX = "demo-"

START = datetime(2026, 3, 2, 9, 12, tzinfo=timezone.utc)


def at(minutes: int) -> str:
    return (START + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def uid(name: str) -> str:
    return f"{PREFIX}{name}"


# --- the people ---------------------------------------------------------------------------------
# Six accounts, each there for a reason: two carry the conversations, one is deactivated (it must
# arrive placed and closed, not silently dropped), one has no address at all (the import screen has
# to call that person out rather than count them quietly), and the rest fill the rooms.

USERS = [
    {"id": uid("camille"), "email": "camille.vilain@demo.test", "display_name": "Camille Vilain",
     "active": True},
    {"id": uid("yanis"), "email": "yanis.berthier@demo.test", "display_name": "Yanis Berthier",
     "active": True},
    {"id": uid("awa"), "email": "awa.diallo@demo.test", "display_name": "Awa Diallo",
     "active": True},
    {"id": uid("mehdi"), "email": "mehdi.haddad@demo.test", "display_name": "Mehdi Haddad",
     "active": True},
    # Deactivated: the account crosses, closed, because the messages it wrote have to stay attributed.
    {"id": uid("claire"), "email": "claire.moreau@demo.test", "display_name": "Claire Moreau",
     "active": False},
    # No address: the source never held one. This is the person the plan screen names, because
    # nobody can be invited without one and inventing an address would be worse than saying so.
    {"id": uid("paul"), "display_name": "Paul Girard", "active": True},
]

EVERYONE = [u["id"] for u in USERS]

# Someone who was in the source and is not in it any more: the contract spells an author like this
# rather than dropping the message, and the interface renders an absent person.
ABSENT = "absent:ancien-stagiaire"


def build(out: str) -> dict:
    os.makedirs(out, exist_ok=True)

    spaces = [
        {"id": uid("atelier"), "name": "Atelier", "description": "L'équipe produit au complet",
         "visibility": "public"},
        # A second space, because an archive that carries one proves nothing about two organisations
        # that were deliberately apart.
        {"id": uid("direction"), "name": "Direction", "description": "Le cercle restreint",
         "visibility": "private"},
    ]

    files, blobs = _files(out)

    channels = [
        # Public, everybody, a topic, favourites and a reading position named by message.
        {"id": uid("atelier/general"), "space": uid("atelier"), "kind": "channel",
         "name": "Général", "topic": "Tout ce qui concerne l'atelier, sans cérémonie",
         "visibility": "public", "archived": False, "created_at": at(0),
         "members": EVERYONE,
         "member_state": [
             {"user": uid("camille"), "favorite": True, "read_message": uid("m0012")},
             {"user": uid("yanis"), "read_message": uid("m0008")},
         ]},
        # Private, a reading position known only as a moment: the importer resolves it to the last
        # message sent at or before it.
        {"id": uid("atelier/produit"), "space": uid("atelier"), "kind": "channel",
         "name": "Produit", "topic": "Décisions, arbitrages, dates",
         "visibility": "private", "archived": False, "created_at": at(1),
         "members": [uid("camille"), uid("yanis"), uid("awa"), uid("claire")],
         "member_state": [
             {"user": uid("awa"), "favorite": True, "read_at": at(300)},
         ]},
        # Archived: it arrives closed, and its history stays readable.
        {"id": uid("atelier/refonte-2025"), "space": uid("atelier"), "kind": "channel",
         "name": "Refonte 2025", "topic": "Terminé, gardé pour l'historique",
         "visibility": "public", "archived": True, "created_at": at(2),
         "members": [uid("camille"), uid("claire"), uid("mehdi")],
         "member_state": []},
        {"id": uid("direction/comex"), "space": uid("direction"), "kind": "channel",
         "name": "Comex", "topic": "", "visibility": "private", "archived": False,
         "created_at": at(3),
         "members": [uid("camille"), uid("awa")],
         "member_state": [{"user": uid("camille"), "favorite": True}]},
        # A direct conversation belongs to the space its two people shared.
        {"id": uid("direct:camille+yanis"), "space": uid("atelier"), "kind": "direct",
         "name": "", "topic": "", "visibility": "private", "archived": False,
         "created_at": at(4),
         "members": [uid("camille"), uid("yanis")],
         "member_state": [{"user": uid("yanis"), "read_at": at(420)}]},
    ]

    messages = _messages(files)

    checksums = {}
    for name, rows in (
        ("spaces.jsonl", spaces),
        ("users.jsonl", USERS),
        ("channels.jsonl", channels),
        ("messages.jsonl", messages),
        ("files.jsonl", files),
    ):
        checksums[name] = _write(out, name, rows)

    manifest = {
        "format_version": 1,
        "source": "synthetic",
        "source_version": "demonstration archive, hand-written",
        "producer": "ruchoir-make-demo-archive 0.1.0",
        "created_at": at(0),
        "counts": {"spaces": len(spaces), "users": len(USERS), "channels": len(channels),
                   "messages": len(messages), "files": len(files)},
        "checksums": checksums,
        "limits": [
            "This archive is written to be looked at, not exported: every person, message and "
            "file in it is invented, and nothing here comes from a real workspace.",
            "One account arrives without an address, deliberately: it cannot be invited and the "
            "import screen has to say so.",
        ],
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    return {**manifest["counts"], "blobs": blobs}


def _messages(files) -> list:
    """Every message in the archive, in the order a reader meets them."""
    by_name = {f["name"]: f["id"] for f in files}
    rows = []

    def say(ident, channel, author, minute, body, **extra):
        row = {
            "id": uid(ident), "channel": uid(channel), "author": author,
            "sent_at": at(minute), "body": body, "format": "markdown",
            "system_event": None, "thread_root": None, "pinned": False, "edited_at": None,
            "reactions": [], "files": [], "saved_by": [],
        }
        row.update(extra)
        rows.append(row)
        return row

    def notice(ident, channel, author, minute, event):
        rows.append({
            "id": uid(ident), "channel": uid(channel), "author": author, "sent_at": at(minute),
            "body": "", "format": "markdown", "system_event": event, "thread_root": None,
            "pinned": False, "edited_at": None, "reactions": [], "files": [], "saved_by": [],
        })

    # --- Général: the room where most of the features are visible at once ------------------------
    # The notices first, because a conversation that opens on neither its creation nor its arrivals
    # reads as if it had been cut. All seven the contract allows appear across this archive.
    notice("m0001", "atelier/general", None, 0, "channel_created")
    notice("m0002", "atelier/general", uid("camille"), 1, "channel_joined")
    notice("m0003", "atelier/general", uid("yanis"), 2, "member_joined")
    notice("m0004", "atelier/general", uid("awa"), 3, "member_joined")

    say("m0005", "atelier/general", uid("camille"), 5,
        "Bonjour à toutes et à tous. On ouvre l'atelier ici : **tout ce qui concerne le produit "
        "passe dans ce salon**, et rien d'important ne se décide ailleurs.")

    # A pinned message, kept in view: Markdown in full, so the rendering can be judged on something
    # other than a sentence.
    say("m0006", "atelier/general", uid("camille"), 8,
        "## Comment on travaille\n\n"
        "1. Une décision se prend ici, pas en message direct.\n"
        "2. Ce qui est *urgent* est épinglé, le reste attend.\n"
        "3. On relit avant d'envoyer : `git commit --amend` existe, les messages non.\n\n"
        "> Une équipe qui documente ses règles les applique deux fois mieux.\n\n"
        "Le détail est dans [le guide interne](https://exemple.test/guide).",
        pinned=True,
        reactions=[{"emoji": "👍", "by": [uid("yanis"), uid("awa"), uid("mehdi")]},
                   {"emoji": "🎉", "by": [uid("awa")]}],
        saved_by=[uid("yanis"), uid("awa")])

    # A mention, spelled as the contract requires: the source identifier of the person, never the
    # vendor's syntax. The importer turns it into something the product resolves.
    say("m0007", "atelier/general", uid("yanis"), 12,
        f"@{uid('camille')} c'est noté. Je reprends le point sur les délais demain matin.",
        reactions=[{"emoji": "✅", "by": [uid("camille")]}])

    # A message edited after the fact.
    say("m0008", "atelier/general", uid("awa"), 15,
        "La maquette est prête, je la mets ici. Version **3** (la 2 avait le mauvais logo).",
        edited_at=at(17), files=[by_name["maquette-accueil.png"]],
        reactions=[{"emoji": "😍", "by": [uid("camille"), uid("yanis")]}])

    # A thread: a root and its replies, one level deep, which is all our threads have.
    root = say("m0009", "atelier/general", uid("mehdi"), 20,
               "Question ouverte : on garde la semaine de quatre jours pour l'astreinte ?")
    say("m0010", "atelier/general", uid("camille"), 22,
        "Oui, et on en reparle au prochain point.", thread_root=root["id"])
    say("m0011", "atelier/general", uid("awa"), 24,
        "D'accord avec Camille. Ça tient depuis six mois sans incident.",
        thread_root=root["id"], reactions=[{"emoji": "💯", "by": [uid("mehdi")]}])
    say("m0012", "atelier/general", uid("yanis"), 26,
        "Pareil. Je note le point pour l'ordre du jour.", thread_root=root["id"])

    # A broadcast handle, which the product resolves like a name.
    say("m0013", "atelier/general", uid("camille"), 30,
        "@canal petit rappel : la réunion de lundi passe à 10h.",
        reactions=[{"emoji": "👀", "by": [uid("yanis"), uid("mehdi"), uid("awa")]}])

    # Somebody who left the company before the export: the message stays, attributed to an absent
    # person rather than to nobody.
    say("m0014", "atelier/general", ABSENT, 34,
        "J'ai laissé le compte rendu de l'atelier dans les fichiers, bonne continuation à tous.",
        files=[by_name["compte-rendu.md"]],
        reactions=[{"emoji": "❤️", "by": [uid("camille"), ABSENT]}])

    notice("m0015", "atelier/general", uid("mehdi"), 36, "member_left")

    # --- Produit: the private room ---------------------------------------------------------------
    notice("m0016", "atelier/produit", None, 40, "channel_created")
    say("m0017", "atelier/produit", uid("camille"), 42,
        f"@{uid('awa')} @{uid('yanis')} on tranche ici la date de la migration.")
    say("m0018", "atelier/produit", uid("awa"), 45,
        "Je propose le 14. Les chiffres du trimestre sont dans le tableau :",
        files=[by_name["trimestre.csv"]],
        saved_by=[uid("camille")])
    say("m0019", "atelier/produit", uid("yanis"), 48,
        "Le 14 me va. Une seule réserve, la bascule des accès :\n\n"
        "```bash\nruchoir-api import archive.tar.gpg admin@exemple.test\n```\n\n"
        "il faut que quelqu'un soit devant l'écran ce jour-là.",
        pinned=True,
        reactions=[{"emoji": "🙌", "by": [uid("camille"), uid("awa")]}])
    # A message from the deactivated account: it arrives attributed, not anonymised.
    say("m0020", "atelier/produit", uid("claire"), 52,
        "Je passe la main sur ce sujet, Awa reprend le suivi. Merci à tous.",
        reactions=[{"emoji": "🫶", "by": [uid("camille"), uid("awa"), uid("yanis")]}],
        saved_by=[uid("awa")])
    notice("m0021", "atelier/produit", uid("claire"), 53, "member_removed")

    # --- Refonte 2025: archived, and still readable ----------------------------------------------
    notice("m0022", "atelier/refonte-2025", None, 60, "channel_created")
    say("m0023", "atelier/refonte-2025", uid("claire"), 62,
        "Bilan de la refonte : **livrée**, deux semaines après la date, sans incident en "
        "production.", files=[by_name["bilan-refonte.txt"]])
    say("m0024", "atelier/refonte-2025", uid("mehdi"), 64,
        "Beau travail. On archive le salon ?",
        reactions=[{"emoji": "👍", "by": [uid("camille")]}])
    notice("m0025", "atelier/refonte-2025", uid("mehdi"), 66, "channel_left")
    notice("m0026", "atelier/refonte-2025", uid("claire"), 67, "channel_removed")

    # --- Comex: the second space ------------------------------------------------------------------
    say("m0027", "direction/comex", uid("camille"), 70,
        "Point budget avant le comité : la migration tient dans l'enveloppe.")
    say("m0028", "direction/comex", uid("awa"), 72,
        "Parfait. Je prépare une note d'une page.", saved_by=[uid("camille")])

    # --- The direct conversation --------------------------------------------------------------
    say("m0029", "direct:camille+yanis", uid("yanis"), 80,
        "Tu as deux minutes cet après-midi ? C'est au sujet de l'astreinte.")
    say("m0030", "direct:camille+yanis", uid("camille"), 82,
        "Oui, après 15h. Envoie-moi le fichier en attendant.",
        reactions=[{"emoji": "👌", "by": [uid("yanis")]}])
    say("m0031", "direct:camille+yanis", uid("yanis"), 84,
        "Le voilà.", files=[by_name["astreinte.pdf"]])

    return rows


# --- the bytes ------------------------------------------------------------------------------------
# Five files, of five kinds, because the files screen shows a type and a preview and one text file
# repeated five times would say nothing about either. The bytes are generated here rather than
# carried in the repository: a fixture nobody can regenerate rots.

def _files(out: str):
    entries = [
        ("maquette-accueil.png", "image/png", _png(), uid("awa"), 15,
         "atelier/general", "Design/maquette-accueil.png"),
        ("compte-rendu.md", "text/markdown", _compte_rendu(), ABSENT, 34,
         "atelier/general", "Documents/compte-rendu.md"),
        ("trimestre.csv", "text/csv", _trimestre(), uid("awa"), 45,
         "atelier/produit", "Documents/trimestre.csv"),
        ("bilan-refonte.txt", "text/plain", _bilan(), uid("claire"), 62,
         "atelier/refonte-2025", "Documents/bilan-refonte.txt"),
        ("astreinte.pdf", "application/pdf", _pdf(), uid("yanis"), 84,
         "direct:camille+yanis", "Documents/astreinte.pdf"),
    ]

    files = []
    for index, (name, kind, body, who, minute, channel, path) in enumerate(entries):
        digest = hashlib.sha256(body).hexdigest()
        directory = os.path.join(out, "blobs", digest[:2])
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, digest), "wb") as fh:
            fh.write(body)
        files.append({
            "id": uid(f"f{index:04d}"), "name": name, "path": path, "size": len(body),
            "content_type": kind, "hash": "sha256:" + digest, "channel": uid(channel),
            "uploaded_by": who, "uploaded_at": at(minute),
        })
    return files, len(entries)


def _png() -> bytes:
    """A 240x120 image, drawn here so the archive carries a real picture and not a placeholder."""
    width, height = 240, 120
    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: none
        for x in range(width):
            # A diagonal wash between the two product colours, with a band across the middle so the
            # thumbnail is recognisable at any size.
            t = (x / width + y / height) / 2
            band = 52 <= y <= 68
            rows += bytes((
                255 if band else int(198 + (247 - 198) * t),
                255 if band else int(93 + (231 - 93) * t),
                255 if band else int(69 + (214 - 69) * t),
            ))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def _compte_rendu() -> bytes:
    return (
        "# Atelier du 2 mars\n\n"
        "Présents : Camille, Yanis, Awa, Mehdi.\n\n"
        "## Décisions\n\n"
        "- La migration est fixée au 14.\n"
        "- L'astreinte reste sur quatre jours.\n"
        "- Le guide interne est relu avant la fin du mois.\n\n"
        "## À faire\n\n"
        "| Qui | Quoi | Quand |\n"
        "| --- | --- | --- |\n"
        "| Awa | Note d'une page | Vendredi |\n"
        "| Yanis | Bascule des accès | Le 14 |\n"
    ).encode("utf-8")


def _trimestre() -> bytes:
    lines = ["mois,inscriptions,messages,fichiers",
             "janvier,128,14302,411",
             "février,141,15877,463",
             "mars,163,17210,502"]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _bilan() -> bytes:
    return (
        "Bilan de la refonte 2025\n"
        "========================\n\n"
        "Livrée le 28 février, deux semaines après la date annoncée.\n"
        "Aucun incident en production sur les trente jours suivants.\n"
        "Trois enseignements : estimer large, livrer par morceaux, relire à deux.\n"
    ).encode("utf-8")


def _pdf() -> bytes:
    """A one-page PDF, assembled here rather than carried: the offsets in its table have to match
    the bytes, so it is built object by object and the table is written from what was measured."""
    text = b"BT /F1 18 Tf 62 720 Td (Planning d'astreinte - semaine 11) Tj ET\n" \
           b"BT /F1 12 Tf 62 690 Td (Lundi au mercredi : Yanis Berthier) Tj ET\n" \
           b"BT /F1 12 Tf 62 672 Td (Jeudi au dimanche : Mehdi Haddad) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(text)).encode() + b" >>\nstream\n" + text + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"

    table = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\n"
            b"startxref\n" + str(table).encode() + b"\n%%EOF\n")
    return bytes(out)


def _write(out: str, name: str, rows: list) -> str:
    path = os.path.join(out, name)
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(path, "rb") as fh:
        return "sha256:" + hashlib.sha256(fh.read()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out")
    args = parser.parse_args()
    print(json.dumps(build(args.out), ensure_ascii=False))


if __name__ == "__main__":
    main()
