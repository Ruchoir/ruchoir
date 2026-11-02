#!/usr/bin/env bash
#
# Check "backup-age" of ruchoir-watch (role app): the newest backup archive is younger than 26
# hours (WATCH_BACKUP_DIR points elsewhere, for tests).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

dir="${WATCH_BACKUP_DIR:-/srv/ruchoir/backups}"
[ -d "$dir" ] || check_fail "the backup directory $dir does not exist"
newest="$(find "$dir" -maxdepth 1 -type f -name '*.enc' -printf '%T@\n' 2>/dev/null | sort -n | tail -n 1)"
newest="${newest%.*}"
[ -n "$newest" ] || check_fail "no backup archive in $dir"
age=$(($(watch_now) - newest))
hours=$((age / 3600))
if [ "$age" -gt $((26 * 3600)) ]; then
  check_fail "the newest backup is ${hours} hours old (limit 26)"
fi
check_ok "the newest backup is ${hours} hours old"
