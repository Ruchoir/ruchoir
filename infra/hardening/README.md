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
| `shield/` | both | fail2ban (SSH and nginx jails), the Spamhaus DROP list in nftables, nginx limits and headers, file integrity (AIDE), an alert on SSH logins from unknown addresses |
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
| fail2ban | community, distribution package | Ubuntu archive (no network service: it reads local logs and writes nftables rules) |
| Spamhaus DROP lists (data, not a package) | The Spamhaus Project SLU: registered in Andorra, operated from Geneva (Switzerland) and London (UK) | `https://www.spamhaus.org/drop/drop_v4.json` and `drop_v6.json`, fetched once a day over HTTPS by `ruchoir-spamhaus-drop`. Nothing is sent but the request itself. Free of charge under https://www.spamhaus.org/drop/terms/ (2.1: "provided to you free of charge", 2.2: "designed for use by firewalls and routing equipment"); no clause against use on our own servers. Terms and file formats read on 2026-11-02. The terms also say the lists should not be imported into filters without review: the script validates every list, never loads one that looks wrong, and the alert tells the owner |

The Spamhaus sources used (all read on 2026-11-02): the DROP page https://www.spamhaus.org/drop/
(current files, JSON format, "once per day is more than enough", the text files will be retired,
eDROP merged into DROP on 10 April 2024), the terms https://www.spamhaus.org/drop/terms/, and the
files themselves (JSON lines, one `{"cidr","sblid","rir"}` object per line and a final `metadata`
line; 1753 IPv4 and about 90 IPv6 entries that day). The registration in Andorra and the operations in Geneva and London are as the owner stated them;
the files' copyright line names "The Spamhaus Project SLU". The hosting of `www.spamhaus.org` itself
was not investigated.

### Why not CrowdSec

CrowdSec was the first choice for this lot and was dropped on 2026-11-02 (golden rule 2). The
packages come from a French company, but everything they need at runtime is run by US companies:
the vendor repository (packagecloud.io: Computology, LLC, New York, on Amazon Web Services us-west-1),
the hub that serves scenarios and parsers (`hub-cdn.crowdsec.net`: Amazon CloudFront and
Cloudflare), and the Central API for the community blocklist (`api.crowdsec.net`: AWS eu-west-1,
Ireland; the region is deduced from the published AWS address ranges, not stated by CrowdSec). The
Ubuntu archive's packages (1.4.6) still call the hub and the Central API. Found with `dig`, the AWS
`ip-ranges.amazonaws.com` file and docs.crowdsec.net. The replacement: fail2ban (Ubuntu archive) for
the logs, the Spamhaus DROP list (Europe) for known-bad networks.

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
- fail2ban (`shield/fail2ban/`, installed under `/etc/fail2ban/`): bans through nftables
  (`banaction = nftables-multiport`, an action Ubuntu 26.04's fail2ban 1.1.0 ships), with increasing
  ban times (`bantime.increment`: 1 h, 2 h, 4 h ... up to 4 weeks). Never banned (`ignoreip`):
  loopback, `HARDENING_HOUSE_IP`, `HARDENING_PEER_IP`. Jails:
  `sshd` (Ubuntu's filter, 5 failures in 10 minutes), `ruchoir-auth` (our filter on nginx's access log:
  a `POST` to the login or second-factor endpoints answered 401, 10 in 5 minutes bans for 1 hour),
  `nginx-limit-req` (20 rejections by nginx's rate limit in 5 minutes), `nginx-botsearch` (Ubuntu's
  filter for probes of paths like wp-login.php or phpmyadmin, 5 in 10 minutes). The jails read
  `/var/log/nginx/access.log` and `error.log`; a vhost with its own log file is not seen.
- A normal deploy cannot trigger a ban: a successful login is never counted, and the CI runner's
  address is not known in advance, so `filter.d/sshd.local` also ignores the failures of the `deploy`
  and `backup-pull` accounts (key-only accounts; every other account counts). The 401 jail needs ten
  failed sign-ins, which a deploy never makes. The change itself goes through `ruchoir-guard apply
  fail2ban 10`; confirm from a new session.
- Spamhaus (`shield/spamhaus/`): `ruchoir-spamhaus-drop` (Python 3, standard library only) downloads
  both lists once a day (timer at about 05:20 UTC, and 3 minutes after boot). It refuses a list that
  has a line that is not a network of the right family, is empty, has under 100 IPv4 entries (10 for
  IPv6, whose real list has about 90), or over 100000; the previous set then stays and an alert is
  sent (and after a reboot, with no table loaded, the last good ruleset is reloaded). Any entry that
  covers the house or the other server's address is dropped from the set and the journal says which.
  The result is the nftables table `inet ruchoir_drop` (two interval sets and an `input` chain at
  priority -100, before ufw's chains), replaced in one transaction. It filters traffic to the host
  (nginx, SSH); traffic forwarded to containers is not covered, and Docker ports sit behind nginx.
  First load: `ruchoir-guard apply spamhaus 10`. The `spamhaus-age` check fails when the list was not
  refreshed for 48 hours. To see what it blocks: `sudo nft list table inet ruchoir_drop`.
- AIDE database: `/var/lib/aide/ruchoir.db`, checked nightly at 02:15 UTC. `ruchoir-aide-accept`
  re-baselines it; the deploy script calls it after a good deploy, and an apt hook before/after each
  package run. Run it by hand after your own change in `/etc`.
- SSH login alert: `HARDENING_LOGIN_QUIET_USERS` (optional, space-separated) silences accounts whose
  logins come from changing addresses.
