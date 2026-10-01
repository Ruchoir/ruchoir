# Live office editing

Status: design, approved for planning on 2026-10-01. Decision record: [ADR 0003](adr/0003-office-editing-engine.md).

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
| How the browser reaches the engine | Through the API, under `/office/`: one public origin, works whether TLS ends at a proxy or in the API, the engine is never published. |
| Who may edit | Anyone who may read the file and is not a guest of its space. Renaming, moving and deleting keep today's rule (owner, space owner or admin). |
| Saving | Every save the engine sends is a new version of the file. The engine saves when the last editor leaves, and every 10 minutes during a long session. |
| In scope | Edit existing files, create blank documents, convert legacy formats into a copy, show who is editing in the file list. |
| Theme | Day themes: the "Ruchoir day" engine theme. Night themes: the engine's own dark theme. Language: the person's interface language. |

## How it fits together

```
                        ┌───────────────────────── instance ─────────────────────────────┐
 Browser ──HTTPS──▶     │  API ── /office/* (HTTP + WebSocket relay) ──▶ office (engine)    │
  Ruchoir page,         │   │                                               │               │
  editor in a           │   │  internal WOPI listener ◀──── WOPI ───────────┘               │
  same-origin frame     │   ▼  (files, save, locks)                                         │
                        │  Garage (bytes) · PostgreSQL (files, versions) · Valkey (tokens,  │
                        │  locks, who is editing)                                           │
                        └──────────────────────────────────────────────────────────────────┘
```

1. A member clicks **Edit** on a file. The web client asks the API for an editing session.
2. The API checks the member's rights, mints a short-lived **access token** for that member and that
   file, and answers with the engine's editing address (under `/office/`), the token and the
   engine configuration (theme, language, logo).
3. The client posts the token to that address inside a frame. The browser only ever talks to the
   API's origin; the API relays `/office/*` to the engine.
4. The engine calls the API's **WOPI listener** on the internal network to read the file, take a
   lock, and later to save. Every save becomes a new version; the members of the space are told in
   real time.

## The engine service

A new service in `docker-compose.yml`, `office`, behind the compose profile `office` so that
`docker compose up` without the profile runs the instance as today.

- **Image:** `ghcr.io/euro-office/documentserver`, pinned to an exact version in `AGENTS.md` like
  every other dependency (9.3.4 was tested on 2026-10-01).
- **Network:** internal only. No published port: the browser reaches it through the API's relay, the
  API reaches it by its service name.
- **Resources:** a memory limit (`mem_limit`, 4 GB by default, configurable), so the engine can never
  starve the database or the API on a shared host. Measured: 2.1 GB at rest, 7 GB of disk for the
  image. The deployment guide states these numbers.
- **Settings** (environment of the engine container): `WOPI_ENABLED=true`, `JWT_ENABLED=true` with
  `OFFICE_JWT_SECRET` from `.env` (the engine refuses its own non-WOPI API without it),
  `ALLOW_PRIVATE_IP_ADDRESS=true` (the WOPI listener is on the private compose network),
  `EXAMPLE_ENABLED=false`.
- **Files mounted read-only from `infra/office/`:**
  - `themes/theme-ruchoir-light.json` (and its dark sibling, kept for when the upstream fix lands)
    into `web-apps/apps/common/main/resources/themes/`: one theme per file, the engine gathers them;
  - `local.json`: engine settings Ruchoir needs, today `services.CoAuthoring.autoAssembly`
    (`enable: true`, `interval: "10m"`) so a long session saves every 10 minutes;
  - `patches/`: the temporary fixes listed under [Upstream work](#upstream-work), each with a header
    naming the upstream issue and the engine version it was written against.
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
| `RUCHOIR_WOPI_LISTEN` | The internal listener for WOPI calls, default `0.0.0.0:8081`. Never published by compose. |
| `RUCHOIR_WOPI_BASE_URL` | How the engine addresses that listener, default `http://api:8081`. |
| `RUCHOIR_OFFICE_TOKEN_TTL_SECS` | Lifetime of an access token, default 10 hours (a working day in one session). |

### Discovery (`discovery.rs`)

The engine publishes the formats it handles and the address of each action (`edit`, `view`,
`convert`) at `/hosting/discovery`. The API reads it from the engine directly at start and every
hour, sending `X-Forwarded-Host: <public host>/office` and `X-Forwarded-Proto` so that the addresses
it gets back are the public ones the browser must use, and keeps it in memory:

- the extensions that can be edited, viewed, or converted (and to what);
- the address template of each action, its optional parameters (`<ui=UI_LLCC&>` and the like) filled
  or dropped.

When the engine does not answer, the feature reports itself unavailable rather than failing per
request.

### The relay (`proxy.rs`)

`/office/*` on the public router is relayed to the engine, HTTP and WebSocket, streaming both ways.

- The prefix is stripped; `X-Forwarded-Host` is set to `<public host>/office` and
  `X-Forwarded-Proto` to the public scheme, which is how the engine builds its own addresses under a
  sub-path.
- **Ruchoir's credentials never cross:** the session cookie, `Authorization` and any `Cookie` header
  are removed before the request leaves for the engine.
- The global security headers are replaced for this subtree only: the engine's pages are framed by
  Ruchoir (`frame-ancestors 'self'`) and run the engine's own scripts; the rest of the instance keeps
  `frame-ancestors 'none'`.
- Only the paths the editor needs are relayed: the versioned static tree, `/hosting/wopi/*` (the
  editor page), `/doc/*` (the co-editing WebSocket), `/cache/*`, `/fonts/*` and `/themes.json`. The
  engine's admin panel, example app, converter and command endpoints are never reachable from
  outside.

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
| `POST /api/v1/files/{id}/office` | Checks the rights, mints a token, answers `{ url, access_token, access_token_ttl, mode, config }`. `mode` is `edit` or `view`; `config` is the engine configuration below. |
| `POST /api/v1/files/office` | Creates a blank document (`kind`: `document`, `spreadsheet`, `presentation`) in a space folder, from the templates embedded in the API, and answers the new file. |
| `POST /api/v1/files/{id}/office/heartbeat` | The editor page reports it is still open (every 30 s). Feeds "who is editing". |
| `DELETE /api/v1/files/{id}/office/heartbeat` | The editor page was closed. |

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
| `CheckFileInfo` | Name, size, version, owner, the member's id and display name, `UserCanWrite`, `SupportsLocks`, `SupportsUpdate`, `SupportsGetLock`, `UserCanNotWriteRelative` (false only for a convert session), `PostMessageOrigin` (the public origin). |
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

Each open editor page sends a heartbeat; the API keeps `office:editing:<file>` in Valkey (a sorted
set of member ids scored by last heartbeat, entries older than 60 s ignored and pruned). When the set
changes, the members of the space receive `files.editing` with the file id and the current editors.
File listings carry `editors` (ids) for each file. A crashed tab drops out within a minute.

### Instance capabilities

`GET /api/v1/instance` gains `office`: `{ enabled, edit: [extensions], view: [extensions],
convert: [extensions] }`, read from the discovery. The client shows nothing office-related when
`enabled` is false.

## Web client

A new feature folder, `apps/web/features/office/`, rather than more weight in the 950-line
`FilesScreen.tsx`.

- **`OfficeEditor.tsx`:** the editor across the whole window. A Ruchoir band on top (close, file
  name, the avatars of who is editing, "open in a new tab"), then the engine in a same-origin frame,
  loaded by posting the token to the session's `url`. Closing returns exactly where the member was.
- **`useOfficeSession.ts`:** asks for the session, sends the heartbeat every 30 s, says goodbye on
  close and on `pagehide`.
- **`officeTheme.ts`:** maps the Ruchoir theme (eight accents by day or night) to the engine theme,
  and carries the temporary repaint of the engine theme (see [Upstream work](#upstream-work)); it can
  reach into the frame because the engine is served from Ruchoir's own origin.
- **`NewDocumentMenu.tsx`:** "New document / spreadsheet / presentation" in the files toolbar,
  asking for a name, then opening the editor on the new file.
- **`EditingBadge.tsx`:** the "being edited by …" mark on a row of the file list, fed by the
  listing and the `files.editing` event.
- **The viewer (#70)** gains **Edit** (editable format, member may edit) and **Convert to edit**
  (convertible format). Reading keeps the existing PDF preview.
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

- The engine is never published; the browser reaches only the relayed editor paths.
- Ruchoir's session cookie and authorization never reach the engine.
- WOPI is served on an internal listener only, and every call needs a live token bound to one member
  and one file. Tokens expire, are stored server-side, and are never logged.
- Rights are checked when the session is created and again on every WOPI call (a member removed from
  the space mid-session can no longer save).
- `ALLOW_PRIVATE_IP_ADDRESS` lets the engine reach the WOPI listener; the engine has no other private
  address to fetch from inside the compose network.
- No outbound call: verified on 2026-10-01 in the browser (only the instance's origin is contacted
  with a document open) and on the engine's own connections (only its internal database, queue and
  cache).

## Deployment

- `docker compose --profile office up -d` adds the engine; `.env.example` documents
  `RUCHOIR_OFFICE_URL`, `OFFICE_JWT_SECRET` and the memory limit.
- `docs/deployment.md` gains a section: what the feature needs (4 GB of RAM for the engine, 7 GB of
  disk for its image), how to turn it on, how to check it (`/office/healthcheck` through the API's
  capabilities), and that the image is pulled from the GitHub container registry (a registry, not a
  runtime service; mirrorable).
- `AGENTS.md`: the engine pinned in the version table, the new crates and their origin, the module in
  the layout, and the gotchas met while integrating (sub-path headers, one theme per file).
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
| 2 | A custom theme given at launch is selected but not painted (it is only painted on a change). | `officeTheme.ts` switches away and back once the editor is up (same origin). |
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
