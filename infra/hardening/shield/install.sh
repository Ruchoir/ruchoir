#!/usr/bin/env bash
#
# Install the shield lot on this server: nginx limits and headers, fail2ban (SSH and nginx jails),
# the Spamhaus DROP list in nftables, file integrity (AIDE), an alert on SSH logins from unknown
# addresses.
#
# Run as root, on the server, through the entry point (see infra/hardening/README.md):
#
#   sudo /tmp/ruchoir-hardening/install shield
#
# Reads /etc/ruchoir-hardening/hardening.env: HARDENING_HOUSE_IP and HARDENING_PEER_IP (never
# banned, never in the Spamhaus set), and the alert settings.
#
# Idempotent: a second run prints only "unchanged" lines. Changes that can lock us out go through
# ruchoir-guard; confirm each from a NEW SSH session (`sudo ruchoir-guard confirm NAME`).
#
# HARDENING_DRY_RUN=1 writes under HARDENING_PREFIX (default: a temp dir) and only prints the
# commands that would touch the system (apt, systemctl, nginx, aide, ruchoir-guard).
set -euo pipefail

root="${HARDENING_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
shield="$root/shield"
dry="${HARDENING_DRY_RUN:-0}"
if [ "$dry" = 1 ]; then
  prefix="${HARDENING_PREFIX:-$(mktemp -d)}"
else
  prefix="${HARDENING_PREFIX:-}"
fi

# shellcheck source=../common/lib.sh
. "$root/common/lib.sh"
# shellcheck source=lib.sh
. "$shield/lib.sh"

# run COMMAND...: executes it, or prints it in a dry run.
run() {
  if [ "$dry" = 1 ]; then
    say "dry-run: $*"
  else
    "$@"
  fi
}

# put SRC DEST MODE: install_file under the prefix; sets $changed when it wrote something.
changed=0
put() {
  local out
  out="$(install_file "$1" "$prefix$2" "$3")"
  say "$out"
  case "$out" in installed*) changed=1 ;; esac
}

# put_rendered DEST MODE COMMAND...: the command's output becomes the file.
put_rendered() {
  local dest="$1" mode="$2" tmp
  shift 2
  tmp="$(mktemp)"
  "$@" >"$tmp"
  put "$tmp" "$dest" "$mode"
  rm -f "$tmp"
}

house="$(env_get HARDENING_HOUSE_IP)"
peer="$(env_get HARDENING_PEER_IP)"
role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"

# ---------------------------------------------------------------- nginx
install_nginx() {
  if [ "$dry" != 1 ] && ! command -v nginx >/dev/null 2>&1; then
    say "nginx is not installed here: skipping its files"
    return 0
  fi
  local old
  old="$(mktemp -d)"
  local f
  for f in /etc/nginx/conf.d/00-hardening.conf /etc/nginx/conf.d/default-server.conf \
    /etc/nginx/ruchoir-exempt.conf /etc/nginx/snippets/ruchoir-proxy.conf /etc/nginx/nginx.conf; do
    if [ -f "$prefix$f" ]; then
      mkdir -p "$old$(dirname "$f")"
      cp -a "$prefix$f" "$old$f"
    fi
  done
  changed=0
  put_rendered /etc/nginx/ruchoir-exempt.conf 0644 render_nginx_exempt "$house" "$peer"
  put "$shield/nginx/00-hardening.conf" /etc/nginx/conf.d/00-hardening.conf 0644
  put "$shield/nginx/default-server.conf" /etc/nginx/conf.d/default-server.conf 0644
  put "$shield/nginx/proxy-common.conf" /etc/nginx/snippets/ruchoir-proxy.conf 0644
  if [ -f "$prefix/etc/nginx/nginx.conf" ] && [ "$(nginx_server_tokens_off "$prefix/etc/nginx/nginx.conf")" = changed ]; then
    say "set server_tokens off in /etc/nginx/nginx.conf"
    changed=1
  fi
  if [ "$changed" = 1 ]; then
    if [ "$dry" = 1 ]; then
      say "dry-run: nginx -t && systemctl reload nginx"
    elif nginx -t 2>/dev/null; then
      systemctl reload nginx
      say "nginx reloaded"
    else
      nginx -t || true
      say "nginx -t failed: putting the previous files back" >&2
      for f in /etc/nginx/conf.d/00-hardening.conf /etc/nginx/conf.d/default-server.conf \
        /etc/nginx/ruchoir-exempt.conf /etc/nginx/snippets/ruchoir-proxy.conf /etc/nginx/nginx.conf; do
        if [ -f "$old$f" ]; then cp -a "$old$f" "$f"; else rm -f "$f"; fi
      done
      rm -rf "$old"
      return 1
    fi
  fi
  rm -rf "$old"
}

# ---------------------------------------------------------------- guard files
# What ruchoir-guard saves and undoes for each change that could cut us off.
install_guard_files() {
  local dir="$prefix/etc/ruchoir-hardening/guard.d" tmp
  run install -d -m 0700 "$dir"
  [ "$dry" = 1 ] && install -d -m 0700 "$dir"
  tmp="$(mktemp)"
  printf '%s\n' /etc/fail2ban/jail.d/ruchoir.local /etc/fail2ban/filter.d/ruchoir-auth.conf \
    /etc/fail2ban/filter.d/sshd.local >"$tmp"
  install_file "$tmp" "$dir/fail2ban.files" 0600
  cat >"$tmp" <<'REVERT'
#!/usr/bin/env bash
# Run by ruchoir-guard when the fail2ban configuration was not confirmed: the files are back (or
# gone), so reload fail2ban, which also removes the bans of the rejected configuration.
systemctl restart fail2ban || true
REVERT
  install_file "$tmp" "$dir/fail2ban.revert" 0700
  printf '%s\n' /var/lib/ruchoir-hardening/spamhaus/drop.nft >"$tmp"
  install_file "$tmp" "$dir/spamhaus.files" 0600
  cat >"$tmp" <<'REVERT'
#!/usr/bin/env bash
# Run by ruchoir-guard when the Spamhaus table was not confirmed: empty the ruleset, stop the timer.
nft delete table inet ruchoir_drop 2>/dev/null || true
systemctl disable --now ruchoir-spamhaus-drop.timer || true
REVERT
  install_file "$tmp" "$dir/spamhaus.revert" 0700
  printf '%s\n' /etc/pam.d/sshd >"$tmp"
  install_file "$tmp" "$dir/pam.files" 0600
  rm -f "$tmp"
}

# ---------------------------------------------------------------- fail2ban
# From the Ubuntu archive, already present on both servers; this makes sure of it. The jails ban
# through nftables (action nftables-multiport). Changing the jails goes through the lock-out guard.
install_fail2ban() {
  if [ "$dry" = 1 ] || ! dpkg -s fail2ban >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  else
    say "unchanged package: fail2ban"
  fi
  install_guard_files
  changed=0
  put "$shield/fail2ban/filter.d/ruchoir-auth.conf" /etc/fail2ban/filter.d/ruchoir-auth.conf 0644
  put "$shield/fail2ban/filter.d/sshd.local" /etc/fail2ban/filter.d/sshd.local 0644
  put_rendered /etc/fail2ban/jail.d/ruchoir.local 0644 render_jail "$shield/fail2ban/jail.d/ruchoir.local" "$house" "$peer"
  if [ "$changed" = 1 ] || [ "$dry" = 1 ]; then
    if [ "$dry" = 1 ]; then
      run ruchoir-guard apply fail2ban 10 -- systemctl restart fail2ban
    else
      # fail2ban refuses to start on a broken jail, and the guard then puts the old files back.
      ruchoir-guard apply fail2ban 10 -- bash -c 'fail2ban-client -t >/dev/null && systemctl enable fail2ban && systemctl restart fail2ban'
    fi
    say "NOW open a NEW ssh session; if it works: sudo ruchoir-guard confirm fail2ban"
  else
    run systemctl enable --now fail2ban
  fi
}

# ---------------------------------------------------------------- Spamhaus DROP
# A daily list of hijacked networks into the nftables table inet ruchoir_drop. The first load goes
# through the guard: the script never loads an entry covering the house or the other server, but a
# wrong env file would be the one way to cut ourselves off.
install_spamhaus() {
  if [ "$dry" = 1 ] || ! command -v nft >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables python3
  fi
  changed=0
  put "$shield/spamhaus/ruchoir-spamhaus-drop" /usr/local/sbin/ruchoir-spamhaus-drop 0755
  put "$shield/spamhaus/ruchoir-spamhaus-drop.service" /etc/systemd/system/ruchoir-spamhaus-drop.service 0644
  put "$shield/spamhaus/ruchoir-spamhaus-drop.timer" /etc/systemd/system/ruchoir-spamhaus-drop.timer 0644
  if [ "$changed" = 1 ]; then
    run systemctl daemon-reload
  fi
  install_guard_files
  if [ "$dry" = 1 ] || ! nft list table inet ruchoir_drop >/dev/null 2>&1; then
    run ruchoir-guard apply spamhaus 10 -- /usr/local/sbin/ruchoir-spamhaus-drop
    run systemctl enable --now ruchoir-spamhaus-drop.timer
    say "NOW open a NEW ssh session; if it works: sudo ruchoir-guard confirm spamhaus"
  else
    say "unchanged table inet ruchoir_drop is loaded"
    run systemctl enable --now ruchoir-spamhaus-drop.timer
  fi
}

# ---------------------------------------------------------------- AIDE
install_aide() {
  if [ "$dry" = 1 ] || ! dpkg -s aide >/dev/null 2>&1; then
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq aide
  else
    say "unchanged package: aide"
  fi
  changed=0
  put "$shield/aide/ruchoir.conf" /etc/aide/ruchoir.conf 0644
  put "$shield/aide/ruchoir-aide-check" /usr/local/sbin/ruchoir-aide-check 0755
  put "$shield/aide/ruchoir-aide-accept" /usr/local/sbin/ruchoir-aide-accept 0755
  put "$shield/aide/ruchoir-aide-check.service" /etc/systemd/system/ruchoir-aide-check.service 0644
  put "$shield/aide/ruchoir-aide-check.timer" /etc/systemd/system/ruchoir-aide-check.timer 0644
  put "$shield/aide/53-ruchoir-aide" /etc/apt/apt.conf.d/53-ruchoir-aide 0644
  if [ "$changed" = 1 ]; then
    run systemctl daemon-reload
  fi
  # Ubuntu's own daily check reads its own configuration and database: it would only add noise.
  run systemctl disable --now dailyaidecheck.timer dailyaidecheck.service
  run systemctl enable --now ruchoir-aide-check.timer
}

# Last: the database is built from the state the other pieces left behind.
initialise_aide() {
  if [ -f "$prefix/var/lib/aide/ruchoir.db" ]; then
    say "unchanged AIDE database"
    return 0
  fi
  if [ "$dry" = 1 ]; then
    say "dry-run: aide --config /etc/aide/ruchoir.conf --init, then move the new database in place"
    return 0
  fi
  install -d -m 0700 /var/lib/aide /var/log/aide
  # --init exits non-zero only on error; it takes a few minutes on a small server.
  aide --config /etc/aide/ruchoir.conf --init
  mv -f /var/lib/aide/ruchoir.db.new /var/lib/aide/ruchoir.db
  printf 'ok database initialised (%s)\n' "$(date -u +%FT%TZ)" >/var/lib/ruchoir-hardening/aide.status
  say "installed AIDE database"
}

# ---------------------------------------------------------------- SSH login alert
install_login_alert() {
  put "$shield/pam/ruchoir-login-alert" /usr/local/sbin/ruchoir-login-alert 0755
  local pam="$prefix/etc/pam.d/sshd" line='session optional pam_exec.so quiet /usr/local/sbin/ruchoir-login-alert'
  if [ "$dry" = 1 ] && [ ! -f "$pam" ]; then
    install -d "$(dirname "$pam")"
    printf '@include common-session\n' >"$pam"
  fi
  if [ ! -f "$pam" ]; then
    say "no $pam here: login alert not wired"
    return 0
  fi
  if grep -qF "$line" "$pam"; then
    say "unchanged $pam"
    return 0
  fi
  install_guard_files
  # `optional` and `quiet`: a failing hook never refuses a login; the guard is belt and braces.
  if [ "$dry" = 1 ]; then
    printf '%s\n' "$line" >>"$pam"
    say "installed $pam (dry run)"
  else
    ruchoir-guard apply pam 5 -- bash -c "printf '%s\n' '$line' >>/etc/pam.d/sshd"
    say "NOW open a NEW ssh session; if it works: sudo ruchoir-guard confirm pam"
  fi
}

# ---------------------------------------------------------------- probes
# The checks.d contract: each executable prints one `ok|fail|unknown MESSAGE` line, exit 0.
link_checks() {
  local lib=/usr/local/lib/ruchoir-hardening/shield/checks.d check name target link
  install -d -m 0755 "$prefix$lib" "$prefix/etc/ruchoir-watch/checks.d"
  for check in "$shield"/checks.d/*.sh; do
    name="$(basename "$check")"
    put "$check" "$lib/$name" 0755
    link="$prefix/etc/ruchoir-watch/checks.d/shield-$name"
    target="$lib/$name"
    if [ "$(readlink "$link" 2>/dev/null || true)" = "$target" ]; then
      say "unchanged $link"
    else
      ln -sfn "$target" "$link"
      say "installed $link"
    fi
  done
}

say "shield on a '$role' server"
install_nginx
install_fail2ban
install_spamhaus
install_aide
install_login_alert
link_checks
initialise_aide
