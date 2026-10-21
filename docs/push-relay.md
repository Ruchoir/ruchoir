# The push relay

The phone apps are woken through Apple (APNs) and Google (FCM), and only the publisher of the apps
may hold the keys that let a server push to them. So instances do not push to phones themselves: they
ask the **push relay** (`apps/push-relay`), run by the publisher, to wake a device, and the relay
sends a constant push. The phone then asks its instances what to show: the push does not say which
one sent it, so a phone signed in to several asks each of them and shows the newest
([ADR 0007](adr/0007-several-instances-in-the-apps.md)). Why, and what crosses:
[ADR 0006](adr/0006-phone-push-relay.md).

```
instance ── POST /v1/send {platform, token} ──▶ relay ── constant push ──▶ Apple / Google ──▶ phone
phone ── GET /api/v1/push/pending (its session there) ──▶ each of its instances ── what to show

read elsewhere:
instance ── POST /v1/sync {platform, token} ──▶ relay ── silent push ──▶ Apple / Google ──▶ phone
phone ── GET /api/v1/notifications?unread=true ──▶ each instance ── icon count, read ones cleared
```

## What it answers

| Request | Answer |
|---|---|
| `GET /health` | `{"status":"ok","apns":true,"fcm":false}`: which vendors have their key |
| `POST /v1/send` `{"platform":"ios"\|"android","token":"…"}` | `202 delivered`; `410 gone` (the instance forgets the device); `400` (not a token, unknown platform); `429` (rate limited: 1,200 a minute per address, 20 a minute per device); `503 not_configured` (that vendor's key is missing); `502 failed` (the vendor refused or could not be reached) |
| `POST /v1/sync`, same body | the silent push saying something was read elsewhere (ADR 0006, amendment of 2026-10-21): to Apple a background push (`content-available`, priority 5), to Google `{"ruchoir":"sync"}` at normal priority. Same answers; its own allowance of 10 a minute per device, so syncs never use up wakes |

It keeps nothing but rate-limit counters, and never logs a token. Behind nginx, which adds TLS and
the caller's address (`X-Real-IP`); the relay itself listens on the loopback only.

## Configuration

From the environment of its container:

| Variable | What |
|---|---|
| `APNS_KEY_FILE` | the Apple push key (`.p8`) |
| `APNS_KEY_ID` | its key id (10 characters, shown next to the key on developer.apple.com) |
| `APNS_TEAM_ID` | the Apple team id |
| `APNS_TOPIC` | the app's bundle id (default `com.ruchoir.app`) |
| `APNS_HOST` | default `api.push.apple.com` (production: every build is signed for the App Store) |
| `FCM_SERVICE_ACCOUNT_FILE` | the Firebase project's service account (JSON) |
| `RELAY_BIND` | default `0.0.0.0:8080` (inside the container) |

A vendor whose key is missing or unreadable is off (`503`); the other keeps working.

## The keys

**Apple.** On developer.apple.com, Certificates, Identifiers & Profiles, **Keys**, "+": a name,
"Apple Push Notifications service (APNs)", Continue, Register, then **Download** (once only, from a
computer: Safari on an iPhone cannot). Note the key's id. One key serves every app of the team, in
production and sandbox.

**Google.** In the Firebase console, a project ("Ruchoir"), an Android app `com.ruchoir.app`:

- its `google-services.json` goes in the repository's Actions secrets as `GOOGLE_SERVICES_JSON` (the
  whole file), for the Android build (`docs/mobile-builds.md`);
- Project settings, **Service accounts**, "Generate new private key": the JSON file is the relay's
  `FCM_SERVICE_ACCOUNT_FILE`. Cloud Messaging API (V1) must be enabled for the project.

Neither key ever goes in the repository, in a chat, or anywhere but the relay's server.

## Running it

The image is built from the repository root:

```bash
docker build -f apps/push-relay/Dockerfile -t ruchoir-push-relay:0.1.0 .
```

### Production (the website's server)

`https://ruchoir.com/push/`, the default `RUCHOIR_PUSH_RELAY_URL` of every instance, on `ruchoir-site`,
deployed by a tag (below). Once, by hand:

- the keys in `/etc/ruchoir-push-relay/` (`apns.p8`, `fcm.json` when there is one, `relay.env` with
  `APNS_KEY_ID` and `APNS_TEAM_ID`), owned by root, group `10002` (the image's user), modes `750`
  and `640`;
- the registry's `site` account may pull `ruchoir/push-relay` (the server's own pull login);
- `infra/push-relay/push-relay-deploy` and `push-relay-deploy-entry` in `/usr/local/sbin` (root,
  `0755`), a key of its own for the `deploy` account bound to the entry
  (`command="/usr/local/sbin/push-relay-deploy-entry",restrict ssh-ed25519 … ci-push-relay`), and
  `/etc/sudoers.d/push-relay-deploy`: `deploy ALL=(root) NOPASSWD: /usr/local/sbin/push-relay-deploy`;
- in nginx's `ruchoir.com` server block (the file comes from the website's repository,
  `deploy/nginx/ruchoir.com.conf`: change it there too):

  ```nginx
  location /push/ {
      proxy_pass http://127.0.0.1:8095/;
      proxy_set_header X-Real-IP $remote_addr;
      client_max_body_size 8k;
  }
  ```

- check: `curl https://ruchoir.com/push/health`.

### Releasing

A tag `push-relay-vX.Y.Z` (`.github/workflows/push-relay-release.yml`) builds the image
(`registry.ruchoir.com/ruchoir/push-relay:vX.Y.Z`), pushes it, and runs `push-relay-deploy` through
the `deploy` account with `infra/push-relay` as the bundle: it pulls the image, starts it
(`/opt/push-relay`, `infra/push-relay/compose.yml`), waits for its health check and puts the previous
image back if it never passes. Log: `/var/log/push-relay-deploy.log`. Secrets
`RELAY_DEPLOY_SSH_KEY`, `RELAY_DEPLOY_KNOWN_HOSTS`, variable `RELAY_DEPLOY_HOST`; the registry
account is release.yml's. The relay ships apart from the instance's `vX.Y.Z` tags: every instance
uses it, whatever version each runs.

### Development

The dev stack runs its own relay (`push-relay` in the local `docker-compose.override.yml`, with the
keys in `~/.config/ruchoir-push-relay/`), and the dev API points at it
(`RUCHOIR_PUSH_RELAY_URL=http://push-relay:8080`). An instance on a private network may use plain
`http` to its relay; anything public uses `https`.

## On the instance

`RUCHOIR_PUSH_RELAY_URL` (default `https://ruchoir.com/push`; empty: phones are left out). The
administrator's push switch covers phones too. The instance only ever sends the platform and the
token; which notifications wake a phone follows the person's preferences, as for a browser.
