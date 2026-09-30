"""What the Teams adapter must get right, one behaviour at a time.

There is no Teams export to read: the adapter talks to Microsoft Graph. So these tests stand up a
Graph of their own, on localhost, answering the way the documentation says Graph answers (the
shapes are the documentation's own examples, down to the notices and the redirect a file download
takes), and run the real adapter against it. What goes over the wire is checked as well as what
comes out: a token must reach Graph and nothing else, and a throttled request must wait.

None of this has met a real tenant yet. When one is available, the counts its first run prints are
the next test.
"""

from __future__ import annotations

import base64
import contextlib
import http.server
import io
import json
import stat
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from helpers import by_id, load, read_jsonl
from test_checkers_agree import BINARY, REQUIRED, rust_accepts

teams = load("convert-teams.py")
validator = load("validate-archive.py")

HOME = "tenant-home"
ALICE = "a1111111-1111-1111-1111-111111111111"
BOB = "b2222222-2222-2222-2222-222222222222"
CAROL = "c3333333-3333-3333-3333-333333333333"  # a guest, in the directory
DAN = "d4444444-4444-4444-4444-444444444444"  # switched off, no mailbox
GONE = "e5555555-5555-5555-5555-555555555555"  # left, and the directory forgot them
TEAM = "t0000000-0000-0000-0000-000000000001"
OTHER_TEAM = "t0000000-0000-0000-0000-000000000002"
GENERAL = "19:general@thread.tacv2"
PRODUIT = "19:produit@thread.tacv2"
DIRECTION = "19:direction@thread.tacv2"

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
PLAN = b"le plan, version 2"
BUDGET = b"le budget de la direction"
SPEC = b"%PDF-1.7 la specification"
README = b"lisez-moi"
NOTES = b"les notes de Bob"


def token_for(tenant: str) -> str:
    """An access token shaped like Entra's: three parts, the middle one carrying `tid`."""
    def part(value: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'tid': tenant, 'aud': 'https://graph.microsoft.com'})}.sig"


def user(uid: str, name: str, mail: str | None, **extra) -> dict:
    return {
        "id": uid,
        "displayName": name,
        "mail": mail,
        "userPrincipalName": (mail or f"{name.split()[0].lower()}@atelier.example"),
        "accountEnabled": True,
        "userType": "Member",
        **extra,
    }


def sender(uid: str, name: str, kind: str = "aadUser", tenant: str | None = HOME) -> dict:
    return {"application": None, "device": None,
            "user": {"id": uid, "displayName": name, "userIdentityType": kind, "tenantId": tenant}}


def post(mid: str, author: dict | None, content: str, *, at: str = "2026-03-02T09:00:00.123Z", **extra) -> dict:
    return {
        "id": mid,
        "replyToId": None,
        "messageType": "message",
        "createdDateTime": at,
        "lastModifiedDateTime": at,
        "lastEditedDateTime": None,
        "deletedDateTime": None,
        "subject": None,
        "from": author,
        "body": {"contentType": "html", "content": content},
        "attachments": [],
        "mentions": [],
        "reactions": [],
        **extra,
    }


def notice(mid: str, detail: dict, at: str) -> dict:
    return post(mid, None, "<systemEventMessage/>", at=at, messageType="systemEventMessage", eventDetail=detail)


class FakeGraph:
    """Graph, the sign-in service and SharePoint, answering from a table, remembering every request."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.token_requests: list[dict] = []
        self.sharepoint_requests: list[dict] = []
        self.routes: dict[str, object] = {}
        # Answers to give once before the real one: a status and its headers.
        self.hiccups: dict[str, list[tuple[int, dict]]] = {}
        self.refuse: dict[str, tuple[int, str]] = {}
        self.downloads: dict[str, bytes] = {}
        self.redirected: dict[str, bytes] = {}
        self.server = self._serve(self._graph_handler())
        self.sharepoint = self._serve(self._sharepoint_handler())
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.graph = f"{self.base}/v1.0"
        self.login = f"{self.base}/login"
        self.sharepoint_base = f"http://127.0.0.1:{self.sharepoint.server_address[1]}"

    @staticmethod
    def _serve(handler) -> http.server.ThreadingHTTPServer:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        return server

    def close(self) -> None:
        for server in (self.server, self.sharepoint):
            server.shutdown()
            server.server_close()

    def _graph_handler(self):
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):  # quiet
                pass

            def _send(self, status: int, body: bytes, headers: dict | None = None, kind="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                form = urllib.parse.parse_qs(self.rfile.read(length).decode())
                fake.token_requests.append({"path": self.path, "form": form})
                body = json.dumps({"access_token": token_for(HOME), "expires_in": 3599}).encode()
                self._send(200, body)

            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                path = urllib.parse.unquote(parsed.path).removeprefix("/v1.0")
                query = urllib.parse.parse_qs(parsed.query)
                key = path + ("#" + query["$skiptoken"][0] if "$skiptoken" in query else "")
                fake.requests.append({"path": path, "key": key, "query": query, "headers": dict(self.headers)})
                if fake.hiccups.get(key):
                    status, headers = fake.hiccups[key].pop(0)
                    return self._send(status, b"{}", headers)
                if key in fake.refuse:
                    status, message = fake.refuse[key]
                    body = json.dumps({"error": {"code": "Forbidden", "message": message}}).encode()
                    return self._send(status, body)
                if key in fake.downloads:
                    return self._send(200, fake.downloads[key], kind="image/png")
                if key in fake.redirected:
                    location = f"{fake.sharepoint_base}/download{path}?sig=signed"
                    return self._send(302, b"", {"Location": location})
                if key not in fake.routes:
                    return self._send(404, json.dumps({"error": {"code": "NotFound", "message": key}}).encode())
                return self._send(200, json.dumps(fake.routes[key]).encode())

        return Handler

    def _sharepoint_handler(self):
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                fake.sharepoint_requests.append({"path": self.path, "headers": dict(self.headers)})
                path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).removeprefix("/download")
                body = fake.redirected.get(path, b"")
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler

    def paged(self, path: str, pages: list[list]) -> None:
        """A collection over several pages, linked by `@odata.nextLink` the way Graph links them."""
        for index, items in enumerate(pages):
            key = path if index == 0 else f"{path}#page{index}"
            payload: dict = {"value": items}
            if index + 1 < len(pages):
                payload["@odata.nextLink"] = f"{self.graph}{urllib.parse.quote(path, safe='/:@')}?$skiptoken=page{index + 1}"
            self.routes[key] = payload


def atelier(fake: FakeGraph) -> None:
    """One organisation, shaped to carry every case the adapter has to get right."""
    g = fake.graph
    fake.paged("/teams", [[
        {"id": TEAM, "displayName": "Atelier", "description": "Tout l'atelier"},
        {"id": OTHER_TEAM, "displayName": "Archives 2019", "description": ""},
    ]])
    fake.routes[f"/teams/{TEAM}"] = {
        "id": TEAM, "displayName": "Atelier", "description": "Tout l'atelier",
        "visibility": "public", "isArchived": False,
    }
    fake.paged("/users", [
        [user(ALICE, "Alice Martin", "alice@atelier.example"), user(BOB, "Bob Martin", "bob@atelier.example")],
        [
            user(CAROL, "Carol (Partenaire)", "carol@partner.example", userType="Guest",
                 userPrincipalName="carol_partner.example#EXT#@atelier.onmicrosoft.com"),
            user(DAN, "Dan Roux", None, accountEnabled=False, userPrincipalName="dan@atelier.example"),
        ],
    ])
    fake.paged(f"/teams/{TEAM}/members", [[
        {"@odata.type": "#microsoft.graph.aadUserConversationMember", "userId": uid, "displayName": name,
         "roles": ["owner"] if uid == ALICE else [], "tenantId": HOME}
        for uid, name in ((ALICE, "Alice Martin"), (BOB, "Bob Martin"), (CAROL, "Carol"), (DAN, "Dan Roux"))
    ]])
    fake.routes[f"/teams/{TEAM}/primaryChannel"] = {"id": GENERAL}
    fake.paged(f"/teams/{TEAM}/channels", [[
        {"id": PRODUIT, "displayName": "Produit", "description": "La feuille de route",
         "membershipType": "standard", "createdDateTime": "2026-03-01T10:00:00Z"},
        {"id": DIRECTION, "displayName": "Direction", "description": "",
         "membershipType": "private", "createdDateTime": "2026-03-01T11:00:00Z"},
        {"id": GENERAL, "displayName": "General", "description": "",
         "membershipType": "standard", "createdDateTime": "2026-03-01T08:00:00Z"},
    ]])
    fake.paged(f"/teams/{TEAM}/channels/{DIRECTION}/members", [[
        {"userId": ALICE, "displayName": "Alice Martin", "tenantId": HOME},
        {"userId": BOB, "displayName": "Bob Martin", "tenantId": HOME},
        {"userId": "x9999999-external", "displayName": "Quelqu'un d'ailleurs", "tenantId": "elsewhere"},
    ]])

    # Where the files live.
    for channel, drive in ((GENERAL, "drive-team"), (PRODUIT, "drive-team"), (DIRECTION, "drive-direction")):
        fake.routes[f"/teams/{TEAM}/channels/{channel}/filesFolder"] = {
            "id": f"folder-{channel}", "name": "x", "parentReference": {"driveId": drive},
        }
    # A library is known by its root folder: Graph documents the drive itself as closed to an
    # application, so the drive's own address answers what the real one would.
    fake.routes["/drives/drive-team/root"] = {
        "id": "root-team", "webUrl": "https://atelier.sharepoint.com/sites/Atelier/Shared%20Documents",
        "parentReference": {"driveId": "drive-team"}}
    fake.routes["/drives/drive-direction/root"] = {
        "id": "root-direction",
        "webUrl": "https://atelier.sharepoint.com/sites/Atelier-Direction/Shared%20Documents",
        "parentReference": {"driveId": "drive-direction"}}
    for closed in ("/drives/drive-team", "/drives/drive-direction", f"/users/{BOB}/drive"):
        fake.refuse[closed] = (403, "Application permissions are not supported for this call.")
    # Bob's own OneDrive, where a file he attached from his computer lives.
    fake.routes[f"/users/{BOB}/drive/root"] = {
        "id": "root-bob", "webUrl": "https://atelier-my.sharepoint.com/personal/bob_atelier_example/Documents",
        "parentReference": {"driveId": "drive-bob"}}
    fake.routes["/drives/drive-bob/root:/Microsoft Teams Chat Files/notes.txt"] = {
        "id": "item-notes", "name": "notes.txt", "size": len(NOTES), "file": {"mimeType": "text/plain"},
        "createdBy": {"user": {"id": BOB}}, "createdDateTime": "2026-03-04T09:30:00Z"}
    fake.redirected["/drives/drive-bob/items/item-notes/content"] = NOTES
    plan = {"id": "item-plan", "name": "Plan v2.docx", "size": len(PLAN),
            "file": {"mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
            "createdBy": {"user": {"id": ALICE, "displayName": "Alice Martin"}},
            "createdDateTime": "2026-03-02T09:30:00Z", "parentReference": {"driveId": "drive-team"}}
    fake.routes["/drives/drive-team/root:/General/Plan v2.docx"] = plan
    fake.routes["/drives/drive-direction/root:/Direction/Budget.xlsx"] = {
        "id": "item-budget", "name": "Budget.xlsx", "size": len(BUDGET), "file": {"mimeType": "application/vnd.ms-excel"},
        "createdBy": {"user": {"id": ALICE}}, "createdDateTime": "2026-03-03T09:00:00Z"}
    fake.redirected["/drives/drive-team/items/item-plan/content"] = PLAN
    fake.redirected["/drives/drive-direction/items/item-budget/content"] = BUDGET
    fake.redirected["/drives/drive-team/items/item-spec/content"] = SPEC
    fake.redirected["/drives/drive-team/items/item-readme/content"] = README
    # The team's library: a file already posted (the plan), one nobody posted, a folder of specs,
    # and a OneNote notebook, which is not a file.
    fake.paged("/drives/drive-team/root/children", [[
        {"id": "f-general", "name": "General", "folder": {"childCount": 2}},
        {"id": "f-produit", "name": "Produit", "folder": {"childCount": 0}},
        {"id": "item-readme", "name": "Lisez-moi.txt", "size": len(README), "file": {"mimeType": "text/plain"},
         "createdBy": {"user": {"id": BOB}}, "createdDateTime": "2026-02-01T08:00:00Z"},
        {"id": "item-notebook", "name": "Carnet", "package": {"type": "oneNote"}},
    ]])
    fake.paged("/drives/drive-team/items/f-general/children", [[
        dict(plan),
        {"id": "f-specs", "name": "Specs", "folder": {"childCount": 1}},
    ]])
    fake.paged("/drives/drive-team/items/f-specs/children", [[
        {"id": "item-spec", "name": "Spec.pdf", "size": len(SPEC), "file": {"mimeType": "application/pdf"},
         "createdBy": {"user": {"id": ALICE}}, "createdDateTime": "2026-02-02T08:00:00Z"},
    ]])
    fake.paged("/drives/drive-team/items/f-produit/children", [[]])

    general_messages = f"/teams/{TEAM}/channels/{GENERAL}/messages"
    hosted = f"{g}/teams/{TEAM}/channels/{GENERAL}/messages/140/hostedContents/aWQ9eF8w/$value"
    fake.downloads[urllib.parse.unquote(hosted.removeprefix(g))] = PNG
    greeting = post(
        "100", sender(ALICE, "Alice Martin"),
        '<p>Bonjour <at id="0">Bob</at> <at id="1">Martin</at>, voir <a href="https://example.org/doc">le doc</a></p>',
        at="2026-03-02T09:00:00.395Z",
        mentions=[
            {"id": 0, "mentionText": "Bob", "mentioned": {"user": {"id": BOB, "displayName": "Bob Martin", "userIdentityType": "aadUser"}}},
            {"id": 1, "mentionText": "Martin", "mentioned": {"user": {"id": BOB, "displayName": "Bob Martin", "userIdentityType": "aadUser"}}},
        ],
        reactions=[
            {"reactionType": "like", "displayName": "Like", "user": {"user": {"id": BOB, "userIdentityType": "aadUser"}}},
            {"reactionType": "\U0001f389", "displayName": "Party", "user": {"user": {"id": CAROL, "userIdentityType": "aadUser"}}},
            {"reactionType": "custom", "displayName": "Atelier logo", "user": {"user": {"id": BOB, "userIdentityType": "aadUser"}}},
        ],
    )
    greeting["replies"] = [post("101", sender(BOB, "Bob Martin"), "<div>Merci !</div>", at="2026-03-02T09:05:00Z",
                                replyToId="100", lastEditedDateTime="2026-03-02T09:06:00.1234567Z")]
    greeting["replies@odata.nextLink"] = f"{g}{general_messages}/100/replies?$skiptoken=more"
    fake.routes[f"{general_messages}/100/replies#more"] = {"value": [
        post("102", sender(GONE, "Ancien Collègue"), "<p>Je suis parti depuis</p>", at="2026-03-02T09:10:00Z",
             replyToId="100"),
    ]}
    deleted_root = post("110", sender(BOB, "Bob Martin"), "", at="2026-03-02T10:00:00Z",
                        deletedDateTime="2026-03-02T10:30:00Z")
    deleted_root["replies"] = [post("111", sender(ALICE, "Alice Martin"), "<p>La réponse reste</p>",
                                    at="2026-03-02T10:05:00Z", replyToId="110")]
    card = post("120", {"application": {"id": "planner", "displayName": "Planner", "applicationIdentityType": "bot"},
                        "user": None, "device": None},
                '<attachment id="card1"></attachment>', at="2026-03-02T11:00:00Z",
                attachments=[{"id": "card1", "contentType": "application/vnd.microsoft.card.adaptive",
                              "content": json.dumps({"type": "AdaptiveCard", "body": [
                                  {"type": "TextBlock", "text": "Tâche terminée"}]})}])
    shared_file = post("130", sender(ALICE, "Alice Martin"), '<div><attachment id="att1"></attachment>Le plan</div>',
                       at="2026-03-02T12:00:00Z",
                       attachments=[{"id": "att1", "contentType": "reference", "name": "Plan v2.docx",
                                     "contentUrl": "https://atelier.sharepoint.com/sites/Atelier/Shared%20Documents/General/Plan%20v2.docx"}])
    pasted = post("140", sender(BOB, "Bob Martin"),
                  f'<p>Capture <img src="{hosted}" width="131" style="vertical-align:bottom"></p>',
                  at="2026-03-02T13:00:00Z")
    quoting = post("150", sender(CAROL, "Carol (Partenaire)"),
                   '<attachment id="100"></attachment><p>Je confirme</p>', at="2026-03-02T14:00:00Z",
                   attachments=[{"id": "100", "contentType": "messageReference",
                                 "content": json.dumps({"messageId": "100", "messagePreview": "Bonjour Bob Martin",
                                                        "messageSender": {"user": {"displayName": "Alice Martin"}}})}])
    federated = post("160", sender("f6666666-other", "Eve (Partenaire)", "federatedUser", tenant="elsewhere"),
                     "<p>Bonjour depuis ailleurs</p>", at="2026-03-02T15:00:00Z")
    announcement = post("170", sender(ALICE, "Alice Martin"),
                        "<p><strong>Important</strong> : réunion <em>demain</em></p><ul><li>point 1</li><li>point 2</li></ul>",
                        at="2026-03-02T16:00:00Z", subject="Annonce")
    arrival = notice("90", {"@odata.type": "#microsoft.graph.membersAddedEventMessageDetail",
                            "visibleHistoryStartDateTime": "0001-01-01T00:00:00Z",
                            "members": [{"id": BOB, "displayName": None, "userIdentityType": "aadUser"}],
                            "initiator": {"user": {"id": ALICE, "userIdentityType": "aadUser"}}},
                     at="2026-03-01T08:30:00Z")
    created = notice("91", {"@odata.type": "#microsoft.graph.channelAddedEventMessageDetail",
                            "channelId": PRODUIT, "channelDisplayName": "Produit",
                            "initiator": {"user": {"id": BOB, "userIdentityType": "aadUser"}}},
                     at="2026-03-01T10:00:00Z")
    renamed = notice("92", {"@odata.type": "#microsoft.graph.teamDescriptionUpdatedEventMessageDetail",
                            "teamDescription": "Tout l'atelier",
                            "initiator": {"user": {"id": ALICE, "userIdentityType": "aadUser"}}},
                     at="2026-03-01T10:30:00Z")
    fake.paged(general_messages, [[greeting, deleted_root, card, shared_file], [pasted, quoting, federated, announcement,
                                                                                  arrival, created, renamed]])

    fake.paged(f"/teams/{TEAM}/channels/{PRODUIT}/messages", [[
        post("200", sender(BOB, "Bob Martin"),
             '<codeblock class="language-Python"><code>print(&quot;bonjour&quot;)<br>x = 1 * 2</code></codeblock>',
             at="2026-03-04T09:00:00Z"),
        post("201", sender(BOB, "Bob Martin"), '<attachment id="n"></attachment><p>Mes notes</p>',
             at="2026-03-04T10:00:00Z",
             attachments=[{"id": "n", "contentType": "reference", "name": "notes.txt",
                           "contentUrl": "https://atelier-my.sharepoint.com/personal/bob_atelier_example/Documents/Microsoft%20Teams%20Chat%20Files/notes.txt"}]),
    ]])
    fake.paged(f"/teams/{TEAM}/channels/{DIRECTION}/messages", [[
        post("300", sender(ALICE, "Alice Martin"), '<attachment id="b"></attachment><p>Le budget</p>',
             at="2026-03-03T09:00:00Z",
             attachments=[{"id": "b", "contentType": "reference", "name": "Budget.xlsx",
                           "contentUrl": "https://atelier.sharepoint.com/sites/Atelier-Direction/Shared%20Documents/Direction/Budget.xlsx"}]),
        notice("301", {"@odata.type": "#microsoft.graph.membersAddedEventMessageDetail",
                       "members": [{"id": BOB, "userIdentityType": "aadUser"}],
                       "initiator": {"user": {"id": ALICE, "userIdentityType": "aadUser"}}}, at="2026-03-01T11:05:00Z"),
        notice("302", {"@odata.type": "#microsoft.graph.membersDeletedEventMessageDetail",
                       "members": [{"id": DAN, "userIdentityType": "aadUser"}],
                       "initiator": {"user": {"id": ALICE, "userIdentityType": "aadUser"}}}, at="2026-03-01T11:10:00Z"),
    ]])


class Tenant(unittest.TestCase):
    """The whole adapter, against a Graph standing in for a real tenant."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.fake = FakeGraph()
        self.addCleanup(self.fake.close)
        atelier(self.fake)
        self.pauses: list[float] = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def graph(self, cache: str = "cache"):
        return teams.Graph(HOME, "client-id", "the-secret", self.root / cache,
                           graph=self.fake.graph, login=self.fake.login, pause=self.pauses.append)

    def convert(self, *, cache: str = "cache", out: str = "archive", only=("Atelier",), **options) -> Path:
        archive = self.root / out
        converter = teams.Converter(self.graph(cache), archive, **options)
        with contextlib.redirect_stdout(io.StringIO()):
            chosen = converter.choose(converter.list_teams(), list(only))
            converter.read_directory()
            for team in chosen:
                converter.read_team(team)
            converter.write()
        self.converter = converter
        return archive

    def messages(self, archive: Path) -> dict[str, dict]:
        return by_id(archive, "messages.jsonl")

    # the archive -------------------------------------------------------------------------------
    def test_the_archive_satisfies_the_contract_checker(self) -> None:
        archive = self.convert()
        report = validator.validate(archive)
        self.assertEqual(report.errors, [])

    def test_the_api_accepts_the_archive_as_it_is(self) -> None:
        """The checker that decides the import, not only the one beside the producer."""
        if BINARY is None:
            if REQUIRED:
                self.fail("RUCHOIR_TEST_REQUIRE_RUST_CHECKER=1 but no API binary was found")
            self.skipTest("no API binary: build one with `cargo build -p ruchoir-api`")
        accepted, said = rust_accepts(self.convert())
        self.assertTrue(accepted, said)

    def test_a_team_becomes_a_space_and_only_the_chosen_ones_cross(self) -> None:
        archive = self.convert()
        spaces = read_jsonl(archive, "spaces.jsonl")
        self.assertEqual([s["id"] for s in spaces], [TEAM])
        self.assertEqual(spaces[0]["name"], "Atelier")
        self.assertEqual(spaces[0]["visibility"], "public")
        self.assertEqual(json.loads((archive / "manifest.json").read_text())["source"], "teams")

    def test_people_arrive_with_their_address_and_the_departed_arrive_switched_off(self) -> None:
        people = by_id(self.convert(), "users.jsonl")
        self.assertEqual(people[ALICE]["email"], "alice@atelier.example")
        # A guest keeps their own address, not the #EXT# name the directory gives them.
        self.assertEqual(people[CAROL]["email"], "carol@partner.example")
        # No mailbox: the sign-in name is an address, and it is theirs.
        self.assertEqual(people[DAN]["email"], "dan@atelier.example")
        self.assertFalse(people[DAN]["active"])
        # Gone from the directory, still the author of what they wrote.
        self.assertEqual(people[GONE]["display_name"], "Ancien Collègue")
        self.assertFalse(people[GONE]["active"])
        self.assertEqual(people[GONE]["email"], "")

    def test_channels_keep_their_privacy_and_their_own_members(self) -> None:
        channels = by_id(self.convert(), "channels.jsonl")
        self.assertEqual(channels[GENERAL]["visibility"], "public")
        self.assertEqual(sorted(channels[GENERAL]["members"]), sorted([ALICE, BOB, CAROL, DAN]))
        self.assertEqual(channels[DIRECTION]["visibility"], "private")
        # Somebody from another organisation is not made into an account.
        self.assertEqual(sorted(channels[DIRECTION]["members"]), sorted([ALICE, BOB]))
        self.assertEqual(channels[PRODUIT]["topic"], "La feuille de route")

    # messages ----------------------------------------------------------------------------------
    def test_a_message_crosses_as_markdown_with_its_mentions_merged(self) -> None:
        message = self.messages(self.convert())[f"{GENERAL}/100"]
        # "Bob" and "Martin" were two mentions of one person.
        self.assertEqual(message["body"], "Bonjour @{" + BOB + "}, voir [le doc](https://example.org/doc)")
        self.assertEqual(message["author"], ALICE)
        self.assertEqual(message["sent_at"], "2026-03-02T09:00:00Z")

    def test_replies_follow_every_page_and_point_at_their_root(self) -> None:
        messages = self.messages(self.convert())
        first = messages[f"{GENERAL}/100/101"]
        second = messages[f"{GENERAL}/100/102"]
        self.assertEqual(first["thread_root"], f"{GENERAL}/100")
        self.assertEqual(second["thread_root"], f"{GENERAL}/100")
        self.assertEqual(first["edited_at"], "2026-03-02T09:06:00Z")
        self.assertEqual(second["author"], GONE)

    def test_a_reply_whose_root_was_deleted_stands_on_its_own(self) -> None:
        messages = self.messages(self.convert())
        self.assertNotIn(f"{GENERAL}/110", messages)
        self.assertIsNone(messages[f"{GENERAL}/110/111"]["thread_root"])
        limits = " ".join(self.converter.declare())
        self.assertIn("1 deleted message", limits)

    def test_reactions_cross_as_characters_with_the_people_who_gave_them(self) -> None:
        message = self.messages(self.convert())[f"{GENERAL}/100"]
        reactions = {r["emoji"]: r["by"] for r in message["reactions"]}
        self.assertEqual(reactions["\U0001f44d"], [BOB])
        self.assertEqual(reactions["\U0001f389"], [CAROL])
        self.assertEqual(reactions[":atelier_logo:"], [BOB])

    def test_an_app_and_somebody_from_elsewhere_are_absent_authors(self) -> None:
        messages = self.messages(self.convert())
        self.assertEqual(messages[f"{GENERAL}/120"]["author"], "absent:Planner")
        self.assertEqual(messages[f"{GENERAL}/120"]["body"], "Tâche terminée")
        self.assertEqual(messages[f"{GENERAL}/160"]["author"], "absent:Eve (Partenaire)")

    def test_a_quoted_reply_shows_what_it_quoted(self) -> None:
        body = self.messages(self.convert())[f"{GENERAL}/150"]["body"]
        self.assertEqual(body, "> **Alice Martin**: Bonjour Bob Martin\n\nJe confirme")

    def test_a_subject_leads_and_formatting_is_what_the_product_reads(self) -> None:
        body = self.messages(self.convert())[f"{GENERAL}/170"]["body"]
        self.assertEqual(body, "**Annonce**\n\n**Important** : réunion _demain_\n- point 1\n- point 2")

    def test_code_keeps_its_shape(self) -> None:
        body = self.messages(self.convert())[f"{PRODUIT}/200"]["body"]
        self.assertEqual(body, '```python\nprint("bonjour")\nx = 1 * 2\n```')

    def test_arrivals_and_departures_cross_as_notices_and_the_rest_is_declared(self) -> None:
        messages = self.messages(self.convert())
        self.assertEqual(messages[f"{GENERAL}/90/{BOB}"]["system_event"], "member_joined")
        self.assertEqual(messages[f"{GENERAL}/90/{BOB}"]["author"], BOB)
        # In a private channel, an arrival is into the channel, not the space.
        self.assertEqual(messages[f"{DIRECTION}/301/{BOB}"]["system_event"], "channel_joined")
        self.assertEqual(messages[f"{DIRECTION}/302/{DAN}"]["system_event"], "channel_removed")
        self.assertIn("teamDescriptionUpdated", " ".join(self.converter.declare()))

    def test_a_channel_opens_on_its_creation_by_whoever_created_it(self) -> None:
        messages = self.messages(self.convert())
        created = messages[f"{PRODUIT}/created"]
        self.assertEqual(created["system_event"], "channel_created")
        self.assertEqual(created["author"], BOB)
        self.assertEqual(created["sent_at"], "2026-03-01T10:00:00Z")
        # The notice announcing it in General is not a second one.
        self.assertNotIn(f"{GENERAL}/91", messages)

    def test_messages_are_ordered_by_conversation_then_time(self) -> None:
        rows = read_jsonl(self.convert(), "messages.jsonl")
        for channel in (GENERAL, PRODUIT, DIRECTION):
            times = [r["sent_at"] for r in rows if r["channel"] == channel]
            self.assertEqual(times, sorted(times))

    # files -------------------------------------------------------------------------------------
    def test_a_posted_file_is_fetched_through_its_library_and_hangs_on_its_message(self) -> None:
        archive = self.convert()
        files = by_id(archive, "files.jsonl")
        plan = files["drive:drive-team/item-plan"]
        self.assertEqual(plan["name"], "Plan v2.docx")
        self.assertEqual(plan["channel"], GENERAL)
        self.assertNotIn("folder", plan)
        self.assertEqual(self.messages(archive)[f"{GENERAL}/130"]["files"], ["drive:drive-team/item-plan"])
        self.assertEqual(self.messages(archive)[f"{GENERAL}/130"]["body"], "Le plan")

    def test_a_file_from_somebodys_onedrive_is_found_through_their_drive(self) -> None:
        archive = self.convert()
        self.assertEqual(self.messages(archive)[f"{PRODUIT}/201"]["files"], ["drive:drive-bob/item-notes"])
        record = by_id(archive, "files.jsonl")["drive:drive-bob/item-notes"]
        self.assertEqual((record["channel"], record["size"]), (PRODUIT, len(NOTES)))

    def test_libraries_are_found_without_reading_a_drive(self) -> None:
        """Graph documents reading a drive as closed to an application: nothing may depend on it."""
        self.convert()
        asked = {r["path"] for r in self.fake.requests}
        for closed in ("/drives/drive-team", "/drives/drive-direction", f"/users/{BOB}/drive"):
            self.assertNotIn(closed, asked)
        self.assertEqual(self.converter.missing_files, [])

    def test_a_file_posted_in_a_private_channel_belongs_to_that_channel(self) -> None:
        files = by_id(self.convert(), "files.jsonl")
        self.assertEqual(files["drive:drive-direction/item-budget"]["channel"], DIRECTION)

    def test_a_pasted_image_becomes_an_attachment_and_leaves_the_body(self) -> None:
        archive = self.convert()
        message = self.messages(archive)[f"{GENERAL}/140"]
        self.assertEqual(message["body"], "Capture")
        [image] = message["files"]
        record = by_id(archive, "files.jsonl")[image]
        self.assertEqual(record["content_type"], "image/png")
        self.assertEqual(record["size"], len(PNG))
        self.assertEqual(record["uploaded_by"], BOB)

    def test_the_library_crosses_into_the_space_with_its_folders_and_without_doubles(self) -> None:
        files = by_id(self.convert(), "files.jsonl")
        spec = files["drive:drive-team/item-spec"]
        self.assertEqual((spec["space"], spec["folder"]), (TEAM, "General/Specs"))
        self.assertNotIn("channel", spec)
        readme = files["drive:drive-team/item-readme"]
        self.assertEqual(readme["space"], TEAM)
        self.assertNotIn("folder", readme)
        # The plan was posted in a message: it is that message's, not a second copy in the library.
        self.assertEqual(sum(1 for f in files if f.endswith("item-plan")), 1)
        self.assertIn("oneNote", " ".join(self.converter.declare()))

    def test_a_private_channels_library_is_left_behind_and_said_so(self) -> None:
        files = self.convert()
        folders = {f.get("folder") for f in by_id(files, "files.jsonl").values()}
        self.assertFalse(any(f and f.startswith("Direction") for f in folders))
        self.assertIn("private or shared channel", " ".join(self.converter.declare()))

    def test_no_files_means_none_and_says_so(self) -> None:
        archive = self.convert(fetch_files=False)
        self.assertEqual(read_jsonl(archive, "files.jsonl"), [])
        self.assertEqual(validator.validate(archive).errors, [])
        self.assertIn("Files were not fetched", " ".join(self.converter.declare()))

    def test_the_bytes_are_the_files(self) -> None:
        archive = self.convert()
        for record in read_jsonl(archive, "files.jsonl"):
            digest = record["hash"].split(":", 1)[1]
            self.assertTrue((archive / "blobs" / digest[:2] / digest).is_file(), record["name"])

    # the wire ----------------------------------------------------------------------------------
    def test_the_application_signs_in_with_its_own_secret(self) -> None:
        self.convert()
        [first] = self.fake.token_requests
        self.assertEqual(first["path"], f"/login/{HOME}/oauth2/v2.0/token")
        self.assertEqual(first["form"]["grant_type"], ["client_credentials"])
        self.assertEqual(first["form"]["client_secret"], ["the-secret"])
        self.assertEqual(first["form"]["scope"], ["https://graph.microsoft.com/.default"])

    def test_the_token_goes_to_graph_and_never_to_where_a_file_is_served_from(self) -> None:
        self.convert()
        self.assertTrue(all(r["headers"].get("Authorization", "").startswith("Bearer ") for r in self.fake.requests))
        self.assertTrue(self.fake.sharepoint_requests, "the downloads went through a redirect")
        for request in self.fake.sharepoint_requests:
            self.assertNotIn("Authorization", request["headers"])

    def test_notices_are_asked_for_by_name(self) -> None:
        self.convert()
        asked = [r for r in self.fake.requests if r["path"].endswith("/messages")]
        self.assertTrue(asked)
        for request in asked:
            self.assertEqual(request["headers"].get("Prefer"), "include-unknown-enum-members")

    def test_a_throttled_request_waits_as_long_as_graph_asks_and_tries_again(self) -> None:
        self.fake.hiccups[f"/teams/{TEAM}/members"] = [(429, {"Retry-After": "7"})]
        archive = self.convert()
        self.assertIn(7.0, self.pauses)
        self.assertIn(BOB, by_id(archive, "users.jsonl"))

    def test_a_token_that_stops_working_is_renewed_once(self) -> None:
        self.fake.hiccups[f"/teams/{TEAM}"] = [(401, {})]
        self.convert()
        self.assertEqual(len(self.fake.token_requests), 2)

    def test_a_missing_permission_stops_the_conversion_and_says_how_to_grant_it(self) -> None:
        self.fake.refuse[f"/teams/{TEAM}/channels/{GENERAL}/messages"] = (
            403, "Missing role permissions on the request. API requires one of 'ChannelMessage.Read.All'.")
        with self.assertRaises(teams.Refused) as caught:
            self.convert()
        said = teams.missing_permission(caught.exception)
        self.assertIn("ChannelMessage.Read.All", said)
        self.assertIn("Grant admin consent", said)

    def test_a_second_run_reads_from_where_the_first_stopped(self) -> None:
        first = self.convert(out="first")
        asked = len(self.fake.requests) + len(self.fake.sharepoint_requests)
        second = self.convert(out="second")
        self.assertEqual(len(self.fake.requests) + len(self.fake.sharepoint_requests), asked,
                         "nothing was asked twice")
        self.assertEqual(read_jsonl(first, "messages.jsonl"), read_jsonl(second, "messages.jsonl"))
        self.assertEqual(read_jsonl(first, "files.jsonl"), read_jsonl(second, "files.jsonl"))

    def test_the_command_writes_an_archive_and_a_cache_only_their_owner_reads(self) -> None:
        """The whole command line, as the delivery script runs it."""
        secret = self.root / "secret"
        secret.write_text("the-secret\n", encoding="utf-8")
        out = self.root / "cli-archive"
        argv = ["convert-teams.py", "--tenant", HOME, "--client-id", "client-id",
                "--secret-file", str(secret), "--out", str(out), "--team", "Atelier"]
        with mock.patch.object(teams, "GRAPH", self.fake.graph), \
                mock.patch.object(teams, "LOGIN", self.fake.login), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            teams.main()
        self.assertIn("1 space(s)", printed.getvalue())
        self.assertEqual(validator.validate(out).errors, [])
        # The conversations sit in clear in both until the archive is sealed.
        for directory in (out, Path(f"{out}.cache"), Path(f"{out}.cache") / "json"):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode) & 0o077, 0, directory)
        self.assertEqual(stat.S_IMODE((out / "messages.jsonl").stat().st_mode) & 0o077, 0)

    def test_listing_the_teams_leaves_nothing_behind(self) -> None:
        secret = self.root / "secret"
        secret.write_text("the-secret", encoding="utf-8")
        argv = ["convert-teams.py", "--tenant", HOME, "--client-id", "c", "--secret-file", str(secret), "--list"]
        before = set(Path.cwd().iterdir())
        with mock.patch.object(teams, "GRAPH", self.fake.graph), \
                mock.patch.object(teams, "LOGIN", self.fake.login), \
                mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            teams.main()
        self.assertIn(f"{TEAM}  Atelier", printed.getvalue())
        self.assertIn("Archives 2019", printed.getvalue())
        self.assertEqual(set(Path.cwd().iterdir()), before)


class Markdown(unittest.TestCase):
    """The body of a Teams message, as the Markdown the product reads."""

    def md(self, content: str, mentions=None, person=lambda user, name: user["id"]) -> str:
        return teams.to_markdown(content, "html", mentions or [], person).markdown

    def test_every_div_is_one_line_however_deeply_nested(self) -> None:
        self.assertEqual(self.md("<div><div><div>un</div></div><div>deux</div></div>"), "un\ndeux")

    def test_a_line_break_is_kept(self) -> None:
        self.assertEqual(self.md("<p>un<br>deux</p>"), "un\ndeux")

    def test_spaces_are_collapsed_as_a_browser_would(self) -> None:
        self.assertEqual(self.md("<p>un  \n   deux&nbsp;trois</p>"), "un deux trois")

    def test_bold_italic_and_strike_use_the_markers_the_product_reads(self) -> None:
        self.assertEqual(self.md("<b>gras</b> <i>penché</i> <s>barré</s>"), "**gras** _penché_ ~~barré~~")

    def test_emphasis_keeps_its_spaces_outside(self) -> None:
        self.assertEqual(self.md("un<b> gras </b>mot"), "un **gras** mot")

    def test_a_link_named_otherwise_keeps_both(self) -> None:
        self.assertEqual(self.md('<a href="https://a.example/x">ici</a>'), "[ici](https://a.example/x)")
        self.assertEqual(self.md('<a href="https://a.example/x">https://a.example/x</a>'), "https://a.example/x")
        self.assertEqual(self.md('<a href="mailto:a@b.example">a@b.example</a>'), "a@b.example")

    def test_headings_start_at_two_hashes(self) -> None:
        # One hash opens a channel in the product.
        self.assertEqual(self.md("<h1>Titre</h1><p>texte</p>"), "## Titre\ntexte")

    def test_a_numbered_list_and_a_nested_one_flatten_into_items(self) -> None:
        self.assertEqual(
            self.md("<ol><li>un</li><li>deux<ul><li>deux a</li></ul></li></ol>"),
            "1. un\n2. deux\n- deux a",
        )

    def test_a_quotation_quotes_every_line(self) -> None:
        self.assertEqual(self.md("<blockquote><p>un</p><p>deux</p></blockquote>"), "> un\n> deux")

    def test_inline_code_is_not_formatted(self) -> None:
        self.assertEqual(self.md("<code>*ptr</code> et <b>gras</b>"), "`*ptr` et **gras**")

    def test_an_emoji_is_its_character(self) -> None:
        self.assertEqual(self.md('Bravo <emoji id="1f389_party" alt="\U0001f389" title="Fête"></emoji>'), "Bravo \U0001f389")

    def test_a_link_the_reader_cannot_close_keeps_the_older_form(self) -> None:
        # A space in the address, or a bracket in the words, would cut a named link in the middle.
        self.assertEqual(self.md('<a href="https://a.example/un deux">ici</a>'), "ici (https://a.example/un deux)")
        self.assertEqual(self.md('<a href="https://a.example/x">un [mot]</a>'), "un [mot] (https://a.example/x)")
        # A balanced parenthesis in the address is fine.
        self.assertEqual(
            self.md('<a href="https://fr.wikipedia.org/wiki/Rust_(langage)">Rust</a>'),
            "[Rust](https://fr.wikipedia.org/wiki/Rust_(langage))",
        )

    def test_a_table_is_a_pipe_table_with_its_dashed_row(self) -> None:
        html = "<table><tr><th>Nom</th><th>Rôle</th></tr><tr><td>Alice</td><td>Direction</td></tr></table>"
        self.assertEqual(self.md(html), "| Nom | Rôle |\n| --- | --- |\n| Alice | Direction |")

    def test_a_table_without_a_header_row_uses_its_first_row_and_pads_short_rows(self) -> None:
        html = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>"
        self.assertEqual(self.md(html), "| a | b |\n| --- | --- |\n| c | |")

    def test_a_bar_inside_a_cell_does_not_cut_the_row(self) -> None:
        html = "<table><tr><th>x</th></tr><tr><td>a | b</td></tr></table>"
        self.assertEqual(self.md(html), "| x |\n| --- |\n| a \u00a6 b |")

    def test_a_mention_of_somebody_who_cannot_be_an_account_is_their_name(self) -> None:
        mentions = [{"id": 0, "mentionText": "Eve", "mentioned": {"user": {"id": "x", "userIdentityType": "federatedUser"}}}]
        self.assertEqual(self.md('<at id="0">Eve</at> ?', mentions, person=lambda user, name: None), "@Eve ?")

    def test_a_mention_of_the_channel_calls_the_channel(self) -> None:
        mentions = [{"id": 0, "mentionText": "General",
                     "mentioned": {"conversation": {"id": "19:x", "conversationIdentityType": "channel"}}}]
        self.assertEqual(self.md('<at id="0">General</at> réunion', mentions), "@channel réunion")

    def test_two_different_people_are_two_mentions(self) -> None:
        mentions = [
            {"id": 0, "mentionText": "Alice", "mentioned": {"user": {"id": "A", "userIdentityType": "aadUser"}}},
            {"id": 1, "mentionText": "Bob", "mentioned": {"user": {"id": "B", "userIdentityType": "aadUser"}}},
        ]
        self.assertEqual(self.md('<at id="0">Alice</at> <at id="1">Bob</at>', mentions), "@{A} @{B}")

    def test_plain_text_bodies_stay_as_written(self) -> None:
        self.assertEqual(teams.to_markdown("un *deux*", "text", [], None).markdown, "un *deux*")

    def test_an_image_from_elsewhere_is_its_address(self) -> None:
        self.assertEqual(self.md('<p>regarde <img src="https://media.example/chat.gif"></p>'), "regarde https://media.example/chat.gif")


class Details(unittest.TestCase):
    def test_instants_are_written_one_way(self) -> None:
        self.assertEqual(teams.iso("2021-03-28T21:11:12.395Z"), "2021-03-28T21:11:12Z")
        self.assertEqual(teams.iso("2022-08-03T20:43:36.2573447Z"), "2022-08-03T20:43:36Z")
        self.assertEqual(teams.iso("2022-08-03T22:43:36+02:00"), "2022-08-03T20:43:36Z")
        self.assertIsNone(teams.iso("0001-01-01T00:00:00Z"))
        self.assertIsNone(teams.iso(None))

    def test_a_reaction_is_a_character_or_an_honest_name(self) -> None:
        self.assertEqual(teams.reaction_emoji({"reactionType": "like"}), "\U0001f44d")
        self.assertEqual(teams.reaction_emoji({"reactionType": "\U0001f600"}), "\U0001f600")
        self.assertEqual(teams.reaction_emoji({"reactionType": "custom", "displayName": "Notre Logo"}), ":notre_logo:")

    def test_the_organisation_is_read_off_the_token(self) -> None:
        self.assertEqual(teams._claim(token_for("abc"), "tid"), "abc")
        self.assertIsNone(teams._claim("not-a-token", "tid"))


if __name__ == "__main__":
    unittest.main()
