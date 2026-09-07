# AGENTS.md - apps/api

The Rust backend: the single production service. It owns all business logic, auth,
authorization, real-time transport and data access, and it also serves the static web
bundle. See the root `AGENTS.md` for project-wide rules; this file adds crate-specific
context and takes precedence here.

## Layout

- `src/main.rs`   - entrypoint: config load, tracing, datastore connections, migrations, server
  bind (HTTP, or HTTPS with the `tls` feature), graceful shutdown. Also handles the `migrate`
  subcommand.
- `src/config.rs` - environment-driven configuration with dev defaults.
- `src/db.rs`     - PostgreSQL connection pool via SeaORM.
- `src/cache.rs`  - Valkey connection pool via fred.
- `src/state.rs`  - `AppState` (db + Valkey + config) shared with handlers.
- `src/entities/` - SeaORM entity models mapping the database schema. The auth tables plus the
  collaboration domain: spaces/membership/invitations, the `conversations` supertype with `channels` and
  `dm_conversations`, `messages` and their satellites (reactions, mentions, link previews,
  attachments, pins, saved, read cursors), and `files`/`file_versions`/`file_shares`. Relations are
  added when query code needs them.
- `src/seed.rs`   - the `seed` subcommand: populates a realistic dev workspace (6 fixture accounts +
  an import bot, **two** spaces, channels, messages/threads/reactions, a file with a version and a
  share, DMs, and unread mention notifications). Dev-guarded (`RUCHOIR_ENV=dev` or `--force`).
  **Idempotent per space, not per workspace**: each space is guarded by its own slug, so a space
  added to `seed.rs` later lands in a database that was seeded before it existed instead of being
  skipped. The second space is owned by someone other than the demo account and left unread on
  purpose: it is the one the workspace rail has something to show for.
- `src/auth/`     - the auth core: password hashing (argon2id) + policy with an offline breach
  check, opaque Valkey sessions, the `__Host-` session cookie, the `AuthSession` extractor
  (authorization guard), per-account anti-bruteforce throttle, SMTP mailer + single-use email
  tokens (verification / reset), MFA (TOTP with AES-GCM-encrypted secrets, WebAuthn passkeys,
  HMAC-hashed recovery codes) with a login step-up flow, error type, and the `/api/v1/auth` routes.
- `src/messaging/` - the REST surface over the collaboration schema: `authz` (the conversation
  membership choke point plus audience computation), `error` (`ApiError`), `dto` (response/request
  shapes, kept close to the web data seam), `mentions` (`@`-parsing + resolution), `slug` (the one
  definition of a channel-name / space-slug handle: lowercase, diacritics folded, dashes), and the
  handlers `messages`/`reactions`/`read`/`pins`/`saved`/`conversations`/`channels`/`spaces`/`search`/
  `notifications`. `conversations` also carries the per-space counters behind `GET /me/spaces` (`unread`, from the
  conversations the caller has joined, and `mentions`, from their unread notification inbox): both are
  one grouped SQL statement each, deliberately not the per-conversation `unread_count` helper, which
  is fine for the one space on screen and quadratic for every space on every boot.
  `invitations` is how anyone but a space's creator gets in: an invitation is a durable, listable and
  revocable row (unlike the fire-and-forget Valkey tokens of the auth core) holding only the SHA-256
  digest of its token, addressed to one email or open as a shareable link, and accepting one joins the
  space plus its oldest public channel so the arrival is live at once, publishes `member.joined`
  to the space and writes a `member_joined` system message into that channel in the same transaction
  (only on a real arrival: an existing member re-opening their link announces nothing). A system row
  stores the *event* and an empty body, never a sentence: user-facing copy belongs to the client,
  like the auth error codes. Its `author_id` is the person the notice is about, so the client can name
  them without a second lookup; it stays `None` for a notice about nothing in particular. `spaces` and `channels` carry
  the lifecycle: creating a space (the caller becomes
  its owner and it is born with one public channel, so it is never an empty shell), creating a
  channel, updating one (rename, topic, visibility, and archiving, which is a state that makes it
  read-only rather than a deletion), and joining or leaving one. A public channel is joinable by any
  space member; a private one is joined by invitation only, so the join endpoint refuses it. `search` is
  native-Postgres full-text over messages and file names (a generated `tsvector` with a French
  accent-folding config, plus `pg_trgm` trigram indexes for partial/fuzzy matches), scoped by
  membership. `notifications` is a persisted per-user inbox (mentions, DMs, thread replies) written
  inside the send transaction and pushed over the hub. Every mutation authorizes server-side,
  commits, then hands the resulting event to `realtime` for fan-out.
- `src/realtime/`  - real-time transport and presence: `event` (the versioned push envelope + the
  fan-out wire type, including `channel.created` / `channel.updated`, whose payload is deliberately
  the shared `ChannelSummaryDto` rather than a `ChannelDto`: the latter carries per-caller state that
  must not be broadcast, plus `member.joined`, which is space-scoped rather than
  conversation-scoped because an arrival changes the roster, the mention candidates and the DM
  candidates and hangs off no conversation), `hub` (the local connection registry plus the Valkey pub/sub bridge; a single
  `SubscriberClient` on `rt:fanout`, delivery gated by a publish-time audience), `presence`
  (ephemeral heartbeat + the persistent `users.manual_presence` override; **its audience is frozen at
  connect time**, computed from the space co-members the user had when their socket opened, so any
  code that changes someone's membership while they may already be connected has to call
  `refresh_and_broadcast` afterwards or the new space will show them offline until it reloads), `typing` (throttled,
  ephemeral), and the two transports `ws` (WebSocket) / `sse` (read-only fallback + typing POST).
  State-changing operations are never accepted over the socket; they are REST handlers in
  `messaging`.
- `src/files/`    - the files feature over the collaboration schema: `authz` (space-membership read
  access; owner/space-admin for mutations), `mime` (magic-byte sniffing + kind mapping), `thumbnail`
  (image decode/resize), `tree` (folder listing, create, rename/move, recursive soft-delete),
  `uploads` (multipart upload + versions), `download` (download/preview/thumbnail, streamed back
  through the API), `shares`, and `routes`. Bytes are proxied through the API (the browser never
  contacts the object store), validated server-side (size + sniffed type), stored under opaque keys
  (`spaces/{space}/{file}/{version}`); image uploads get intrinsic dimensions and a stored thumbnail.
- `src/storage/`  - the S3 object-store boundary (`S3Store` over `rust-s3`, path-style addressing).
  Built once at startup and held as `AppState.storage: Option<Arc<S3Store>>`: absent when no
  credentials are configured, in which case file metadata still works and the byte endpoints return
  503. Swapping the backend is a config change (`S3_ENDPOINT`/`S3_REGION`/`S3_BUCKET`/
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`), never a code change. Dev talks plaintext to Garage over
  the Docker network; `rust-s3` is built without any TLS backend (no `aws-lc-rs`, no OpenSSL), so
  TLS-to-store is a later hardening step (the `ring` path).
- `src/http.rs`   - router, health endpoints (incl. DB/Valkey readiness probe), static web
  hosting (SPA fallback), security headers. The SPA fallback answers a browser navigation (an
  `Accept` carrying `text/html`) with `index.html` and a `200`, because the client resolves the
  route: the address-confirmation and password-reset links the API emails point at paths that are
  not files in the bundle. Any other request for a missing path keeps a truthful `404`, so a wrong
  asset path fails loudly instead of receiving HTML. The `messaging`, `realtime` and `files` routers use
  absolute `/api/v1/...` paths and are merged in (not a second `/api/v1` nest) to avoid path overlap.
  The files router carries a raised request-body limit (`RUCHOIR_UPLOAD_MAX_BYTES`, default 100 MiB).
- `src/openapi.rs`- OpenAPI document generated from the code with `utoipa`.

The API needs PostgreSQL and Valkey at startup (see `docker-compose.yml`). Migrations live in the
`ruchoir-migration` crate (`../../migrations`): applied automatically in dev
(`RUCHOIR_AUTO_MIGRATE=true`), or explicitly in prod with `ruchoir-api migrate`.

## Conventions

- Run `cargo fmt` and `cargo clippy --all-targets --all-features -- -D warnings` before any
  commit. CI enforces both.
- Add new routes as typed handlers annotated with `#[utoipa::path(...)]`, then register them
  in `openapi.rs` so `/api/openapi.json` stays complete and in sync.
- The API never trusts the client: authenticate and authorize every request server-side
  (when authentication lands).
- Never log secrets, tokens, passwords or private message content.

> **Known CSP deviation (temporary).** `script-src`/`style-src` include `'unsafe-inline'` in
> `http.rs` because the Next.js static export emits inline hydration scripts/styles and a static
> export cannot use per-request nonces (without it, the client never hydrates). Planned hardening: inject a per-request nonce into `index.html` and the CSP header at the API layer, then
> drop `'unsafe-inline'`.

## Dev TLS (optional)

Plain HTTP by default. For the HTTPS path: `scripts/dev-tls.sh`, then set
`RUCHOIR_TLS_CERT` / `RUCHOIR_TLS_KEY` and build with `--features tls`. TLS uses rustls
with the community `ring` provider (never AWS `aws-lc-rs`), per the no-US-dependency rule.

## Commands

- Run: `cargo run -p ruchoir-api` (loads a local `.env` via dotenvy; real env vars win). Set
  `RUCHOIR_API_PORT=0` for a random free port when 8080 is taken; the bound port is logged.
- Seed dev data: `RUCHOIR_ENV=dev cargo run -p ruchoir-api -- seed` (applies migrations first,
  then populates a demo workspace; refuses to run outside dev, idempotent).
- Test: `cargo test --all-features` (the migration round-trip test needs
  `RUCHOIR_TEST_DATABASE_URL` and is skipped otherwise).
- Serves `RUCHOIR_WEB_DIST` (defaults to `./apps/web/out`), so build the web app first to
  see the full app locally.
- Optionally serves a self-hosted emoji pack under `/emoji` when `RUCHOIR_EMOJI_DIR` is set
  (layout: `sprite.svg`, `animated/*.png`, `manifest.json`). Kept out of the web bundle because it
  can be large; missing files 404 and the client falls back to native emoji. `ServeDir` guards path
  traversal, and a `Cache-Control: public, max-age=604800` layer caps the pack at a couple of
  requests per client per week (not `immutable`, so a rebuilt pack still propagates).
