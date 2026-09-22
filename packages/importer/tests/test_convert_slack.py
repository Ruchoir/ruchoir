"""What the Slack adapter must get right, one behaviour at a time.

Every case here is either something a real export taught us (Slack's own markup, mentions written
as `<@U123>`, replies broadcast to the channel, an export that signs its own file links) or
something that would silently lose data if it broke.

The fixtures are shaped like the export they were read from: Slack export format 2, taken from a
real workspace in September 2026. That export itself is not in the repository, because it holds
somebody's real messages and files; what it taught is here instead.
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from helpers import by_id, load, read_jsonl

converter = load("convert-slack.py")
validator = load("validate-archive.py")

TS = "1789922686.000100"  # a fixed instant, so the tests do not depend on the clock


def user(uid: str, name: str, **extra) -> dict:
    profile = {"real_name": name.capitalize(), "email": f"{name}@seed.local"}
    profile.update(extra.pop("profile", {}))
    return {"id": uid, "name": name, "profile": profile, "deleted": False, **extra}


def channel(cid: str, name: str, members: list[str], **extra) -> dict:
    return {
        "id": cid,
        "name": name,
        "created": 1789900000,
        "creator": members[0] if members else None,
        "is_archived": False,
        "members": members,
        "topic": {"value": ""},
        "purpose": {"value": ""},
        **extra,
    }


def message(text: str, author: str = "U1", ts: str = TS, **extra) -> dict:
    return {"type": "message", "user": author, "text": text, "ts": ts, **extra}


class ConverterCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def convert(self, *, users=None, channels=None, days=None, fetch=None, space="Slack") -> Path:
        """Writes an export, converts it, and hands back the archive.

        `fetch` stands in for the network: the adapter is the only producer that downloads
        anything, and a test suite that reached Slack would be a test of Slack.
        """
        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        users = users if users is not None else [user("U1", "alice"), user("U2", "bob")]
        channels = channels if channels is not None else [channel("C1", "general", ["U1", "U2"])]
        (export / "users.json").write_text(json.dumps(users), encoding="utf-8")
        (export / "channels.json").write_text(json.dumps(channels), encoding="utf-8")
        for name, payload in (days or {}).items():
            directory = export / name
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "2026-09-20.json").write_text(json.dumps(payload), encoding="utf-8")

        out = self.root / "archive"
        instance = converter.Converter(export, out, space)
        instance.read()
        if fetch is None:
            instance.files.clear()
            instance.write(fetched=False)
        else:
            out.mkdir(parents=True, exist_ok=True)
            instance._download = fetch  # noqa: SLF001 - standing in for the network
            # The converter narrates its downloads for whoever is watching a migration run; a test
            # suite is not that person.
            with contextlib.redirect_stdout(io.StringIO()):
                instance.fetch_files(None)
            instance.write(fetched=True)
        return out

    # -- people and rooms --------------------------------------------------------------------
    def test_an_account_is_identified_by_its_slack_id_not_its_handle(self) -> None:
        """Messages reference people by id, and a handle freed by somebody leaving can be taken."""
        out = self.convert(users=[user("U1", "alice")], channels=[channel("C1", "general", ["U1"])])
        accounts = by_id(out, "users.jsonl")
        self.assertIn("U1", accounts)
        self.assertEqual(accounts["U1"]["display_name"], "Alice")
        self.assertEqual(accounts["U1"]["email"], "alice@seed.local")

    def test_a_deactivated_account_arrives_marked_as_such(self) -> None:
        people = [user("U1", "alice"), dict(user("U2", "bob"), deleted=True)]
        accounts = by_id(self.convert(users=people), "users.jsonl")
        self.assertTrue(accounts["U1"]["active"])
        self.assertFalse(accounts["U2"]["active"])

    def test_an_app_is_not_an_account_and_its_posts_are_marked_absent(self) -> None:
        """A bot is not a person: giving it an account would invite it by email later."""
        people = [user("U1", "alice"), dict(user("B1", "buildbot"), is_bot=True)]
        out = self.convert(
            users=people,
            channels=[channel("C1", "general", ["U1", "B1"])],
            days={"general": [message("deployed", author="B1")]},
        )
        self.assertNotIn("B1", by_id(out, "users.jsonl"))
        self.assertEqual(by_id(out, "channels.jsonl")["C1"]["members"], ["U1"])
        body = [m for m in read_jsonl(out, "messages.jsonl") if m["body"] == "deployed"][0]
        self.assertTrue(body["author"].startswith("absent:"))

    def test_a_conversation_opens_on_its_creation(self) -> None:
        """Slack holds it on the channel rather than as a message, but it is still its own word."""
        out = self.convert(days={"general": []})
        notices = [m for m in read_jsonl(out, "messages.jsonl") if m.get("system_event")]
        self.assertEqual([n["system_event"] for n in notices], ["channel_created"])
        self.assertEqual(notices[0]["author"], "U1")

    def test_arrivals_cross_as_notices_and_the_rest_is_dropped(self) -> None:
        out = self.convert(
            days={
                "general": [
                    message("<@U2> a rejoint le canal", author="U2", subtype="channel_join"),
                    message("a changé le nom du canal", subtype="channel_name"),
                ]
            }
        )
        events = [m["system_event"] for m in read_jsonl(out, "messages.jsonl") if m.get("system_event")]
        self.assertEqual(sorted(events), ["channel_created", "channel_joined"])
        limits = " ".join(json.loads((out / "manifest.json").read_text())["limits"])
        self.assertIn("channel_name", limits)

    # -- what people wrote --------------------------------------------------------------------
    def test_slack_markup_becomes_markdown(self) -> None:
        """One asterisk is bold there and italic here: a message crossing unconverted comes out
        emphasised where it was strong, in every imported workspace."""
        out = self.convert(days={"general": [message("*gras* ~barré~ _italique_\n• un")]})
        body = read_jsonl(out, "messages.jsonl")[-1]["body"]
        self.assertEqual(body, "**gras** ~~barré~~ _italique_\n- un")

    def test_a_mention_crosses_as_the_source_identifier(self) -> None:
        out = self.convert(days={"general": [message("hello <@U2> and <!here>")]})
        self.assertEqual(read_jsonl(out, "messages.jsonl")[-1]["body"], "hello @{U2} and @channel")

    def test_a_link_keeps_its_label(self) -> None:
        out = self.convert(days={"general": [message("see <https://ruchoir.fr|the site> and <https://b.fr>")]})
        self.assertEqual(
            read_jsonl(out, "messages.jsonl")[-1]["body"],
            "see [the site](https://ruchoir.fr) and https://b.fr",
        )

    def test_code_is_left_alone_but_still_unescaped(self) -> None:
        """Found in a real export: Slack escapes `<`, `>` and `&` inside a snippet too, and the
        first version shipped an archive holding `buis&lt;vfyifevhfv` where a `<` had been typed.
        The protection that keeps `*ptr` from becoming bold must not keep the escape either."""
        out = self.convert(days={"general": [message("`a &lt; b` and *bold*\n```x &amp;&amp; y```")]})
        self.assertEqual(
            read_jsonl(out, "messages.jsonl")[-1]["body"],
            "`a < b` and **bold**\n```x && y```",
        )

    def test_text_that_looks_like_a_mention_stays_text(self) -> None:
        """Somebody typing `<@U2>` as text has it escaped by Slack; unescaping before the rewriting
        would turn it into a mention of a real person."""
        out = self.convert(days={"general": [message("write &lt;@U2&gt; to mention")]})
        self.assertEqual(read_jsonl(out, "messages.jsonl")[-1]["body"], "write <@U2> to mention")

    def test_a_reply_points_at_its_root_and_a_broadcast_is_still_a_reply(self) -> None:
        root = message("question", ts="1789922686.000100", reply_count=2)
        reply = message("answer", ts="1789922687.000200", thread_ts="1789922686.000100")
        shown = message(
            "also here", ts="1789922688.000300", thread_ts="1789922686.000100", subtype="thread_broadcast"
        )
        out = self.convert(days={"general": [root, reply, shown]})
        rows = {m["body"]: m for m in read_jsonl(out, "messages.jsonl") if m["body"]}
        self.assertIsNone(rows["question"]["thread_root"])
        self.assertEqual(rows["answer"]["thread_root"], "C1/1789922686.000100")
        self.assertEqual(rows["also here"]["thread_root"], "C1/1789922686.000100")

    def test_a_reaction_crosses_as_a_character_with_the_people_who_gave_it(self) -> None:
        out = self.convert(
            days={
                "general": [
                    message("hi", reactions=[{"name": "+1", "users": ["U2"], "count": 1}]),
                    message("ho", ts="1789922690.000400", reactions=[{"name": "shipit", "users": ["U2"]}]),
                ]
            }
        )
        rows = {m["body"]: m for m in read_jsonl(out, "messages.jsonl") if m["body"]}
        self.assertEqual(rows["hi"]["reactions"], [{"emoji": "\U0001f44d", "by": ["U2"]}])
        # A name this converter cannot translate crosses as a shortcode and is declared, rather
        # than being dropped or written as the bare word.
        self.assertEqual(rows["ho"]["reactions"], [{"emoji": ":shipit:", "by": ["U2"]}])
        self.assertIn("shipit", " ".join(json.loads((out / "manifest.json").read_text())["limits"]))

    def test_an_edit_and_a_pin_travel(self) -> None:
        out = self.convert(
            days={
                "general": [
                    message("fixed", edited={"user": "U1", "ts": "1789922699.000000"}, pinned_to=["C1"])
                ]
            }
        )
        row = [m for m in read_jsonl(out, "messages.jsonl") if m["body"] == "fixed"][0]
        self.assertTrue(row["pinned"])
        self.assertEqual(row["edited_at"], "2026-09-20T16:44:59Z")

    # -- the files ------------------------------------------------------------------------------
    def file_payload(self, **extra) -> dict:
        return {
            "id": "F1",
            "name": "note.txt",
            "mimetype": "text/plain",
            "size": 5,
            "mode": "hosted",
            "user": "U1",
            "created": 1789922686,
            "url_private_download": "https://files.slack.com/F1?token=xoxe-1",
            **extra,
        }

    def test_an_attachment_is_downloaded_and_tied_to_its_message(self) -> None:
        """A Slack export carries links, not bytes. This is the only producer that fetches."""
        out = self.convert(
            days={"general": [message("", files=[self.file_payload()])]},
            fetch=lambda url, token: b"hello",
        )
        record = by_id(out, "files.jsonl")["F1"]
        self.assertEqual(record["hash"], "sha256:" + __import__("hashlib").sha256(b"hello").hexdigest())
        self.assertEqual(record["size"], 5)
        self.assertEqual(record["channel"], "C1")
        row = [m for m in read_jsonl(out, "messages.jsonl") if m.get("files")][0]
        self.assertEqual(row["files"], ["F1"])
        self.assertEqual(validator.validate(out).errors, [])

    def test_a_file_whose_bytes_do_not_match_is_refused_rather_than_written(self) -> None:
        """Half a file is worse than a named absence: the message keeps no attachment, and the
        manifest says which one did not come."""
        out = self.convert(
            days={"general": [message("here", files=[self.file_payload(size=999)])]},
            fetch=lambda url, token: b"hello",
        )
        self.assertEqual(read_jsonl(out, "files.jsonl"), [])
        self.assertEqual([m for m in read_jsonl(out, "messages.jsonl") if m["body"] == "here"][0]["files"], [])
        self.assertIn("note.txt", " ".join(json.loads((out / "manifest.json").read_text())["limits"]))

    def test_a_file_that_lives_outside_slack_is_declared_not_invented(self) -> None:
        out = self.convert(
            days={"general": [message("link", files=[self.file_payload(mode="external", is_external=True)])]},
            fetch=lambda url, token: b"hello",
        )
        self.assertEqual(read_jsonl(out, "files.jsonl"), [])
        self.assertIn("outside Slack", " ".join(json.loads((out / "manifest.json").read_text())["limits"]))

    def test_an_expired_export_stops_the_conversion_and_says_what_to_do(self) -> None:
        """The one failure a person can act on. Retrying does not fix an expired signature, and an
        hour of downloads ending in an archive with no files in it helps nobody."""
        def refuse(url, token):
            raise converter.Expired("Slack returned its sign-in page instead of the file")

        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        (export / "users.json").write_text(json.dumps([user("U1", "alice")]), encoding="utf-8")
        (export / "channels.json").write_text(json.dumps([channel("C1", "general", ["U1"])]), encoding="utf-8")
        (export / "general").mkdir()
        (export / "general" / "2026-09-20.json").write_text(
            json.dumps([message("", files=[self.file_payload()])]), encoding="utf-8"
        )
        instance = converter.Converter(export, self.root / "archive", "Slack")
        instance.read()
        (self.root / "archive").mkdir(parents=True, exist_ok=True)
        instance._download = refuse  # noqa: SLF001
        # The way out is printed for a person to read; the suite does not need to read it.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ) as said, self.assertRaises(SystemExit) as stop:
            instance.fetch_files(None)
        self.assertIn("files:read", said.getvalue(), "the way out is spelled, not hinted at")
        self.assertEqual(stop.exception.code, converter.EXPIRED)

    # -- private channels, read from Slack rather than from the export --------------------------
    def slack(self, answers: dict):
        """Stands in for the Slack API: one canned answer per method."""
        def call(method, query):
            payload = answers.get(method)
            if payload is None:
                raise AssertionError(f"unexpected call to {method}")
            return payload(query) if callable(payload) else payload

        return call

    def test_a_private_channel_is_read_from_slack_with_its_messages(self) -> None:
        """An export carries no private channel, whatever it is asked for. With a token, the ones
        its owner belongs to can be read from Slack itself, which is the reported gap: a `Test2`
        that exists in the workspace and in no export of it."""
        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        (export / "users.json").write_text(
            json.dumps([user("U1", "alice"), user("U2", "bob")]), encoding="utf-8"
        )
        (export / "channels.json").write_text(json.dumps([]), encoding="utf-8")

        instance = converter.Converter(export, self.root / "archive", "Slack")
        instance.token = "xoxp-test"
        instance.read()
        instance._api = self.slack(  # noqa: SLF001 - standing in for Slack
            {
                "conversations.list": {
                    "ok": True,
                    "channels": [
                        {
                            "id": "G1",
                            "name": "test2",
                            "created": 1789900000,
                            "creator": "U1",
                            "is_archived": False,
                            "topic": {"value": "le salon fermé"},
                        }
                    ],
                },
                "conversations.members": {"ok": True, "members": ["U1", "U2"]},
                "conversations.history": {
                    "ok": True,
                    "messages": [
                        {"type": "message", "user": "U1", "text": "une question", "ts": TS, "reply_count": 1}
                    ],
                },
                "conversations.replies": {
                    "ok": True,
                    "messages": [
                        {"type": "message", "user": "U1", "text": "une question", "ts": TS},
                        {
                            "type": "message",
                            "user": "U2",
                            "text": "une réponse",
                            "ts": "1789922690.000200",
                            "thread_ts": TS,
                        },
                    ],
                },
            }
        )
        instance.fetch_private("xoxp-test")
        instance.files.clear()
        instance.write(fetched=False)
        out = self.root / "archive"

        room = by_id(out, "channels.jsonl")["G1"]
        self.assertEqual(room["visibility"], "private")
        self.assertEqual(room["name"], "test2")
        self.assertEqual(room["members"], ["U1", "U2"])
        self.assertEqual(room["topic"], "le salon fermé")
        bodies = {m["body"]: m for m in read_jsonl(out, "messages.jsonl") if m["body"]}
        self.assertIn("une question", bodies)
        # The replies live behind another call: reading only the history would import a
        # conversation with its answers missing.
        self.assertEqual(bodies["une réponse"]["thread_root"], f"G1/{TS}")
        limits = " ".join(json.loads((out / "manifest.json").read_text())["limits"])
        self.assertIn("read from Slack directly", limits)
        self.assertNotIn("public channels only", limits)
        self.assertEqual(validator.validate(out).errors, [])

    def test_every_page_is_followed(self) -> None:
        """Slack answers 200 rooms at a time. Stopping at the first page would import a workspace
        that looks complete and is not."""
        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        (export / "users.json").write_text(json.dumps([user("U1", "alice")]), encoding="utf-8")
        (export / "channels.json").write_text(json.dumps([]), encoding="utf-8")
        instance = converter.Converter(export, self.root / "archive", "Slack")
        instance.token = "xoxp-test"
        instance.read()

        def rooms(query):
            if not query.get("cursor"):
                return {
                    "ok": True,
                    "channels": [{"id": "G1", "name": "un", "created": 1789900000, "creator": "U1"}],
                    "response_metadata": {"next_cursor": "page2"},
                }
            return {
                "ok": True,
                "channels": [{"id": "G2", "name": "deux", "created": 1789900000, "creator": "U1"}],
            }

        instance._api = self.slack(  # noqa: SLF001
            {
                "conversations.list": rooms,
                "conversations.members": {"ok": True, "members": ["U1"]},
                "conversations.history": {"ok": True, "messages": []},
            }
        )
        instance.fetch_private("xoxp-test")
        self.assertEqual(sorted(c["id"] for c in instance.channels), ["G1", "G2"])

    def test_what_actually_goes_over_the_wire(self) -> None:
        """The other private-channel tests stand in for Slack; this one does not.

        A real workspace could not be reached from a test suite, so the HTTP itself is checked
        against a server on localhost: the path, the query, the bearer token, and a cursor followed
        to the next page. Everything above this test assumes those are right.
        """
        import http.server
        import threading

        seen: list[tuple[str, str]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - the name the stdlib requires
                seen.append((self.path, self.headers.get("Authorization", "")))
                first = "cursor=" not in self.path
                body = json.dumps(
                    {
                        "ok": True,
                        "channels": [{"id": "G1" if first else "G2", "name": "x"}],
                        "response_metadata": {"next_cursor": "page2" if first else ""},
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # noqa: D102 - silence the stdlib's stderr logging
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            instance = converter.Converter(self.root / "export", self.root / "archive", "Slack")
            instance.token = "xoxp-secret"
            original = converter.SLACK_API
            converter.SLACK_API = f"http://127.0.0.1:{server.server_port}"
            try:
                rooms = instance._api_pages("conversations.list", {"types": "private_channel"}, "channels")  # noqa: SLF001
            finally:
                converter.SLACK_API = original
        finally:
            server.shutdown()
            # Closed, not just stopped: a listening socket left open warns its way through the
            # rest of the suite.
            server.server_close()

        self.assertEqual([r["id"] for r in rooms], ["G1", "G2"], "the second page is followed")
        self.assertIn("/conversations.list?types=private_channel&limit=200", seen[0][0])
        self.assertIn("cursor=page2", seen[1][0])
        self.assertEqual(seen[0][1], "Bearer xoxp-secret")

    def test_a_missing_scope_stops_the_conversion_and_names_it(self) -> None:
        """Slack answers 200 with ok:false for its own refusals. A token short of a scope would
        otherwise produce an archive quietly missing every private channel."""
        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        (export / "users.json").write_text(json.dumps([user("U1", "alice")]), encoding="utf-8")
        (export / "channels.json").write_text(json.dumps([]), encoding="utf-8")
        instance = converter.Converter(export, self.root / "archive", "Slack")
        instance.token = "xoxp-test"
        instance.read()

        def refuse(url, timeout=None):
            raise AssertionError("no request should be needed for this test")

        instance._api = lambda method, query: (_ for _ in ()).throw(  # noqa: SLF001
            SystemExit("Slack refused conversations.list: missing_scope\n" + converter.PRIVATE_HELP)
        )
        with self.assertRaises(SystemExit) as stop:
            instance.fetch_private("xoxp-test")
        self.assertIn("groups:history", str(stop.exception))

    # -- what the archive says about itself ------------------------------------------------------
    def test_a_standard_export_declares_the_private_half_it_does_not_carry(self) -> None:
        limits = " ".join(json.loads((self.convert() / "manifest.json").read_text())["limits"])
        self.assertIn("public channels only", limits)
        self.assertIn("edit and delete logs", limits)

    def test_a_compliance_export_carries_the_private_half_and_says_nothing_about_it(self) -> None:
        export = self.root / "export"
        export.mkdir(parents=True, exist_ok=True)
        (export / "users.json").write_text(json.dumps([user("U1", "alice"), user("U2", "bob")]), encoding="utf-8")
        (export / "channels.json").write_text(json.dumps([channel("C1", "general", ["U1", "U2"])]), encoding="utf-8")
        (export / "groups.json").write_text(
            json.dumps([channel("G1", "direction", ["U1", "U2"])]), encoding="utf-8"
        )
        (export / "dms.json").write_text(json.dumps([channel("D1", "", ["U1", "U2"])]), encoding="utf-8")
        instance = converter.Converter(export, self.root / "archive", "Slack")
        instance.read()
        instance.files.clear()
        instance.write(fetched=False)
        out = self.root / "archive"
        rooms = by_id(out, "channels.jsonl")
        self.assertEqual(rooms["G1"]["visibility"], "private")
        self.assertEqual(rooms["D1"]["kind"], "direct")
        self.assertEqual(rooms["D1"]["name"], "", "a direct conversation is named by who is in it")
        limits = " ".join(json.loads((out / "manifest.json").read_text())["limits"])
        self.assertNotIn("public channels only", limits)

    def test_the_archive_satisfies_the_contract_checker(self) -> None:
        out = self.convert(
            days={
                "general": [
                    message("<@U2> hello", reactions=[{"name": "tada", "users": ["U2"]}]),
                    message("reply", ts="1789922687.000200", thread_ts=TS),
                ]
            }
        )
        report = validator.validate(out)
        self.assertEqual(report.errors, [])


if __name__ == "__main__":
    unittest.main()
