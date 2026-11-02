#!/usr/bin/env bash
#
# Check "pull-age" of ruchoir-watch (role site): the last successful backup pull is younger than 26
# hours (the backup-pull lot writes its epoch to backup-pull.last-ok; WATCH_PULL_LASTOK points
# elsewhere, for tests).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

file="${WATCH_PULL_LASTOK:-/var/lib/ruchoir-hardening/backup-pull.last-ok}"
[ -r "$file" ] || check_fail "no successful backup pull is recorded ($file)"
last="$(head -n 1 "$file")"
case "$last" in *[!0-9]* | "") check_unknown "$file does not hold an epoch" ;; esac
age=$(($(watch_now) - last))
hours=$((age / 3600))
if [ "$age" -gt $((26 * 3600)) ]; then
  check_fail "the last backup pull was ${hours} hours ago (limit 26)"
fi
check_ok "the last backup pull was ${hours} hours ago"
