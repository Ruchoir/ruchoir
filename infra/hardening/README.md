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

## Probes and alerts

`ruchoir-watch` runs every minute (a systemd timer) on both servers. It runs each check, compares the
result with the last one, and alerts through `ruchoir-notify` **only when the state changes**: once
when something breaks, once when it recovers. A check that cannot tell (a tool missing, DNS down on
this side) reports `unknown` and alerts only after 5 minutes, so silence never reads as "all fine".
Each server watches the other and itself. The state is in `/var/lib/ruchoir-hardening/watch/`
(`NAME.state`, `NAME.last`).

Checks of the `watch` lot: `peer-http`, `tls-expiry`, `disk`, `memory`, `containers` (both roles),
`backup-age`, `secrets-mode` (app), `pull-age` (site). On the site server, `ntfy/` runs the push
service (Compose project `ruchoir-ntfy`, port 8096 on loopback, behind nginx, deny-all by default);
its install prints the certbot command when the certificate is missing and the tokens once.

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
  infra/hardening/watch/*.sh infra/hardening/watch/checks.d/*.sh infra/hardening/ntfy/install.sh \
  infra/hardening/tests/*.sh
```

## Where each package comes from

Golden rule 2 (`AGENTS.md`): every package's origin and the services it calls are written here
before it is installed.

| Package | Origin | Source used |
|---|---|---|
| curl, rsync (`rrsync`), systemd, nginx | community, distribution packages | Ubuntu archive |
| ntfy (`binwiederhier/ntfy:v2.37.0`, Docker Hub) | Philipp Heckel, Germany; Apache-2.0 and GPL-2.0, self-hosted on the site server. Calls `ntfy.sh` (the project's public relay, run by its author; its hosting location was not verified, the decision to use it is recorded in the design spec) only to wake the iPhone app: it carries a message identifier, never the content | Docker Hub, pinned tag, version checked against the Docker Hub tags API and the GitHub release on 2026-11-02 |
| openssl (certificate dates), curl | community, distribution packages | Ubuntu archive |
