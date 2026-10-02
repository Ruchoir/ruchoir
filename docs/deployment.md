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

The compose file passes `.env` into the API container wholesale, then overrides the handful of
values that must differ inside it. `S3_ENDPOINT` is one: it stays on its published port in `.env`,
since that file's value is only ever read by a run on the host, while the service points itself at
the container name. `DATABASE_URL` and `VALKEY_URL` work the same way.

## Email

Set `RUCHOIR_SMTP_HOST` and its companions if you have a relay. With none the API logs messages
instead of sending them, and `GET /api/v1/instance` says so, which is how the interface knows to stop
offering the flows that would depend on a message arriving.

[Email delivery](email-delivery.md) covers the settings themselves: which relay to point at, why a
home connection cannot deliver mail whatever software is put in front of it, what a domain has to
publish before anything it sends is believed, and how to check that a message really arrives before
counting on it.

**Running with no relay is supported, not a degraded mode.** Delivering mail from a home server is
the hard half of self-hosting it: the software is easy, deliverability is not (a fixed address with a
matching PTR, SPF, DKIM, DMARC, and port 25 outbound, which most residential connections block). So
nothing essential is behind an email:

- **Joining.** An invitation addressed to someone's address activates their account outright, since
  delivery to that mailbox is the same proof a confirmation email would collect. A shareable link
  proves no address, so an account created from one still waits on a confirmation it cannot receive;
  with no relay the invitation dialog says so and points at the addressed form instead.
- **Getting back in.** Someone who has kept their recovery codes resets their own password with one,
  from "Mot de passe oublié". The code is spent and every session of that account is dropped, exactly
  as for an emailed reset.
- **Getting back in when the codes are gone too.** An instance administrator issues a single-use
  reset link from the account menu ("Administration de l'instance") and hands it over in person. They
  never see or set the password, and the account's current one keeps working until the link is used.

The first account is the instance administrator (see `bootstrap` below); the flag is
`users.is_instance_admin` and nothing in the running server grants it. By default the interface shows
a badge on an administrator's profile, so someone locked out knows who to ask; an instance that would
rather not designate anyone turns that off in the administration screen, and administrators still see
each other.

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
- `no SMTP relay configured` means confirmation and reset emails are only written to this log. The
  recovery paths above are what an instance in that state runs on.
- `RUCHOIR_SECRET_ENCRYPTION_KEY unset` means MFA secrets are encrypted with a key that is in the
  source. Fix before anyone enrols a second factor.

Then sign in as the administrator, open the space settings and invite someone by address. If the
cookie is being rejected you will see it immediately: the sign-in appears to succeed and returns you
to the sign-in screen.

## Live office editing (optional)

Several people edit the same Word, Excel or PowerPoint file at once, in the browser, through
Euro-Office (see [office-editing.md](office-editing.md) and ADR 0003). An instance without it works
exactly as before, minus the "Edit" button.

**What it needs.** About 2 GB of memory at rest for the engine, 4 GB recommended (capped by
`OFFICE_MEM_LIMIT`, default `4g`), 7 GB of disk for its image, and a **second hostname**: the editor
runs in an origin of its own, so a flaw in the engine cannot act inside Ruchoir.

**DNS.** A record for `office.<domain>` pointing at the same address as Ruchoir.

**Proxy.** Forward the second name to the same API, with the same headers as Ruchoir (`Host`
preserved, `Upgrade`/`Connection` for the co-editing socket, no buffering, long read timeout), and
give it a certificate. With nginx:

```nginx
server {
    listen 443 ssl;
    server_name office.example.org;
    # ssl_certificate / ssl_certificate_key for office.example.org

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

**`.env`.**

```bash
RUCHOIR_OFFICE_URL=http://office
RUCHOIR_OFFICE_PUBLIC_URL=https://office.example.org
# Optional: the engine's own (non-WOPI) API, which Ruchoir never calls. Empty: a random one per start.
OFFICE_JWT_SECRET=
```

`RUCHOIR_OFFICE_PUBLIC_URL` must not be Ruchoir's own host: the API refuses to start if it is.

**Start it** with `docker compose --profile office up -d`, then check that `GET /api/v1/instance`
answers `"office": { "enabled": true, … }`. The API reads the engine's formats within a minute of the
engine being ready (its first start takes a couple of minutes).

The image is pulled from the GitHub container registry at deployment: a registry, not a runtime
service, and it can be mirrored. The engine runs on an internal network with no route out: it can
reach the API and nothing else. Before moving the engine to a new
version, read `infra/office/README.md`: the temporary patches it mounts are tied to the pinned one.

## Not there yet

Deliberate gaps, so nobody discovers them the hard way:

- **No off-site copies, and no point-in-time recovery.** `scripts/backup.sh` takes the three stores
  into one encrypted archive and `scripts/restore.sh` puts them back (see
  [Backup and restore](backup.md)), but the archives land on the same machine unless you copy them
  elsewhere, and they let you go back to an archive rather than to an arbitrary minute.
- **No guided installer.** This document is the installer.
- **One host for every space.** Spaces are addressed in the path (`/e/{slug}/…`); serving each on its
  own subdomain is a later change, and the client already reads both forms.
