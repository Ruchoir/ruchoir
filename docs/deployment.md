# Deployment

Putting Ruchoir on a machine other than the one it was written on: a home server, a VPS, a box in a
cupboard. English only, like everything in the repository.

`docs/development.md` covers running it locally for development. This covers running it for people.

## What you need first

- Docker and Docker Compose on the host.
- **A domain name you control**, with a record pointing at the server. A private address
  (`192.168.x.x`) is fine as the target: the name exists so a certificate can.
- A way to obtain a certificate for that name. On a private address that means a **DNS-01**
  challenge, since no public HTTP check can reach the host.

## HTTPS is not optional

The session cookie is `__Host-ruchoir_session` and carries `Secure` unconditionally. Browsers
**refuse** a `Secure` cookie served over plain HTTP, with the single exception of `localhost`. Served
at `http://192.168.1.50:8080`, the API answers every request correctly, the browser stores nothing,
and the user loops back to the sign-in screen with no error to explain it. Passkeys need a secure
context too.

So TLS is the first step of a deployment, not a hardening pass afterwards. Two shapes work:

- **Terminate TLS at a reverse proxy** (Caddy, nginx, Traefik) in front of the API. The API keeps
  speaking plain HTTP on the internal network. Simplest, and the one this section assumes.
- **Terminate in the API**, with `RUCHOIR_TLS_CERT` / `RUCHOIR_TLS_KEY` and a build with the `tls`
  feature. Fewer moving parts, but certificate renewal becomes your problem.

A self-signed certificate technically satisfies the browser's "secure context" once each device has
accepted the exception. It is a poor thing to hand to people you are asking to try the product, and
on phones the exception is awkward to grant.

Behind a proxy, forward the client address (`X-Forwarded-For`): the per-IP rate limit on the
authentication endpoints reads it and otherwise sees only the proxy, which turns a per-attacker limit
into a per-instance one.

The first `docker compose up -d --build` compiles the API from source and takes several minutes on a
modest machine. Later ones reuse the cargo cache and are much shorter.

## Configuration

Copy `.env.example` to `.env` and fill it in. Beyond the values that file documents, four matter more
than the rest on a real deployment:

| Variable | Why it matters |
|---|---|
| `RUCHOIR_PUBLIC_BASE_URL` | Every emailed link (confirmation, password reset, invitation) is built from it, and the WebAuthn relying party is derived from its host. Set it to the address people actually type, including `https://`. |
| `RUCHOIR_SECRET_ENCRYPTION_KEY` | Encrypts MFA secrets at rest. Unset, the API starts on a built-in development key and says so. Generate one with `openssl rand -hex 32`. |
| `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET` | Generate rather than invent: `openssl rand -hex 32`. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Any values you choose; the setup script teaches them to Garage, so both sides agree by construction. |

Quote any value containing spaces or shell punctuation, as the example file now does for
`RUCHOIR_SMTP_FROM`: Compose reads the file with its own parser, but anything that sources it as a
shell will choke on an unquoted address, whose angle brackets are redirections.

`S3_ENDPOINT` stays on its published port in `.env`: the compose service overrides it with the
container name for itself, and the file's value is only ever read by a run on the host.

## Email

Set `RUCHOIR_SMTP_HOST` and its companions. With no relay the API logs messages instead of sending
them, which is right for development and wrong here: password resets and address confirmations
silently never arrive.

One flow does not need it. **An invitation addressed to someone's address activates their account
outright**, since delivery to that mailbox is the same proof a confirmation email would collect. So a
first pilot can run without a relay by inviting people by address, and hand-delivering nothing. A
shareable link proves no address, so an account created from one still waits on a confirmation it
cannot receive: do not use links until the relay is up.

## Bringing it up

```bash
docker compose up -d
scripts/bootstrap-garage.sh
```

The first command starts PostgreSQL, Valkey, Garage and the API. The second prepares the object
store, and is safe to re-run: it reports what it skipped.

Then create the account that will invite everyone else:

```bash
docker compose exec -T \
  -e RUCHOIR_ADMIN_EMAIL=you@example.fr \
  -e RUCHOIR_ADMIN_NAME="Your Name" \
  -e RUCHOIR_ADMIN_SPACE="Your Space" \
  api ruchoir-api bootstrap < /path/to/password-file
```

The `-e` flags are not decoration: `docker compose exec` does not pass the calling shell's
environment into the container, so variables written before the command reach the Compose client and
never the process that reads them. `bootstrap` would then stop on `set RUCHOIR_ADMIN_EMAIL before
running bootstrap` while the variable is plainly set in your shell.

The password comes from standard input so it stays out of the environment and out of shell history.
`bootstrap` refuses once any account exists, so it cannot be used to add a second identity later:
everyone else arrives through an invitation from inside the app.

## Checking it worked

The API's startup log is the fastest diagnosis:

- `object store ready` means Garage is reachable and the bucket is usable. A warning naming
  `scripts/bootstrap-garage.sh` means uploads will fail with a `502` until it is run.
- `no SMTP relay configured` means confirmation and reset emails are only written to this log.
- `RUCHOIR_SECRET_ENCRYPTION_KEY unset` means MFA secrets are encrypted with a key that is in the
  source. Fix before anyone enrols a second factor.

Then sign in as the administrator, open the space settings and invite someone by address. If the
cookie is being rejected you will see it immediately: the sign-in appears to succeed and returns you
to the sign-in screen.

## Not there yet

Deliberate gaps, so nobody discovers them the hard way:

- **No backups.** PostgreSQL, Valkey and Garage all hold state and nothing here dumps them. Do not
  put anything you would miss on an instance until that exists.
- **No guided installer.** This document is the installer.
- **One host for every space.** Spaces are addressed in the path (`/e/{slug}/…`); serving each on its
  own subdomain is a later change, and the client already reads both forms.
