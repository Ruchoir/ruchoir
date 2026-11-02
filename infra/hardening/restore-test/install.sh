#!/usr/bin/env bash
#
# Install the monthly restore test on the server that serves the instance (role app only).
# Run by `infra/hardening/install restore-test`, as root, on the server. Idempotent: a second run
# prints only "unchanged" lines.
#
# Installs the script, its helpers and compose override, the systemd service and timer (enabled),
# and its watch check (copied to /usr/local/lib/ruchoir-hardening/checks/, linked from
# /etc/ruchoir-watch/checks.d/, as watch/install.sh does). HARDENING_PREFIX installs under another
# root and HARDENING_DRY_RUN=1 skips systemd (tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${HARDENING_ROOT:-$(dirname "$here")}"
src="$root/restore-test"
prefix="${HARDENING_PREFIX:-}"
dry="${HARDENING_DRY_RUN:-0}"

# shellcheck source=../common/lib.sh
. "$root/common/lib.sh"

role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"
if [ "$role" != app ]; then
  echo "the restore test runs on the server that serves the instance (role app)" >&2
  exit 1
fi

lib_dir="$prefix/usr/local/lib/ruchoir-hardening"
changed=0
put() { # put SRC DEST MODE
  local out
  out="$(install_file "$1" "$2" "$3")"
  say "$out"
  case "$out" in installed*) changed=1 ;; esac
}

put "$src/ruchoir-restore-test" "$prefix/usr/local/sbin/ruchoir-restore-test" 0755
put "$src/lib.sh" "$lib_dir/restore-test/lib.sh" 0644
put "$src/compose.restoretest.yml" "$lib_dir/restore-test/compose.restoretest.yml" 0644
put "$src/ruchoir-restore-test.service" "$prefix/etc/systemd/system/ruchoir-restore-test.service" 0644
put "$src/ruchoir-restore-test.timer" "$prefix/etc/systemd/system/ruchoir-restore-test.timer" 0644
unit_changed=$changed

# The watch check: the file where the lots keep theirs, and a link where ruchoir-watch looks.
put "$src/checks.d/restore-test.sh" "$lib_dir/checks/restore-test.sh" 0755
checks_dir="$prefix/etc/ruchoir-watch/checks.d"
link="$checks_dir/restore-test.sh"
target="/usr/local/lib/ruchoir-hardening/checks/restore-test.sh"
install -d -m 0755 "$checks_dir"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
  say "unchanged $link"
else
  ln -sfn "$target" "$link"
  say "installed $link"
fi

# The date of the first install: until a test has succeeded, the check stays quiet for 35 days
# from here.
state="$prefix/var/lib/ruchoir-hardening"
install -d -m 0755 "$state"
if [ ! -e "$state/restore-test.installed" ]; then
  date +%s >"$state/restore-test.installed"
  say "installed $state/restore-test.installed"
else
  say "unchanged $state/restore-test.installed"
fi

if [ "$dry" = 1 ]; then
  say "dry run: systemd not touched"
  exit 0
fi

if [ "$unit_changed" = 1 ]; then
  systemctl daemon-reload
fi
if systemctl is-enabled --quiet ruchoir-restore-test.timer 2>/dev/null && systemctl is-active --quiet ruchoir-restore-test.timer; then
  say "unchanged ruchoir-restore-test.timer (enabled)"
else
  systemctl enable --now ruchoir-restore-test.timer
  say "installed ruchoir-restore-test.timer (enabled)"
fi
