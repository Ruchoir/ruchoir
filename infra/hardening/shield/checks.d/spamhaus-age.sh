#!/usr/bin/env bash
#
# Probe for ruchoir-watch: was the Spamhaus DROP list refreshed in the last 48 hours?
# Prints exactly one line, `ok|fail|unknown MESSAGE`, and exits 0 (the check contract).
# Reads the stamp ruchoir-spamhaus-drop writes after a successful load. Linked into
# /etc/ruchoir-watch/checks.d/ by `infra/hardening/install shield`. STATE_DIR can be overridden
# (tests); CHECK_DRY_RUN=1 prints the file it would read.
set -uo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/ruchoir-hardening}"
file="$STATE_DIR/spamhaus.refreshed"

if [ "${CHECK_DRY_RUN:-0}" = 1 ]; then
  echo "ok would read $file"
  exit 0
fi
if [ ! -r "$file" ]; then
  echo "unknown the Spamhaus list has not been loaded yet"
  exit 0
fi
age=$(($(date +%s) - $(stat -c %Y "$file")))
hours=$((age / 3600))
if [ "$age" -gt $((48 * 3600)) ]; then
  echo "fail the Spamhaus list was last refreshed ${hours} hours ago (limit 48)"
else
  echo "ok the Spamhaus list was refreshed ${hours} hours ago"
fi
exit 0
