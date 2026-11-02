# Server hardening

Scripts that harden the two servers a Ruchoir deployment runs on: the one serving the instance
(role `app`) and the one serving the website, the image registry and the push relay (role `site`).
Each server watches the other.

Nothing here names a host, an address or a secret. Those live in
`/etc/ruchoir-hardening/hardening.env` on each server (root, 0600), whose keys are in
`hardening.env.example`.

## Installing

From a checkout, for each server:

```bash
rsync -a infra/hardening/ <server>:/tmp/ruchoir-hardening/
ssh <server> sudo /tmp/ruchoir-hardening/install common   # once: helpers, and the env file to fill
ssh <server> sudo /tmp/ruchoir-hardening/install <lot>
```

Every install is idempotent: run it again and it prints only `unchanged` lines.

## The pieces

| Directory | Role | What it does |
|---|---|---|
| `common/` | both | `ruchoir-notify` (one alert, by mail), `ruchoir-guard` (a change that could lock us out reverts by itself unless confirmed), `lib.sh` |
| `backup-pull/` | both | the `site` server pulls the `app` server's encrypted backups every night, read-only, and keeps its own history |
| `watch/` | both | `ruchoir-watch`, a probe every minute: the other server, certificates, disk, memory, containers, backup age; one alert per change of state |
| `shield/` | both | CrowdSec (SSH and nginx), nginx limits and headers, file integrity (AIDE), an alert on SSH logins from unknown addresses |
| `hygiene/` | both | Docker daemon, kernel and SSH settings, automatic reboot after a kernel update, weekly report of pinned images with a newer patch |
| `restore-test/` | app | once a month, restores the newest backup into a throwaway, unreachable instance and checks it |

## Lock-out guard

`ruchoir-guard apply NAME MINUTES -- COMMAND` saves the files listed in
`/etc/ruchoir-hardening/guard.d/NAME.files`, arms a systemd timer that puts them back, then runs the
command. Open a **new** SSH session; if it works, `sudo ruchoir-guard confirm NAME`. If nobody
confirms, the timer restores the files, runs `NAME.revert` when there is one, and sends an alert.

## Lot 1: backups pulled by the site server

Order: `install common` on both, then `install backup-pull` on the **site** (it prints a public key),
put that key in `/etc/ruchoir-hardening/backup-pull.pub` on the **app** server, then
`install backup-pull` there (the sshd change goes through `ruchoir-guard`: confirm it from a new
session). Set `RUCHOIR_BACKUP_GROUP=backup-pull` in the app's `.env` so `scripts/backup.sh` writes
archives readable by that group only (0640, directory 0750); the install fixes the existing ones.

The site keeps `/srv/backups/alpha/`: the newest 30 archives plus the first of each month for 12
months, only archives whose `.sha256` matches. `SHA256SUMS.latest` there names the newest one;
`/var/lib/ruchoir-hardening/backup-pull.last-ok` holds the time of the last good run. The backup
key itself never goes to the site (escrow is a manual step, see the spec).

## Probes and alerts

`ruchoir-watch` runs every minute (a systemd timer) on both servers. It runs each check, compares the
result with the last one, and alerts through `ruchoir-notify` **only when the state changes**: once
when something breaks, once when it recovers. A check that cannot tell (a tool missing, DNS down on
this side) reports `unknown` and alerts only after 5 minutes, so silence never reads as "all fine".
Each server watches the other and itself. The state is in `/var/lib/ruchoir-hardening/watch/`
(`NAME.state`, `NAME.last`).

Checks of the `watch` lot: `peer-http`, `tls-expiry`, `disk`, `memory`, `containers` (both roles),
`backup-age`, `secrets-mode` (app), `pull-age` (site).

Known limit: if `ruchoir-watch` itself stops on a server, nothing on that server says so (the other
server's `peer-http` still sees the services, not the probe).

### Adding a check

This is the contract the other lots use. A check is an executable file `NAME.sh` that prints
**exactly one line** and exits 0:

```text
ok MESSAGE        the condition holds
fail MESSAGE      it does not: alerts at once, once
unknown MESSAGE   it could not tell: alerts only after 5 minutes
```

Only the first line counts. No output, any other output, a run longer than 20 seconds or a crash all
count as `unknown`, never as `ok`. Checks run in parallel, as root, and must not write outside their
own files under `/var/lib/ruchoir-hardening/`. The lot's `install.sh` copies the file to
`/usr/local/lib/ruchoir-hardening/checks/NAME.sh` (0755) and links it from
`/etc/ruchoir-watch/checks.d/NAME.sh`; `watch/install.sh` is the model (`link_check`). A check written
in bash can source `check-lib.sh` (installed next to the other helpers) and end with `check_ok`,
`check_fail` or `check_unknown`; it also gets `env_get` and the helpers of `watch/lib.sh`.
`watch/checks.d/disk.sh` is the smallest example. Test it like the others in `tests/watch.sh`, with
a fixture or a stub, never a real server.

## Tests

```bash
bash infra/hardening/tests/run.sh
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable -x -S warning \
  infra/hardening/install infra/hardening/common/* infra/hardening/watch/ruchoir-watch \
  infra/hardening/watch/*.sh infra/hardening/watch/checks.d/*.sh \
  infra/hardening/tests/*.sh
```

## Where each package comes from

Golden rule 2 (`AGENTS.md`): every package's origin and the services it calls are written here
before it is installed.

| Package | Origin | Source used |
|---|---|---|
| curl, rsync (`rrsync`), systemd, nginx | community, distribution packages | Ubuntu archive |
| openssl (certificate dates), curl | community, distribution packages | Ubuntu archive |
| aide | community, distribution package | Ubuntu archive (no network service at runtime) |
| crowdsec 1.4.6, crowdsec-firewall-bouncer 0.0.25 (`HARDENING_CROWDSEC_SOURCE=ubuntu`) | CrowdSec SAS (France), packaged by Ubuntu | Ubuntu archive. The packages are old, and the engine still calls the services below at runtime |
| crowdsec, crowdsec-firewall-bouncer-nftables, current versions (`HARDENING_CROWDSEC_SOURCE=vendor`) | CrowdSec SAS (France) | packagecloud.io/crowdsec/crowdsec, hosted by **Computology, LLC (New York, US)** on **Amazon Web Services** (resolves to AWS us-west-1) |

### CrowdSec: runtime services (checked 2026-11-02, golden rule 2)

The shield installer **refuses to install CrowdSec until `HARDENING_CROWDSEC_SOURCE` is set** in the
env file, because every source depends on infrastructure of US companies. The owner decides.

| Service | What it does | Hosted by (observed) |
|---|---|---|
| Package repository (vendor source only) | the `.deb` files | packagecloud.io: Computology, LLC (US company), AWS us-west-1 |
| Hub (`hub-cdn.crowdsec.net`, `hub-data.crowdsec.net`) | scenarios, parsers and collections the engine downloads (`cscli collections install`, `cscli hub update`) | Amazon CloudFront (US company, global CDN) and Cloudflare (US company). Needed by **both** sources |
| Central API (`api.crowdsec.net`) | the community blocklist; receives the signals about attackers unless sharing is turned off | AWS eu-west-1 (Ireland): EU region, Amazon (US company). Needed by **both** sources |
| Console (`app.crowdsec.net`) | optional web console | not used: the machine is never enrolled |

How this was found: `dig` on the hostnames, then the published AWS address ranges
(`ip-ranges.amazonaws.com`) to place each address; CrowdSec's documentation
(docs.crowdsec.net: installation page, central API page, configuration page). The documentation does
not state where the Central API runs; the region is deduced from the addresses, so it can change.
The packages' publisher is French (CrowdSec SAS), but none of the services it needs at runtime is run
by a European company.

Old engine against today's hub: the hub still serves an index for the `v1.4.6` tag
(`hub-cdn.crowdsec.net/v1.4.6/.index.json` answers 200), so installing collections works in
principle. CrowdSec's installation page also warns that an installed version should be newer than
1.4.6. Not tested (no install is allowed from this work): a 1.4.6 engine may fail to load the current
collections, which are written for newer ones. The community blocklist is pulled through the Central
API either way.

What is kept off: usage metrics to the console (`config.yaml.local`: `disable_usage_metrics_export`).
What stays on, by the owner's choice: pulling the community blocklist and sharing signals (the
addresses CrowdSec blocked) with the Central API.

## Shield lot: files and decisions

- Client address: the API's per-address rate limit keys on the **last** `X-Forwarded-For` entry
  (`ClientIpKey` in `apps/api/src/http.rs`); nginx replaces the header with `$remote_addr`
  (`shield/nginx/proxy-common.conf`, installed as `/etc/nginx/snippets/ruchoir-proxy.conf`).
  The live vhosts must include that snippet instead of their own `proxy_set_header` lines.
- nginx limits are set generously without server log data (50 requests/s per address with a burst of
  200, 30 sign-in requests/minute with a burst of 30, 100 connections): tune them from the access
  logs once a few weeks exist. The house, the other server and loopback are exempt.
- A default server closes connections for unknown names, so any name served by a vhost must be in
  that vhost's `server_name`, and no vhost may keep `default_server` (nginx -t fails, and the
  installer puts the old files back).
- CrowdSec's allowlist (`ruchoir/allowlist`) holds the house, the other server and loopback.
  The sign-in scenario `ruchoir/auth-bf` counts 401 answers on login and second-factor endpoints
  (10 in about 5 minutes bans). A `deploy` or `backup-pull` SSH login is a success, never a failure.
- AIDE database: `/var/lib/aide/ruchoir.db`, checked nightly at 02:15 UTC. `ruchoir-aide-accept`
  re-baselines it; the deploy script calls it after a good deploy, and an apt hook before/after each
  package run. Run it by hand after your own change in `/etc`.
- SSH login alert: `HARDENING_LOGIN_QUIET_USERS` (optional, space-separated) silences accounts whose
  logins come from changing addresses.
