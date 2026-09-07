# Development

Local setup and workflow for Ruchoir. English only, like everything in the repo.

## Prerequisites

- Rust toolchain pinned in `rust-toolchain.toml` (installed automatically by `rustup`).
- Node version pinned in `.nvmrc`, with `pnpm` via Corepack (`corepack enable`).
- Docker + Docker Compose for the full stack.

## First run

```bash
# 1. Configure the environment.
cp .env.example .env   # then fill in values (never commit .env)

# 2. Build the web bundle (static export to apps/web/out).
pnpm install
pnpm --filter @ruchoir/web build

# 3. Run the API, which serves the bundle at http://localhost:8080.
cargo run -p ruchoir-api
```

Open http://localhost:8080. The landing page probes `/api/v1/health`. The interactive API
reference (MielApi) is at `/docs` and the raw spec at `/api/openapi.json`.

## Fast iteration

Do not use Docker for the inner dev loop: rebuilding the image compiles the API in release
mode every time. Instead:

- **API:** run it natively for fast incremental debug builds. It serves the web bundle from
  `apps/web/out`. Until the API talks to the databases, no infra is needed.
  ```bash
  cargo run -p ruchoir-api
  ```
- **Web:** use the dev server for hot reload.
  ```bash
  pnpm --filter @ruchoir/web dev
  ```
- **`docker compose up` without `--build`** reuses the existing image; only pass `--build`
  when the API source changed. Image rebuilds are cached (BuildKit cache mounts), so after the
  first one only changed code recompiles.

> **`.env` describes your machine, not the container.** The API loads it on `cargo run`, while
> `docker-compose.yml` sets the container's own `RUCHOIR_API_PORT`, `RUCHOIR_API_HOST`,
> `RUCHOIR_WEB_DIST` and `S3_ENDPOINT` in the service definition and ignores the file's values for
> them. Putting a
> container path such as `/srv/ruchoir/web` in `RUCHOIR_WEB_DIST` therefore breaks only the host
> run, and it fails quietly: the API starts, serves no bundle, and every page is a 404. Same trap
> with `RUCHOIR_API_PORT=0`, which binds a random free port; that is deliberate when 8080 is taken
> (the chosen port is printed at startup) but surprising if you forgot it was set. Real environment
> variables win over the file, so `RUCHOIR_API_PORT=8080 cargo run -p ruchoir-api` overrides it for
> one run.

## Full stack with Docker

```bash
docker compose up --build
```

Starts PostgreSQL, Valkey, Garage and the API (which bundles and serves the web export).
Use this for integration and to mirror production, not for the inner loop.

## Optional dev TLS

```bash
scripts/dev-tls.sh
export RUCHOIR_TLS_CERT="$PWD/certs/dev-cert.pem"
export RUCHOIR_TLS_KEY="$PWD/certs/dev-key.pem"
cargo run -p ruchoir-api --features tls
```

## First run of a new instance

A fresh installation has no account, and the dev seed refuses to run outside development because it
fabricates demo data. `bootstrap` creates the first administrator, and refuses once any account
exists, so it cannot be used to add a second one later:

```bash
RUCHOIR_ADMIN_EMAIL=admin@example.fr \
RUCHOIR_ADMIN_NAME="Camille Roussel" \
RUCHOIR_ADMIN_SPACE="Atelier Nantes" \
  cargo run -p ruchoir-api -- bootstrap < /path/to/password-file
```

The password comes from standard input, so it stays out of the environment and out of shell history;
`RUCHOIR_ADMIN_PASSWORD` is accepted instead when a script needs it. It goes through the same policy
the sign-up endpoint enforces, so the first account is not the weakest one on the instance.
`RUCHOIR_ADMIN_SPACE` is optional: without it the account creates its own space on first sign-in.

Everyone else joins through an invitation from inside the app; there is no second bootstrap.

## Quality gates

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
pnpm --filter @ruchoir/web lint
scripts/check-deps.sh   # outdated + security audit sweep
```

## API reference

The API documents itself. The OpenAPI 3.1 document is generated from the code (route
attributes and typed schemas) and served at:

```
http://localhost:8080/api/openapi.json
```

An interactive reference (MielApi) is served at `http://localhost:8080/docs`. It is our own
renderer: a single self-contained page (`apps/web/public/docs/index.html`) that fetches the live
spec from `/api/openapi.json` and renders it. No third-party viewer, no CDN, no build step, so it
satisfies the strict CSP by construction. The raw `/api/openapi.json` also works on its own.

## Object storage keys (Garage)

The API reaches Garage over the S3 protocol with an access key/secret pair. Unlike the
database and RPC secrets (which services adopt straight from `.env`), **S3 keys must be
created inside Garage**: a key is only valid if Garage knows it. A fresh single-node Garage
also needs a cluster layout and a bucket before it can store anything.

One command does all of it, after `docker compose up`:

```bash
scripts/bootstrap-garage.sh
```

It reads the key pair and bucket name from `.env`, so what Garage is told about is by construction
what the API will present. Every step checks the state it wants first, so re-running it is safe and
does nothing on an instance that is already set up.

It runs on the host rather than as a service in the stack because the Garage image ships no shell,
so the sequence cannot execute inside it; `docker compose exec` is how the CLI is reached. Garage's
CLI flags can change between versions, so if a step is rejected, check
`docker compose exec garage /garage <subcommand> --help` and fix the script rather than working
around it by hand.

The API tells you whether this was done: it probes the store once at startup and logs `object store
ready`, or a warning naming this script. Until then file metadata and the folder tree work and the
byte endpoints answer `503`, so an instance without object storage is usable, just without files.

`S3_ENDPOINT` is the same trap: `http://garage:3900` is a hostname that exists only on the compose
network, and on the host it fails with a retry then a `502` on every upload. The example file
therefore carries the published port (`http://localhost:3900`), which is what the host run needs; the
compose service overrides it with the container name for itself. With no S3
credentials set, the API still serves file metadata and the folder tree, and returns `503` for file
bytes (upload, download, preview, thumbnail).

## Troubleshooting

- **`postgres` exits with a `/var/lib/postgresql/data (unused mount/volume)` error.** Postgres
  18+ images changed the data location; the volume must mount at `/var/lib/postgresql`. If you
  hit this after an image bump, recreate the volume: `docker compose down -v && docker compose up`.
- **Valkey warns about `vm.overcommit_memory`.** This is a host kernel setting (not namespaced,
  so it cannot be set per-container). On Linux:
  `echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-ruchoir-valkey.conf && sudo sysctl --system`.
- **`Bind for 0.0.0.0:8080 failed: port is already allocated`.** Another local process holds
  port 8080. Set `RUCHOIR_HOST_PORT` in your `.env` to a free port (the container still listens
  on 8080 internally), then `docker compose up` again.

## Dependency freshness

Pin the latest **stable** release of every dependency, verified against the live registry
(npm / crates.io), not from memory. A local Git hook reminds you whenever a manifest
changes; `scripts/check-deps.sh` runs the full outdated + audit sweep on demand, and CI runs
the audit on every push.
