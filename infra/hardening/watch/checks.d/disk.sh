#!/usr/bin/env bash
#
# Check "disk" of ruchoir-watch: the root filesystem is at most 80 percent full
# (WATCH_DISK_MAX and WATCH_DISK_PATH override the limit and the path, for tests).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

max="${WATCH_DISK_MAX:-80}"
path="${WATCH_DISK_PATH:-/}"
pct="$(df --output=pcent "$path" 2>/dev/null | pct_from_df)" || check_unknown "cannot read the usage of $path"
if [ "$pct" -gt "$max" ]; then
  check_fail "$path is ${pct}% full (limit ${max}%)"
fi
check_ok "$path is ${pct}% full"
