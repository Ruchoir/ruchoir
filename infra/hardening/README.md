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
| `common/` | both | `ruchoir-notify` (one alert, by push and mail), `ruchoir-guard` (a change that could lock us out reverts by itself unless confirmed), `lib.sh` |
| `backup-pull/` | both | the `site` server pulls the `app` server's encrypted backups every night, read-only, and keeps its own history |
| `watch/` | both | `ruchoir-watch`, a probe every minute: the other server, certificates, disk, memory, containers, backup age; one alert per change of state |
| `ntfy/` | site | the self-hosted push service the alerts go through |
| `shield/` | both | CrowdSec (SSH and nginx), nginx limits and headers, file integrity (AIDE), an alert on SSH logins from unknown addresses |
| `hygiene/` | both | Docker daemon, kernel and SSH settings, automatic reboot after a kernel update, weekly report of pinned images with a newer patch |
| `restore-test/` | app | once a month, restores the newest backup into a throwaway, unreachable instance and checks it |

## Lock-out guard

`ruchoir-guard apply NAME MINUTES -- COMMAND` saves the files listed in
`/etc/ruchoir-hardening/guard.d/NAME.files`, arms a systemd timer that puts them back, then runs the
command. Open a **new** SSH session; if it works, `sudo ruchoir-guard confirm NAME`. If nobody
confirms, the timer restores the files, runs `NAME.revert` when there is one, and sends an alert.

## Tests

```bash
bash infra/hardening/tests/run.sh
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable infra/hardening/install infra/hardening/common/* infra/hardening/tests/*.sh
```

## Where each package comes from

Golden rule 2 (`AGENTS.md`): every package's origin and the services it calls are written here
before it is installed.

| Package | Origin | Source used |
|---|---|---|
| curl, rsync (`rrsync`), systemd, nginx | community, distribution packages | Ubuntu archive |
