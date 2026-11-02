#!/usr/bin/env bash
#
# Install lot 1, backups pulled off the app server. Run through `infra/hardening/install
# backup-pull` (as root, on the server), once on each server, the site first:
#
#   role site   an account for the copies, an SSH key pair made here (the public key is printed),
#               the puller, its service and its 04:30 UTC timer.
#   role app    the account `backup-pull`, allowed to log in with that one key and to do nothing
#               but read the backup directory (rrsync -ro, no shell, no forwarding, only from the
#               site's address); the directory is made readable by that account's group.
#
# For the app role, put the site's public key in /etc/ruchoir-hardening/backup-pull.pub first.
# Idempotent: a second run prints only "unchanged" (and "skipped" for what a dry run leaves out).
# HARDENING_DRY_RUN=1 skips sshd, systemctl and the key scan; HARDENING_PREFIX roots every path
# elsewhere (tests).
set -euo pipefail

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
root="${HARDENING_ROOT:-$(cd "$(dirname "$self")/.." && pwd)}"
dry="${HARDENING_DRY_RUN:-0}"
prefix="${HARDENING_PREFIX:-}"
# shellcheck source=../common/lib.sh
. "$root/common/lib.sh"

role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"
etc="$prefix/etc/ruchoir-hardening"
sshd_dropin="$prefix/etc/ssh/sshd_config.d/40-backup-pull.conf"
backup_dir="${BACKUP_PULL_APP_DIR:-$prefix/srv/ruchoir/backups}"

# ensure_account NAME HOME SHELL: a system account with its own group, created once.
ensure_account() {
  local name="$1" home="$2" shell="$3"
  if getent passwd "$name" >/dev/null; then
    say "unchanged account $name"
    return 0
  fi
  useradd --system --user-group --no-create-home --home-dir "$home" --shell "$shell" \
    --comment "Ruchoir backup copy" "$name"
  say "created account $name"
}

# ensure_dir PATH OWNER GROUP MODE: create or fix a directory, saying what it did.
ensure_dir() {
  local path="$1" owner="$2" group="$3" mode="$4" now
  if [ -d "$path" ]; then
    now="$(stat -c '%U:%G:%a' "$path")"
    if [ "$now" = "$owner:$group:$(printf '%o' "$((8#$mode))")" ]; then
      say "unchanged $path"
      return 0
    fi
  fi
  install -d -o "$owner" -g "$group" -m "$mode" "$path"
  chown "$owner:$group" "$path"
  chmod "$mode" "$path"
  say "fixed $path"
}

apply_sshd() {
  local want="AllowUsers backup-pull"
  install -d -m 0755 "$(dirname "$sshd_dropin")"
  printf '%s\n' "$want" >"$sshd_dropin"
  chmod 0644 "$sshd_dropin"
  sshd -t
  systemctl reload ssh
}

if [ "${1:-}" = "--apply-sshd" ]; then
  apply_sshd
  exit 0
fi

case "$role" in
  site)
    peer="$(env_get HARDENING_PEER_HOST)"
    store="$prefix/srv/backups"
    key="$etc/backup-pull.key"
    known="$etc/backup-pull.known_hosts"

    if [ "$dry" != 1 ]; then
      for tool in rsync ssh ssh-keygen ssh-keyscan flock curl; do
        command -v "$tool" >/dev/null || { echo "$tool is missing: install the package that provides it" >&2; exit 1; }
      done
    fi

    ensure_account backup-store "$store" /usr/sbin/nologin
    ensure_dir "$store" root root 0755
    ensure_dir "$store/alpha" backup-store backup-store 0700
    install -d -m 0755 "$prefix/var/lib/ruchoir-hardening"

    if [ ! -f "$key" ]; then
      install -d -m 0700 "$etc"
      ssh-keygen -q -t ed25519 -N '' -C backup-pull -f "$key"
      chmod 0600 "$key"
      say "created $key"
      say "public key, to put in /etc/ruchoir-hardening/backup-pull.pub on the app server:"
      cat "$key.pub"
    else
      say "unchanged $key"
    fi

    if [ ! -s "$known" ]; then
      if [ "$dry" = 1 ]; then
        say "skipped host key scan (dry run)"
      else
        scanned="$(ssh-keyscan -t ed25519 "$peer" 2>/dev/null || true)"
        if [ -z "$scanned" ]; then
          echo "could not read the host key of the app server; run again once it answers" >&2
          exit 1
        fi
        printf '%s\n' "$scanned" >"$known"
        chmod 0600 "$known"
        say "pinned the app server's host key; check it against the one over there:"
        ssh-keygen -lf "$known"
        say "  (on the app server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)"
      fi
    else
      say "unchanged $known"
    fi

    lib="$prefix/usr/local/lib/ruchoir-hardening/backup-pull-lib.sh"
    changed=0
    while IFS='|' read -r src dest mode; do
      out="$(install_file "$root/backup-pull/$src" "$dest" "$mode")"
      say "$out"
      case "$out" in installed*) changed=1 ;; esac
    done <<EOF
lib.sh|$lib|0644
ruchoir-backup-pull|$prefix/usr/local/sbin/ruchoir-backup-pull|0755
ruchoir-backup-pull.service|$prefix/etc/systemd/system/ruchoir-backup-pull.service|0644
ruchoir-backup-pull.timer|$prefix/etc/systemd/system/ruchoir-backup-pull.timer|0644
EOF

    if [ "$dry" = 1 ]; then
      say "skipped systemd (dry run)"
    else
      [ "$changed" = 0 ] || systemctl daemon-reload
      if systemctl is-enabled --quiet ruchoir-backup-pull.timer 2>/dev/null; then
        say "unchanged ruchoir-backup-pull.timer (enabled)"
      else
        systemctl enable --now ruchoir-backup-pull.timer
        say "enabled ruchoir-backup-pull.timer"
      fi
    fi
    ;;

  app)
    peer_ip="$(env_get HARDENING_PEER_IP)"
    pub="${BACKUP_PULL_PUBKEY_FILE:-$etc/backup-pull.pub}"
    home="$prefix/var/lib/backup-pull"

    ensure_account backup-pull /var/lib/backup-pull /bin/sh
    ensure_dir "$home" root backup-pull 0755
    ensure_dir "$home/.ssh" root backup-pull 0750

    if [ ! -r "$pub" ]; then
      say "no public key at $pub: put the site's key there and run this again (no login is possible meanwhile)"
    else
      type_and_key="$(awk 'NR == 1 { print $1 " " $2 }' "$pub")"
      case "$type_and_key" in
        "ssh-ed25519 "*) ;;
        *) echo "$pub is not an ed25519 public key" >&2; exit 1 ;;
      esac
      staged="$(mktemp)"
      printf 'from="%s",restrict,command="/usr/bin/rrsync -ro /srv/ruchoir/backups" %s backup-pull\n' \
        "$peer_ip" "$type_and_key" >"$staged"
      out="$(install_file "$staged" "$home/.ssh/authorized_keys" 0640)"
      rm -f "$staged"
      say "$out"
      chown root:backup-pull "$home/.ssh/authorized_keys"
    fi

    if [ -d "$backup_dir" ]; then
      ensure_dir "$backup_dir" root backup-pull 2750
      for f in "$backup_dir"/ruchoir-*.tar.gz.enc "$backup_dir"/ruchoir-*.tar.gz.enc.sha256; do
        [ -e "$f" ] || continue
        if [ "$(stat -c '%G:%a' "$f")" != "backup-pull:640" ]; then
          chgrp backup-pull "$f"
          chmod 0640 "$f"
          say "fixed $f"
        fi
      done
      say "reminder: RUCHOIR_BACKUP_GROUP=backup-pull must be set in the app's .env for new archives"
    else
      say "skipped $backup_dir (not there yet)"
    fi

    if [ "$dry" = 1 ]; then
      say "skipped sshd (dry run)"
    elif [ -f "$sshd_dropin" ] && [ "$(cat "$sshd_dropin")" = "AllowUsers backup-pull" ]; then
      say "unchanged $sshd_dropin"
    elif ! sshd -T 2>/dev/null | grep -qi '^allowusers '; then
      # Without an AllowUsers line everyone may log in; adding one would lock the others out.
      say "unchanged sshd (no AllowUsers in force, backup-pull can already log in)"
    else
      install -d -m 0700 "$etc/guard.d"
      printf '%s\n' "$sshd_dropin" >"$etc/guard.d/backup-pull.files"
      printf '#!/bin/sh\nsystemctl reload ssh\n' >"$etc/guard.d/backup-pull.revert"
      chmod 0755 "$etc/guard.d/backup-pull.revert"
      HARDENING_ROOT="$root" RUCHOIR_HARDENING_ROLE="$role" \
        "$prefix/usr/local/sbin/ruchoir-guard" apply backup-pull 10 -- bash "$self" --apply-sshd
      say "installed $sshd_dropin, reverts in 10 minutes unless confirmed."
      say "From a NEW SSH session, check you can still log in, then: sudo ruchoir-guard confirm backup-pull"
    fi
    ;;

  *)
    echo "RUCHOIR_HARDENING_ROLE must be app or site" >&2
    exit 1
    ;;
esac
