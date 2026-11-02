#!/usr/bin/env bash
#
# Install the probe (lot 2) on this server: ruchoir-watch, its checks for this server's role, and
# the systemd timer that runs it every minute. Run through `infra/hardening/install watch`, as root.
# Idempotent: a second run prints only "unchanged" lines.
#
# Every check file is copied to /usr/local/lib/ruchoir-hardening/checks/ and linked from
# /etc/ruchoir-watch/checks.d/. The other lots do the same with their own checks (see "Adding a
# check" in the README). HARDENING_PREFIX and HARDENING_DRY_RUN=1 (no systemctl) serve the tests.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${HARDENING_ROOT:-$(dirname "$here")}"
# shellcheck source=../common/lib.sh
. "$root/common/lib.sh"

prefix="${HARDENING_PREFIX:-}"
dry="${HARDENING_DRY_RUN:-0}"
role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"

lib_dir="$prefix/usr/local/lib/ruchoir-hardening"
checks_src="$lib_dir/checks"
checks_dir="$prefix/etc/ruchoir-watch/checks.d"
unit_dir="$prefix/etc/systemd/system"

# Checks of this lot: every role, then the role's own.
common_checks="peer-http tls-expiry disk memory containers"
case "$role" in
  app) role_checks="backup-age secrets-mode" ;;
  site) role_checks="pull-age" ;;
  *)
    echo "RUCHOIR_HARDENING_ROLE must be app or site" >&2
    exit 1
    ;;
esac
all_checks="peer-http tls-expiry disk memory containers backup-age secrets-mode pull-age"

changed=0
track() { # track "$(install_file ...)": print the line, remember that something changed
  say "$1"
  case "$1" in installed*) changed=1 ;; esac
}

install -d -m 0755 "$checks_dir" "$checks_src" "$prefix/var/lib/ruchoir-hardening/watch"

track "$(install_file "$here/lib.sh" "$lib_dir/watch-lib.sh" 0644)"
track "$(install_file "$here/check-lib.sh" "$lib_dir/check-lib.sh" 0644)"
track "$(install_file "$here/ruchoir-watch" "$prefix/usr/local/sbin/ruchoir-watch" 0755)"
track "$(install_file "$here/ruchoir-watch.service" "$unit_dir/ruchoir-watch.service" 0644)"
track "$(install_file "$here/ruchoir-watch.timer" "$unit_dir/ruchoir-watch.timer" 0644)"
unit_changed=$changed

# link_check NAME: the check file in place, and its link where ruchoir-watch looks.
link_check() {
  local name="$1" target="/usr/local/lib/ruchoir-hardening/checks/$1.sh" link="$checks_dir/$1.sh"
  track "$(install_file "$here/checks.d/$name.sh" "$checks_src/$name.sh" 0755)"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    say "unchanged $link"
  else
    ln -sfn "$target" "$link"
    say "installed $link"
    changed=1
  fi
}

for name in $common_checks $role_checks; do
  link_check "$name"
done

# A check of this lot that does not belong to this role (the role changed): take it away.
for name in $all_checks; do
  case " $common_checks $role_checks " in *" $name "*) continue ;; esac
  if [ -L "$checks_dir/$name.sh" ]; then
    rm -f "$checks_dir/$name.sh"
    say "removed $checks_dir/$name.sh"
    changed=1
  fi
done

if [ "$dry" = 1 ]; then
  say "dry run: systemd not touched"
  exit 0
fi

if [ "$unit_changed" = 1 ]; then
  systemctl daemon-reload
fi
if systemctl is-enabled --quiet ruchoir-watch.timer 2>/dev/null && systemctl is-active --quiet ruchoir-watch.timer; then
  say "unchanged ruchoir-watch.timer (enabled)"
else
  systemctl enable --now ruchoir-watch.timer
  say "installed ruchoir-watch.timer (enabled)"
fi
