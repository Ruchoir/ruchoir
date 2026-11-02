#!/usr/bin/env bash
#
# Check "memory" of ruchoir-watch: at least 10 percent of the memory is available (MemAvailable;
# WATCH_MEMINFO points elsewhere, for tests).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

meminfo="${WATCH_MEMINFO:-/proc/meminfo}"
[ -r "$meminfo" ] || check_unknown "cannot read $meminfo"
total="$(awk '/^MemTotal:/ {print $2}' "$meminfo")"
avail="$(awk '/^MemAvailable:/ {print $2}' "$meminfo")"
case "$total$avail" in *[!0-9]* | "") check_unknown "MemTotal or MemAvailable missing in $meminfo" ;; esac
[ "$total" -gt 0 ] || check_unknown "MemTotal is zero"
pct=$((avail * 100 / total))
if [ $((avail * 100)) -lt $((total * 10)) ]; then
  check_fail "only ${pct}% of the memory is available"
fi
check_ok "${pct}% of the memory is available"
