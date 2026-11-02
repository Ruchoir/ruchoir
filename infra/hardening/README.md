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

## Lot 4: system hygiene

`install hygiene` (after `watch`, whose check helpers it uses), on both servers:

- **Docker daemon** (`/etc/docker/daemon.json`, merged into what is there): `local` log driver with
  10 MB x 5 per container, `no-new-privileges`, `live-restore`. The installer reloads the daemon and
  never restarts it (a restart would stop the containers on a host that does not have `live-restore`
  yet): live-restore applies at once, the log driver and `no-new-privileges` at the next daemon start,
  which the automatic reboot brings. Containers keep the log driver they were created with, so
  recreate them (a deploy does) to move their logs to the new one.
- **Kernel** (`/etc/sysctl.d/60-ruchoir.conf`): no redirects or source routing, martians logged,
  loose reverse-path filter (2: strict drops legitimate replies on Docker's bridges),
  `kptr_restrict`, `dmesg_restrict`, no unprivileged eBPF, protected FIFOs and regular files, no
  core dumps from setuid programs. `net.ipv4.ip_forward` stays on: Docker needs it.
- **SSH** (`/etc/ssh/sshd_config.d/50-ruchoir.conf`): forwarding off except for the administrator's
  account, 20 s login grace, keep-alive 300 s x 2, modern key exchange, ciphers and MACs only. Applied
  through `ruchoir-guard apply sshd 5`: confirm from a new session or it reverts by itself. The
  `deploy` and `backup-pull` keys stay forced-command.
- **Reboot:** unattended-upgrades reboots at 05:15 UTC when an update needs it (after the 03:36
  backup and the 04:30 pull). `ruchoir-reboot-notice` mails at 05:10 when one is pending and again at
  boot; the `reboot-pending` check of `ruchoir-watch` fails if a requested reboot is over 36 hours old.
- **Pinned images:** `ruchoir-image-report` runs weekly (Monday, UTC) and mails the running
  PostgreSQL, Valkey, Garage and office engine images that have a newer patch release on Docker Hub
  or ghcr.io. It pulls and changes nothing. Those registries are US hosted (Golden rule 2), so the
  timer is installed but only enabled when the env file says `HARDENING_IMAGE_REPORT=on`.

Not part of the installer: the Lynis audits (start and end) are run by hand.

### Containers (`docker-compose.yml`)

Every service has `no-new-privileges`. PostgreSQL and Valkey start as root, fix the owner of their
data and drop to their own user, so they keep four capabilities (`CHOWN`, `DAC_OVERRIDE`, `SETGID`,
`SETUID`) and nothing else; the API and Garage keep none. All four have a read-only root; the writable
places are their volumes, a `tmpfs` for PostgreSQL (`/tmp`, `/run/postgresql`) and a capped `tmpfs`
for the API (`/tmp`, where the document viewer's LibreOffice works). The office engine only gets
`no-new-privileges`: it bundles several services and writes widely, and its restricting is a separate
step to measure on the engine itself.

A change here is tested on a throwaway project (`ruchoir-hardentest`, own volumes, nothing published
but the API on localhost): cold start on empty volumes, bootstrap, sign-in, an upload and its
download, a document preview, then a restart of the whole stack.

## Tests

```bash
bash infra/hardening/tests/run.sh
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable -x -S warning \
  infra/hardening/install infra/hardening/common/* infra/hardening/watch/ruchoir-watch \
  infra/hardening/watch/*.sh infra/hardening/watch/checks.d/*.sh \
  infra/hardening/hygiene/install.sh infra/hardening/hygiene/ruchoir-* \
  infra/hardening/hygiene/checks.d/*.sh infra/hardening/tests/*.sh
```

## Where each package comes from

Golden rule 2 (`AGENTS.md`): every package's origin and the services it calls are written here
before it is installed.

| Package | Origin | Source used |
|---|---|---|
| curl, rsync (`rrsync`), systemd, nginx | community, distribution packages | Ubuntu archive |
| openssl (certificate dates), curl | community, distribution packages | Ubuntu archive |
| unattended-upgrades, OpenSSH server (`sshd`), procps (`sysctl`) | community, distribution packages | Ubuntu archive |
| Docker Hub and ghcr.io (read by `ruchoir-image-report` for tag lists only) | Docker Inc. (US) and GitHub (US) | the registries the images are already pulled from; nothing is sent but a tag-list request |
