#!/usr/bin/env bash
#
# Probe for ruchoir-watch: did the last nightly AIDE check find unaccepted changes, and did it run?
# Prints exactly one line, `ok|fail|unknown MESSAGE`, and exits 0 (the check contract).
# Reads the status line ruchoir-aide-check and ruchoir-aide-accept write. A status older than 36
# hours means the nightly timer did not run: unknown. Linked into /etc/ruchoir-watch/checks.d/ by
# `infra/hardening/install shield`. STATE_DIR can be overridden (tests); CHECK_DRY_RUN=1 prints the
# file it would read.
set -uo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/ruchoir-hardening}"
file="$STATE_DIR/aide.status"

if [ "${CHECK_DRY_RUN:-0}" = 1 ]; then
  echo "ok would read $file"
  exit 0
fi
if [ ! -r "$file" ]; then
  echo "unknown no AIDE status yet"
  exit 0
fi
age=$(($(date +%s) - $(stat -c %Y "$file")))
line="$(head -n 1 "$file" | tr -d '\r')"
case "$line" in
  ok\ * | fail\ * | unknown\ *) ;;
  *) echo "unknown unreadable AIDE status"; exit 0 ;;
esac
if [ "$age" -gt $((36 * 3600)) ]; then
  echo "unknown AIDE has not run for over 36 hours"
  exit 0
fi
printf '%s\n' "$line"
exit 0
