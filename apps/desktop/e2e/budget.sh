#!/usr/bin/env bash
# The lightness budget (docs/specs/desktop, "Lightness budget"), measured on Linux: start the release
# build with no instance, window shown, wait for it to settle, then sum the proportional memory (PSS) of
# the app and its WebKit processes, and the processor time they use over 60 idle seconds.
#
# Usage: RUCHOIR_DESKTOP_BIN=target/release/ruchoir-desktop e2e/budget.sh
# Limits: BUDGET_RSS_MB (default 250), BUDGET_CPU_PERCENT (default 1).
set -euo pipefail
bin="${RUCHOIR_DESKTOP_BIN:?}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache"
# Xvfb has no GPU, so WebKit's DMA-BUF renderer falls back to software OpenGL, which redraws at a cost
# no desktop with a graphics card pays (measured 2026-10-20: 427 MB and 6.5 % idle with it, 244 MB and
# 0.9 % without). The budget is for the app, not for an emulated GPU; real machines are measured by
# hand at each release.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
dbus-run-session -- xvfb-run -a bash -s "$bin" "${BUDGET_RSS_MB:-250}" "${BUDGET_CPU_PERCENT:-1}" <<'INNER'
set -euo pipefail
bin="$1"; max_mb="$2"; max_cpu="$3"
"$bin" > /dev/null 2>&1 &
app=$!
sleep 10
# The app and every process below it (WebKit's web and network processes).
tree() {
  local pid="$1"
  echo "$pid"
  for child in $(cat /proc/"$pid"/task/*/children 2>/dev/null); do tree "$child"; done
}
ticks() {
  local total=0
  for pid in $(tree "$app"); do
    [ -r /proc/"$pid"/stat ] || continue
    # utime and stime, fields 14 and 15, after the command name in parentheses.
    set -- $(sed 's/^.*) //' /proc/"$pid"/stat)
    total=$((total + ${12} + ${13}))
  done
  echo "$total"
}
# Proportional memory (PSS): a library the processes share counts once in total, not once per
# process as summing their resident sizes would.
rss_kb=0
for pid in $(tree "$app"); do
  kb=$(awk '/^Pss:/ {print $2}' /proc/"$pid"/smaps_rollup 2>/dev/null || echo 0)
  rss_kb=$((rss_kb + ${kb:-0}))
done
before=$(ticks); sleep 60; after=$(ticks)
hz=$(getconf CLK_TCK)
cpu=$(awk -v t=$((after - before)) -v hz="$hz" 'BEGIN { printf "%.2f", t / hz / 60 * 100 }')
rss_mb=$((rss_kb / 1024))
kill "$app" 2>/dev/null || true
echo "memory: ${rss_mb} MB (limit ${max_mb}), processor over 60 s idle: ${cpu} % (limit ${max_cpu})"
awk -v m="$rss_mb" -v mm="$max_mb" -v c="$cpu" -v mc="$max_cpu" 'BEGIN { exit !(m <= mm && c <= mc) }'
INNER
