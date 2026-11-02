#!/usr/bin/env bash
#
# Install lot 4, system hygiene, on this server (both roles). Run through the entry point:
#
#   sudo /tmp/ruchoir-hardening/install hygiene
#
# What it does, each step idempotent (a second run prints only "unchanged"):
#   - Docker daemon: /etc/docker/daemon.json (local logs 10 MB x 5, no-new-privileges, live-restore),
#     merged into what is there. The daemon is reloaded, never restarted from here (a restart would
#     stop the containers on a host that does not have live-restore yet). live-restore takes effect
#     at once; the log driver and no-new-privileges are read at the next daemon start (the next
#     automatic reboot at the latest) and then apply to containers created after it.
#   - Kernel: /etc/sysctl.d/60-ruchoir.conf, loaded with sysctl --system.
#   - SSH: /etc/ssh/sshd_config.d/50-ruchoir.conf through `ruchoir-guard apply sshd 5`; it reverts
#     itself in 5 minutes unless `sudo ruchoir-guard confirm sshd` is run from a NEW session.
#   - Updates: automatic reboot at 05:15 UTC, a notice at 05:10 and one at boot, a weekly report of
#     pinned images with a newer patch.
#   - Check for ruchoir-watch: reboot-pending, linked into /etc/ruchoir-watch/checks.d/ (the watch lot
#     installs the probe; install it first). The secrets check belongs to the watch lot (secrets-mode).
#
# HARDENING_PREFIX puts everything under another root, and HYGIENE_SKIP_SYSTEM=1 skips what talks to
# the running system (systemctl, sysctl, docker, sshd, apt): the tests use both.
set -euo pipefail

here="${HARDENING_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
src="$here/hygiene"
prefix="${HARDENING_PREFIX:-}"
skip="${HYGIENE_SKIP_SYSTEM:-0}"

# shellcheck source=../common/lib.sh
. "$here/common/lib.sh"

sshd_dropin="$prefix/etc/ssh/sshd_config.d/50-ruchoir.conf"

# Run by ruchoir-guard (see below): put the SSH settings in place, check them, reload sshd. A
# failure here makes the guard put the previous files back at once.
if [ "${1:-}" = "--apply-sshd" ]; then
  install -D -m 0644 "$src/sshd_config.d/50-ruchoir.conf" "$sshd_dropin"
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  exit 0
fi

changed() { # changed OUTPUT: success when an install_file line says "installed"
  case "$1" in installed*) return 0 ;; *) return 1 ;; esac
}

# --- Docker daemon ---------------------------------------------------------------------------
daemon_dest="$prefix/etc/docker/daemon.json"
merged="$(mktemp)"
trap 'rm -f "$merged"' EXIT
python3 - "$src/daemon.json" "$daemon_dest" >"$merged" <<'PY'
import json, os, sys
ours = json.load(open(sys.argv[1]))
theirs = json.load(open(sys.argv[2])) if os.path.exists(sys.argv[2]) else {}
theirs.update(ours)
print(json.dumps(theirs, indent=2))
PY
out="$(install_file "$merged" "$daemon_dest" 0644)"
say "$out"
if changed "$out" && [ "$skip" != 1 ]; then
  systemctl reload docker
  say "docker reloaded: live-restore is on; the log driver and no-new-privileges apply from the next daemon start"
fi

# --- Kernel -------------------------------------------------------------------------------------
out="$(install_file "$src/sysctl.d/60-ruchoir.conf" "$prefix/etc/sysctl.d/60-ruchoir.conf" 0644)"
say "$out"
if changed "$out" && [ "$skip" != 1 ]; then
  sysctl --system >/dev/null
  say "sysctl reloaded"
fi

# --- SSH ----------------------------------------------------------------------------------------
if [ -f "$sshd_dropin" ] && cmp -s "$src/sshd_config.d/50-ruchoir.conf" "$sshd_dropin"; then
  say "unchanged $sshd_dropin"
elif [ "$skip" = 1 ]; then
  install_file "$src/sshd_config.d/50-ruchoir.conf" "$sshd_dropin" 0644
else
  guard_dir="/etc/ruchoir-hardening/guard.d"
  printf '%s\n' "$sshd_dropin" >"$guard_dir/sshd.files"
  printf '#!/bin/sh\nsystemctl reload ssh 2>/dev/null || systemctl reload sshd\n' >"$guard_dir/sshd.revert"
  chmod 0755 "$guard_dir/sshd.revert"
  ruchoir-guard apply sshd 5 -- env HARDENING_ROOT="$here" bash "$src/install.sh" --apply-sshd
  say "installed $sshd_dropin (pending confirmation: sudo ruchoir-guard confirm sshd, from a new session)"
fi

# --- Automatic reboot, notices and the weekly report -------------------------------------------
install_file "$src/apt.conf.d/52-ruchoir-reboot" "$prefix/etc/apt/apt.conf.d/52-ruchoir-reboot" 0644
if [ "$skip" != 1 ] && ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  apt-get install -y unattended-upgrades
fi
install_file "$src/ruchoir-reboot-notice" "$prefix/usr/local/sbin/ruchoir-reboot-notice" 0755
install_file "$src/ruchoir-image-report" "$prefix/usr/local/sbin/ruchoir-image-report" 0755

units_changed=0
for unit in ruchoir-image-report.service ruchoir-image-report.timer \
  ruchoir-reboot-notice-before.service ruchoir-reboot-notice-before.timer \
  ruchoir-reboot-notice-after.service; do
  out="$(install_file "$src/systemd/$unit" "$prefix/etc/systemd/system/$unit" 0644)"
  say "$out"
  if changed "$out"; then units_changed=1; fi
done
if [ "$skip" != 1 ]; then
  if [ "$units_changed" = 1 ]; then systemctl daemon-reload; fi
  systemctl enable --now ruchoir-reboot-notice-before.timer >/dev/null
  # The report asks Docker Hub and ghcr.io for tag lists (US hosted, Golden rule 2): on only when
  # the env file says HARDENING_IMAGE_REPORT=on, a decision of the administrator.
  if [ "$(env_get HARDENING_IMAGE_REPORT 2>/dev/null || echo off)" = on ]; then
    systemctl enable --now ruchoir-image-report.timer >/dev/null
  else
    systemctl disable --now ruchoir-image-report.timer >/dev/null 2>&1 || true
    say "weekly image report left off (HARDENING_IMAGE_REPORT=on in the env file turns it on)"
  fi
  systemctl enable ruchoir-reboot-notice-after.service >/dev/null
fi

# --- Check for ruchoir-watch ---------------------------------------------------------------------
# Same layout as watch/install.sh (link_check): the file under /usr/local/lib/ruchoir-hardening/checks/,
# linked from /etc/ruchoir-watch/checks.d/.
checks_src="$prefix/usr/local/lib/ruchoir-hardening/checks"
checks_dir="$prefix/etc/ruchoir-watch/checks.d"
install -d -m 0755 "$checks_dir" "$checks_src"
name=reboot-pending
target="/usr/local/lib/ruchoir-hardening/checks/$name.sh"
say "$(install_file "$src/checks.d/$name.sh" "$checks_src/$name.sh" 0755)"
if [ -L "$checks_dir/$name.sh" ] && [ "$(readlink "$checks_dir/$name.sh")" = "$target" ]; then
  say "unchanged $checks_dir/$name.sh"
else
  ln -sfn "$target" "$checks_dir/$name.sh"
  say "installed $checks_dir/$name.sh"
fi
if [ "$skip" != 1 ] && [ ! -r /usr/local/lib/ruchoir-hardening/check-lib.sh ]; then
  say "warning: the watch lot is not installed here yet: reboot-pending reads unknown until it is"
fi
