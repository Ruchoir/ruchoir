# Live office editing

Status: implemented on branch feat/live-office-editing; end-to-end check passed on the development instance on 2026-10-02 (two people co-editing, one version by the last to leave, autosave after ten minutes, a legacy spreadsheet converted, a blank spreadsheet, a Visio drawing viewed, the editing badge, no request to another host). Trial by the product owners pending. Decision record: [ADR 0003](adr/0003-office-editing-engine.md).

Several people edit the same Word, Excel or PowerPoint file at the same time, in the browser, without
leaving Ruchoir, and every save lands as a new version of the file. The editing itself is done by
**Euro-Office**, run as an optional service next to the API; Ruchoir owns everything around it: who
may open what, where the bytes live, the versions, the look, and the presence of who is editing.

## Goals

- Edit the formats people actually exchange (docx, xlsx, pptx and the OpenDocument family) with the
  highest Microsoft Office fidelity a self-hosted engine offers, several people at once.
- Part of the free AGPL core: nothing behind a licence, nothing that calls home.
- The engine stays replaceable: Ruchoir speaks WOPI, the standard protocol between a file host and an
  online editor, so Collabora Online (or a later engine) can be plugged in without redoing the host.
- An instance without the engine works exactly as today, minus the "Edit" button.

## Non-goals (this iteration)

- Editing from a public share link, by people without an account.
- Completing the engine's Polish and Italian translations (contributed upstream instead, see
  [Upstream work](#upstream-work)).
- A Ruchoir night theme inside the editor (the engine's own dark theme is used by night).
- Collabora Online as a second supported engine (the WOPI host keeps it possible, nobody tests it).
- Opening Visio drawings for anything but reading (the engine only views them).

## Decisions

| Question | Decision |
|---|---|
| Engine | Euro-Office (AGPL-3.0, European fork of OnlyOffice). Chosen over Collabora Online after a side-by-side test on real files, see ADR 0003. |
| Protocol | WOPI only. Euro-Office's richer configuration is passed through WOPI's `docs_api_config` form field, so nothing ties the host to one engine's private API. |
| How the browser reaches the engine | Through the API, on a **dedicated hostname** (`RUCHOIR_OFFICE_PUBLIC_URL`, for example `https://office.example.org`): the API recognises that host and relays it to the engine. The engine is never published, and the browser keeps the editor in an origin of its own, so a flaw in the engine cannot act inside Ruchoir with the signed-in member's session. Costs one more DNS name and certificate per instance. |
| Who may edit | Anyone who may read the file and is not a guest of its space. Renaming, moving and deleting keep today's rule (owner, space owner or admin). |
| Saving | Every save the engine sends is a new version of the file. The engine saves when the last editor leaves, and every 10 minutes during a long session. |
| In scope | Edit existing files, create blank documents, convert legacy formats into a copy, show who is editing in the file list. |
| Theme | Day themes: the "Ruchoir day" engine theme. Night themes: the engine's own dark theme. Language: the person's interface language. |

## How it fits together

```
                          ┌──────────────────────── instance ─────────────────────────────┐
 ruchoir.example.org ──▶  │  API (Ruchoir: app, REST, real time)                           │
   Ruchoir page           │   │                                                            │
     └ frame ──────────┐  │   │                                                            │
 office.example.org ──▶│  │  API, same process: host = office → relay (HTTP + WebSocket)   │
   editor (own origin) ┘  │   │                                   │                        │
                          │   │                                   ▼                        │
                          │   │  internal WOPI listener ◀── WOPI ── office (engine)         │
                          │   ▼  (files, save, locks)                                      │
                          │  Garage (bytes) · PostgreSQL (files, versions) · Valkey        │
                          │  (tokens, locks, who is editing)                               │
                          └────────────────────────────────────────────────────────────────┘
```

1. A member clicks **Edit** on a file. The web client asks the API for an editing session.
2. The API checks the member's rights, mints a short-lived **access token** for that member and that
   file, and answers with the engine's editing address (on the office hostname), the token and the
   engine configuration (theme, language, logo).
3. The client posts the token to that address inside a frame. The office hostname resolves to the
   same API, which sees the host and relays the request to the engine. Ruchoir's session cookie is
   bound to Ruchoir's own host (`__Host-`), so the browser never sends it to the editor's.
4. The engine calls the API's **WOPI listener** on the internal network to read the file, take a
   lock, and later to save. Every save becomes a new version; the members of the space are told in
   real time.

## The engine service

A new service in `docker-compose.yml`, `office`, behind the compose profile `office` so that
`docker compose up` without the profile runs the instance as today.

- **Image:** `ghcr.io/euro-office/documentserver`, pinned to an exact version in `AGENTS.md` like
  every other dependency (9.3.4 was tested on 2026-10-01; the registry tags that image
  `v9.3.4-hotfix.1`, which is the pin).
- **Network:** internal only. No published port: the browser reaches it through the API's relay, the
  API reaches it by its service name.
- **Resources:** a memory limit (`mem_limit`, 4 GB by default, configurable), so the engine can never
  starve the database or the API on a shared host. Measured: 2.1 GB at rest, 7 GB of disk for the
  image. The deployment guide states these numbers.
- **Settings** (environment of the engine container): `WOPI_ENABLED=true`, `JWT_ENABLED=true` with
  `OFFICE_JWT_SECRET` from `.env` (the engine refuses its own non-WOPI API without a signed token;
  Ruchoir never calls that API, so the secret is optional and the engine draws a random one when it
  is empty),
  `ALLOW_PRIVATE_IP_ADDRESS=true` (the WOPI listener is on the private compose network),
  `EXAMPLE_ENABLED=false`.
- **Files mounted read-only from `infra/office/`:**
  - `themes/theme-ruchoir-light.json` (and its dark sibling, kept for when the upstream fix lands)
    into `web-apps/apps/common/main/resources/themes/`: one theme per file, the engine gathers them;
  - `local-production-linux.json` (read after the `local.json` the engine's start script writes):
    engine settings Ruchoir needs, today `services.CoAuthoring.autoAssembly`
    (`enable: true`, `interval: "10m"`) so a long session saves every 10 minutes;
  - `patches/`: the temporary fixes listed under [Upstream work](#upstream-work), each with a header
    naming the engine version it was written against and marking every change `Ruchoir patch`
    (the upstream issue is added once reported).
- **Health:** the engine's `/healthcheck`, used by compose and by the API (see below).

## API

Everything lives in a new module, `apps/api/src/office/`, documented at the top of its `mod.rs` like
the other modules. The feature is enabled when `RUCHOIR_OFFICE_URL` (the engine's internal address, for
example `http://office`) is set; otherwise every route below answers `404` and the instance
capabilities say the feature is off.

### Configuration

| Variable | Meaning |
|---|---|
| `RUCHOIR_OFFICE_URL` | The engine's internal base URL. Unset: feature off. |
| `RUCHOIR_OFFICE_PUBLIC_URL` | The editor's public origin, for example `https://office.example.org`. Required when the feature is on, and must not be Ruchoir's own host (start-up refuses it otherwise). |
| `RUCHOIR_WOPI_LISTEN` | The internal listener for WOPI calls, default `0.0.0.0:8081`. Never published by compose. |
| `RUCHOIR_WOPI_BASE_URL` | How the engine addresses that listener, default `http://api:8081`. |
| `RUCHOIR_OFFICE_TOKEN_TTL_SECS` | Lifetime of an access token, default 10 hours (a working day in one session). |

### Discovery (`discovery.rs`)

The engine publishes the formats it handles and the address of each action (`edit`, `view`,
`convert`) at `/hosting/discovery`. The API reads it from the engine directly at start and every
hour, sending `X-Forwarded-Host: <office host>` and `X-Forwarded-Proto` so that the addresses it gets
back are the public ones the browser must use, and keeps it in memory:

- the extensions that can be edited, viewed, or converted (and to what);
- the address template of each action, its optional parameters (`<ui=UI_LLCC&>` and the like) filled
  or dropped.

When the engine does not answer, the feature reports itself unavailable rather than failing per
request.

### The relay (`proxy.rs`)

A request whose `Host` is the office hostname never reaches Ruchoir's routes: the outermost layer of
the API's router sees the host and hands the request to the relay, HTTP and WebSocket, streaming both
ways. Conversely, the relay answers nothing on Ruchoir's own host.

- `X-Forwarded-Host` is set to the office host and `X-Forwarded-Proto` to its scheme, which is how
  the engine builds its own addresses. The engine sits at the root of its hostname, so no path is
  rewritten.
- **No credential crosses:** any `Cookie` and `Authorization` header is removed before the request
  leaves for the engine (the browser should send none, the relay makes sure), and `Set-Cookie` from
  the engine is dropped.
- The engine's pages carry `frame-ancestors 'self' <Ruchoir's origin>` (`'self'` because the engine's WOPI page frames its own editor page, and every ancestor is checked); Ruchoir's own CSP gains
  `frame-src <office origin>` so it can frame them, and nothing else changes for it.
- Only the paths the editor needs are relayed (observed during the test of 2026-10-01): the versioned
  static tree (`/<version>-<hash>/…`: `sdkjs`, `fonts`, `web-apps`, `doc` (the co-editing socket),
  `dictionaries`, `themes.json`, `plugins.json`, the editor's service worker), the unversioned
  `/web-apps/apps/…` loader, `/hosting/wopi/*` (the editor page), `/cache/files/*`, `/downloadfile/*`
  and `/printfile/*`. Everything else answers `404`: the engine's admin panel, example app,
  converter and command endpoints are never reachable from outside. A path that could become a
  separator or a dot segment once the engine decodes it (`%2F`, `%5C`, `%2E`, `//`) is refused
  too, since the engine's own nginx normalises after the relay's check.
- The editor page (`/hosting/wopi/*`) is relayed only when its single `WOPISrc` names a file of
  this instance's WOPI listener (`RUCHOIR_WOPI_BASE_URL/wopi/files/<uuid>`): the engine fetches
  whatever `WOPISrc` says, so anything else would let anyone send it to another host.

New runtime dependencies for the relay: `hyper-util` (client) and `tokio-tungstenite` (WebSocket
client). Both are community projects already in the dependency tree (the first through axum, the
second as a test dependency, maintained by Snapview, Germany); their origin is recorded in
`AGENTS.md` as golden rule 2 asks.

### Access tokens (`tokens.rs`)

An opaque random token per editing session, stored in Valkey under `office:token:<token>` with the
member, the file, the right (`edit` or `view`) and an expiry. It is what the engine presents on every
WOPI call; it carries nothing readable. Tokens are never logged.

### Editing session endpoints (`sessions.rs`)

| Route | What it does |
|---|---|
| `POST /api/v1/files/{id}/office` | Checks the rights, mints a token, answers `{ file, url, access_token, access_token_ttl, mode, config }`. `url` is on the office hostname; `mode` is `edit`, `view` or `convert`; `config` is the engine configuration below. The request carries the interface `locale` and whether the theme is `light` or `dark`. |
| `POST /api/v1/files/office` | Creates a blank document (`kind`: `document`, `spreadsheet`, `presentation`) in a space folder, from the templates embedded in the API, and answers the new file. |
| `POST /api/v1/files/{id}/office/heartbeat` | The editor page reports it is still open (every 30 s). Feeds "who is editing". |
| `DELETE /api/v1/files/{id}/office/heartbeat` | The editor page was closed. Both carry `?tab=<id>`. |
| `GET /api/v1/files/{id}/office/converted` | The copy this member's conversion produced (`204` until the engine has written it): the editor page names it, reports editing it and moves its address there. |

The engine configuration sent with a session (Euro-Office's `docs_api_config`): the theme id
(`theme-ruchoir-light` by day, the engine's `theme-dark` by night), `features.featuresTips: false`
(the "New" bubbles are half English and sell the engine, not Ruchoir), the Ruchoir mark as `logo`,
`customer.name`, and the interface language. All of it is optional to the engine: another engine
simply ignores the field.

**Blank documents** are three A4 files (docx, xlsx, pptx) taken from Euro-Office's own templates
(AGPL), embedded in the API with `include_bytes!`, under `apps/api/assets/office/`.

### The WOPI listener (`wopi.rs`)

A second listener, bound to `RUCHOIR_WOPI_LISTEN` and never published, serves only WOPI. Keeping it
off the public router means the engine's calls cannot be replayed from the internet even with a
token, and the public surface does not grow.

| WOPI operation | Behaviour |
|---|---|
| `CheckFileInfo` | Name, size, version, owner, the member's id and display name, `UserCanWrite`, `SupportsLocks`, `SupportsUpdate`, `SupportsGetLock`, `UserCanNotWriteRelative` (false only for a convert session), `PostMessageOrigin` (Ruchoir's public origin, the page that frames the editor). |
| `GetFile` | The bytes of the current version, from the object store. |
| `PutFile` | A new version (see [Saving](#saving)). Refused with `409` if the lock does not match, `413` above the upload cap. |
| `Lock`, `Unlock`, `RefreshLock`, `GetLock`, unlock-and-relock | Standard WOPI semantics. The lock lives in Valkey (`office:lock:<file>`, 30 minutes, refreshed by the engine every 10), so several API instances agree. |
| `PutRelativeFile` | Only for the legacy-format conversion: creates the converted copy next to the original (see [Converting](#converting-legacy-formats)). |
| anything else | `501`. |

### Rights (`files/authz.rs`)

A new rule, `ensure_content_editable`: the member may read the file (`ensure_readable`, unchanged)
and is not a guest of its space. A file attached to a private conversation follows the same rule
with the conversation's participants. A session for someone who may read but not edit opens in view
mode. The existing `ensure_editable` (rename, move, delete, upload a version by hand) is unchanged.

### Saving

`PutFile` reuses the version path that `upload_version` already uses, extracted into one shared
function so both go through the same sniffing, hashing, storage and size cap:

- the new version's author is the member whose token the engine used (the engine saves with the
  token of the last person to leave);
- the file's current version, size and update time move forward in the same transaction;
- the members who can see the file receive a new real-time event, `files.updated`, carrying the
  file, so an open file list or viewer shows the new version without a reload;
- the cached PDF preview of the previous version is keyed by version, so it simply stops being used.

The engine saves once, about five seconds after the last editor leaves (observed on 2026-10-01), and
every 10 minutes during a session (`autoAssembly`). A two-hour session therefore leaves at most
twelve versions; that is accepted, versions are cheap and each is a real restore point.

### Converting legacy formats

For a format the engine can only convert (`doc`, `xls`, `ppt`, `pages`, `numbers`, `key`, …), the
viewer offers **Convert to edit**. The session is opened on the engine's `convert` action; the engine
converts and calls `PutRelativeFile`; the API creates a new file next to the original, named after
it with the new extension (suffixed if the name is taken), with the converting member as owner, and
answers its WOPI address. The editor continues on the copy. The original is never touched.

### Who is editing (`presence.rs`)

Opening a document is not editing it: a tab starts reporting only from the first change the editor
makes (the engine's page posts `Edit_Notification` to Ruchoir's page, which CheckFileInfo asks for
with `EditNotificationPostMessage`), so a member who only reads is shown nowhere. From then on, each
editing tab sends a heartbeat carrying a random tab id; the API keeps `office:editing:<file>`
in Valkey (a set of `<member>:<tab>` entries, each alive while its `office:beat:…` key, renewed by
the heartbeat, lives: 60 s). A member edits while any of their tabs beats, so closing one of two tabs
changes nothing. When the set of members changes, the members of the space (not its guests, who
cannot read its files) receive `files.editing` with the file id and the current editors. File
listings carry `editors` (id and display name) for each file, read for the whole folder at once.
A sweep every 30 s re-reads the files someone is in (`office:editing:files`), so a crashed tab
leaves every open file list within a minute and a half, without anyone reloading.

### Instance capabilities

`GET /api/v1/instance` gains `office`: `{ enabled, edit: [extensions], view: [extensions],
convert: [extensions] }`, read from the discovery. The client shows nothing office-related when
`enabled` is false.

## Web client

A new feature folder, `apps/web/features/office/`, rather than more weight in the 950-line
`FilesScreen.tsx`.

- **`OfficeEditor.tsx`:** the editor across the whole window. A Ruchoir band on top (close, file
  name, the avatars of who is editing, "open in a new tab"), then the engine in a frame on the office
  origin, loaded by posting the token to the session's `url`. Closing returns exactly where the
  member was.
- **`useOfficeSession.ts`:** asks for the session, sends the heartbeat every 30 s, says goodbye on
  close and on `pagehide`.
- **`officeTheme.ts`:** maps the Ruchoir theme (eight accents by day or night) to `light` or `dark`
  for the session request.
- **`NewDocumentMenu.tsx`:** "New document / spreadsheet / presentation" in the files toolbar,
  asking for a name, then opening the editor on the new file.
- **`EditingBadge.tsx`:** the "being edited by …" mark on a row of the file list, fed by the
  listing and the `files.editing` event.
- **Opening a file:** a Word, Excel or PowerPoint file (or OpenDocument) opens straight in the
  editor, as in any office suite, in view mode for whoever may not edit; so does a format only the
  editor shows (a Visio drawing). A PDF, a text file and everything else keep the preview (#70),
  which gains **Edit** (editable format, member may edit) and **Convert to edit** (convertible
  format, for which conversion stays a deliberate act). When the editor cannot be reached, a file
  that would open in it falls back to the preview.
- **Address:** `/e/<space>/f/<file>` opens the editor on that file (read once at load, like the
  space and channel addresses in `lib/spaceUrl.ts`), which is what "open in a new tab", a reload and
  a shared link land on.
- **Languages:** every new string in the six dictionaries from the start, French first.

## Look

- **Ruchoir day** (`infra/office/themes/theme-ruchoir-light.json`): a light top bar (the surface
  colour, ink text) rather than an ink one. The engine draws its top-bar icons with the same colour
  variable as the toolbar's, so on an ink bar they disappear (seen on 2026-10-01); a light bar keeps
  them visible without touching the engine, and sits better under Ruchoir's own band.
- Ruchoir greys for the toolbar and panes, the ink for primary actions and focus, sky for selection.
- The engine keeps the document's own page colours, white by night too.

## Security

- **The editor lives in an origin of its own.** Whatever runs in the engine's pages (a flaw in the
  engine, a crafted document) cannot read or drive Ruchoir: the browser keeps the two origins apart,
  and Ruchoir's session cookie (`__Host-`, bound to Ruchoir's host) is never sent to the editor's.
- **But the two hostnames are the same site**, and a `SameSite=Lax` cookie still rides on a
  same-site request. So Ruchoir refuses every state-changing request a browser marks as coming from
  another site (`Sec-Fetch-Site: same-site` or `cross-site`, or, for a browser too old to send it, an
  `Origin` other than Ruchoir's own): script on the editor's origin can reach Ruchoir's address, but
  nothing it sends there can change anything with the member's session. Reads stay cross-origin,
  hence unreadable to it.
- A conversion session reads its original and writes a copy beside it, never the original: its
  token cannot lock or save the file it was opened on.
- The engine is never published; the browser reaches only the relayed editor paths, and only on the
  office hostname.
- Any cookie or authorization header that reaches the relay is removed before the engine sees it.
- WOPI is served on an internal listener only, and every call needs a live token bound to one member
  and one file. Tokens expire, are stored server-side, and are never logged.
- Rights are checked when the session is created and again on every WOPI call (a member removed from
  the space mid-session can no longer save).
- `ALLOW_PRIVATE_IP_ADDRESS` lets the engine reach the WOPI listener. The engine sits on an
  `internal` compose network shared with the API only, so it has no route out at all, and the relay
  refuses any editor page whose `WOPISrc` is not one of this instance's files.
- No outbound call: verified on 2026-10-01 in the browser (only the instance's origin is contacted
  with a document open) and on the engine's own connections (only its internal database, queue and
  cache).

## Deployment

- `docker compose --profile office up -d` adds the engine; `.env.example` documents
  `RUCHOIR_OFFICE_URL`, `RUCHOIR_OFFICE_PUBLIC_URL`, `OFFICE_JWT_SECRET` and the memory limit.
- **A second hostname** for the editor (`office.<domain>`): a DNS record pointing at the same address
  as Ruchoir, and a certificate for it at the reverse proxy (or in the API when it terminates TLS).
  The proxy forwards it to the same API, unchanged.
- `docs/deployment.md` gains a section: what the feature needs (4 GB of RAM for the engine, 7 GB of
  disk for its image, the second hostname), how to turn it on, how to check it (the capabilities say
  `office.enabled`), and that the image is pulled from the GitHub container registry (a registry, not a
  runtime service; mirrorable).
- `AGENTS.md`: the engine pinned in the version table, the new crates and their origin, the module in
  the layout, and the gotchas met while integrating (forwarded host, one theme per file).
- `README.md`: the feature in the feature list.

## Testing

- **Rust, unit:** discovery parsing (Euro-Office's real discovery document as a fixture),
  placeholder filling, relay header rewriting and cookie stripping, token round trip, lock state
  machine.
- **Rust, integration** (against throwaway PostgreSQL and Valkey containers, never a running instance's): CheckFileInfo for a
  member, a guest and a stranger; GetFile; PutFile creates version n+1 with the right author and
  publishes `files.updated`; PutFile with a wrong lock is `409`; PutRelativeFile creates the copy and
  leaves the original; blank document creation; heartbeat and `files.editing`.
- **Web:** `i18n:check`, `lint`, `build`.
- **End to end, on the development instance:** two browser contexts edit the same file, both see each
  other, closing produces one new version; convert a `.doc`; create a blank spreadsheet; the editing
  badge appears and disappears.

## Upstream work

Found during the test of 2026-10-01 on Euro-Office 9.3.4. Each is reported upstream with a proposed
fix; until it is released, the workaround below ships and is removed when the pinned version carries
the fix.

| # | Defect | Workaround in Ruchoir |
|---|---|---|
| 1 | The WOPI editor page overwrites the integrator's `uiTheme` with `undefined` when the `thm` parameter is absent. | `patches/editor-wopi.ejs`: keep the integrator's theme when `thm` is absent (one line). |
| 2 | A custom theme given at launch is selected but not painted (it is only painted on a change). | Also in `patches/editor-wopi.ejs`: the WOPI page, on the editor's own origin, switches away and back once the editor is up. |
| 3 | A custom dark theme is never painted. | None: the engine's own dark theme is used by night. |
| 4 | The Visio viewer's page omits the module configuration the other editors have, so the viewer dies before loading the file. | `patches/visioeditor-index.html`: add the missing `shim` entry. |
| 5 | Translations: about 15 strings per editor left in English in French and German, up to 362 in Italian and 1,008 in Polish. | None now; translations contributed upstream. |

## Risks

- **A young engine.** Euro-Office 1.0 is from June 2026. Mitigation: WOPI keeps Collabora Online one
  configuration away; versions are pinned and upgraded deliberately.
- **Memory.** 2 GB at rest, 4 GB recommended. Mitigation: the feature is optional, the engine is
  capped. On the project's own server (7 GB, production and development side by side) the RAM must be
  raised before production runs the engine.
- **WOPI is the engine's second protocol.** Most Euro-Office deployments use its own API.
  Mitigation: the end-to-end test above runs on every engine upgrade.
