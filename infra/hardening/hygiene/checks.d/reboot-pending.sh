#!/usr/bin/env bash
#
# Check "reboot-pending" of ruchoir-watch: an update asked for a reboot and it has not happened for
# too long. Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed
# by hygiene/install.sh as a link in /etc/ruchoir-watch/checks.d/.
#
# unattended-upgrades reboots by itself at 05:15 UTC. A pending reboot younger than 36 hours is
# normal (the update lands in the morning, the reboot comes the next night); older than that, the
# automatic reboot did not work and somebody has to look.
# REBOOT_REQUIRED_FILE points elsewhere (tests).
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

flag="${REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
limit_hours=36

[ -e "$flag" ] || check_ok "no reboot pending"
mtime="$(stat -c %Y "$flag" 2>/dev/null)" || check_unknown "cannot read the age of $flag"
age_hours=$((($(date +%s) - mtime) / 3600))
if [ "$age_hours" -ge "$limit_hours" ]; then
  check_fail "a reboot has been pending for ${age_hours} hours (automatic reboot is at 05:15 UTC)"
fi
check_ok "reboot pending for ${age_hours} hours, due at 05:15 UTC"
