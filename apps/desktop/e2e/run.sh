#!/usr/bin/env bash
# Runs `run.mjs` with what a headless Linux machine lacks: a display (Xvfb), a session bus (for the
# single-instance hand-over of the `ruchoir://` link), a stand-in browser, and a fresh data
# directory so no earlier run's instance or session is reused.
#
# Usage: RUCHOIR_DESKTOP_BIN=... E2E_INSTANCE=https://... E2E_EMAIL=... E2E_PASSWORD=... e2e/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'cp "$work/driver.log" "${E2E_LOG:-/tmp/ruchoir-desktop-e2e.log}" 2>/dev/null; rm -rf "$work"' EXIT
export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache"
export E2E_OPENED_FILE="$work/opened.txt" BROWSER="$here/record-url.sh"
# The app must not borrow a desktop's real settings for which browser opens links.
unset XDG_CURRENT_DESKTOP DESKTOP_SESSION
dbus-run-session -- xvfb-run -a bash -c '
  tauri-driver > "'"$work"'/driver.log" 2>&1 &
  driver=$!
  sleep 2
  node "'"$here"'/run.mjs"; status=$?
  kill $driver 2>/dev/null
  exit $status
'
