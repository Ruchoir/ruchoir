#!/usr/bin/env bash
#
# Install the shield lot on this server: nginx limits and headers, CrowdSec (engine and firewall
# bouncer), file integrity (AIDE), an alert on SSH logins from unknown addresses.
#
# Run as root, on the server, through the entry point (see infra/hardening/README.md):
#
#   sudo /tmp/ruchoir-hardening/install shield
#
# Reads /etc/ruchoir-hardening/hardening.env: HARDENING_HOUSE_IP, HARDENING_PEER_IP, and
# HARDENING_CROWDSEC_SOURCE (ubuntu|vendor), which the owner sets after reading the package table
# in the README. Without it everything else is installed and CrowdSec is refused (exit 3 at the end).
#
# Idempotent: a second run prints only "unchanged" lines. Changes that can lock us out go through
# ruchoir-guard; confirm each from a NEW SSH session (`sudo ruchoir-guard confirm NAME`).
#
# HARDENING_DRY_RUN=1 writes under HARDENING_PREFIX (default: a temp dir) and only prints the
# commands that would touch the system (apt, systemctl, nginx, cscli, aide, ruchoir-guard).
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
source_choice="$(env_get HARDENING_CROWDSEC_SOURCE 2>/dev/null || true)"
role="${RUCHOIR_HARDENING_ROLE:-$(env_get RUCHOIR_HARDENING_ROLE)}"
crowdsec_refused=0

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
    /etc/nginx/ruchoir-exempt.conf /etc/nginx/snippets/ruchoir-proxy.conf; do
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
        /etc/nginx/ruchoir-exempt.conf /etc/nginx/snippets/ruchoir-proxy.conf; do
        if [ -f "$old$f" ]; then cp -a "$old$f" "$f"; else rm -f "$f"; fi
      done
      rm -rf "$old"
      return 1
    fi
  fi
  rm -rf "$old"
}

# ---------------------------------------------------------------- CrowdSec
# The two sources, and why a choice is needed, are in the README ("Where each package comes from").
crowdsec_packages() {
  case "$source_choice" in
    ubuntu) echo "crowdsec crowdsec-firewall-bouncer" ;;
    vendor) echo "crowdsec crowdsec-firewall-bouncer-nftables" ;;
  esac
}

add_vendor_repository() {
  [ "$source_choice" = vendor ] || return 0
  if [ -f "$prefix/etc/apt/sources.list.d/crowdsec_crowdsec.list" ]; then
    say "unchanged $prefix/etc/apt/sources.list.d/crowdsec_crowdsec.list"
    return 0
  fi
  run install -d -m 0755 "$prefix/etc/apt/keyrings" "$prefix/etc/apt/sources.list.d"
  run bash -c "curl -fsSL https://packagecloud.io/crowdsec/crowdsec/gpgkey | gpg --dearmor -o '$prefix/etc/apt/keyrings/crowdsec.gpg'"
  if [ "$dry" != 1 ]; then
    printf 'deb [signed-by=/etc/apt/keyrings/crowdsec.gpg] https://packagecloud.io/crowdsec/crowdsec/ubuntu/ %s main\n' \
      "$(. /etc/os-release && echo "$VERSION_CODENAME")" >"$prefix/etc/apt/sources.list.d/crowdsec_crowdsec.list"
  fi
  run apt-get update -qq
  say "installed CrowdSec's package repository (vendor source)"
}

install_crowdsec() {
  case "$source_choice" in
    ubuntu | vendor) ;;
    "")
      crowdsec_refused=1
      cat >&2 <<'MSG'
REFUSED: CrowdSec is not installed. HARDENING_CROWDSEC_SOURCE is not set in the env file.
Every possible source runs on infrastructure of US companies (see the package table in
infra/hardening/README.md, golden rule 2). Decide, then set HARDENING_CROWDSEC_SOURCE=ubuntu
(the distribution's old packages) or vendor (CrowdSec's own repository) and run this again.
Everything else in the shield lot has been installed.
MSG
      return 0
      ;;
    *)
      echo "HARDENING_CROWDSEC_SOURCE must be ubuntu or vendor, not '$source_choice'" >&2
      return 1
      ;;
  esac

  local packages
  packages="$(crowdsec_packages)"
  add_vendor_repository
  # shellcheck disable=SC2086
  if [ "$dry" = 1 ] || ! dpkg -s $packages >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $packages
  else
    say "unchanged packages: $packages"
  fi

  changed=0
  put "$shield/crowdsec/acquis.d/ruchoir-nginx.yaml" /etc/crowdsec/acquis.d/ruchoir-nginx.yaml 0644
  put "$shield/crowdsec/acquis.d/ruchoir-sshd.yaml" /etc/crowdsec/acquis.d/ruchoir-sshd.yaml 0644
  put "$shield/crowdsec/scenarios/ruchoir-auth-bf.yaml" /etc/crowdsec/scenarios/ruchoir-auth-bf.yaml 0644
  put "$shield/crowdsec/config.yaml.local" /etc/crowdsec/config.yaml.local 0644
  put_rendered /etc/crowdsec/parsers/s02-enrich/ruchoir-allowlist.yaml 0644 render_allowlist "$house" "$peer"

  # Collections: Linux, sshd, nginx, base HTTP scenarios, known web CVEs.
  local collection
  for collection in crowdsecurity/linux crowdsecurity/sshd crowdsecurity/nginx \
    crowdsecurity/base-http-scenarios crowdsecurity/http-cve; do
    if [ "$dry" = 1 ]; then
      say "dry-run: cscli collections install $collection"
    elif cscli collections list -o raw 2>/dev/null | grep -q "^$collection,"; then
      say "unchanged collection $collection"
    else
      cscli collections install "$collection"
      changed=1
    fi
  done
  if [ "$changed" = 1 ]; then
    run systemctl restart crowdsec
  fi
  run systemctl enable --now crowdsec

  # The firewall bouncer can cut our own SSH: armed for 10 minutes, a revert puts it back unless
  # someone confirms from a fresh session.
  install_guard_files
  if [ "$dry" = 1 ] || ! systemctl is-active --quiet crowdsec-firewall-bouncer; then
    run ruchoir-guard apply crowdsec 10 -- systemctl enable --now crowdsec-firewall-bouncer
    say "NOW open a NEW ssh session; if it works: sudo ruchoir-guard confirm crowdsec"
  else
    say "unchanged crowdsec-firewall-bouncer is active"
  fi

  remove_fail2ban_when_proven
}

install_guard_files() {
  local dir="$prefix/etc/ruchoir-hardening/guard.d" tmp
  run install -d -m 0700 "$dir"
  [ "$dry" = 1 ] && install -d -m 0700 "$dir"
  tmp="$(mktemp)"
  printf '%s\n' /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml >"$tmp"
  install_file "$tmp" "$dir/crowdsec.files" 0600
  cat >"$tmp" <<'REVERT'
#!/usr/bin/env bash
# Run by ruchoir-guard when the CrowdSec bouncer was not confirmed: stop it and empty its ruleset.
systemctl disable --now crowdsec-firewall-bouncer || true
nft delete table ip crowdsec 2>/dev/null || true
nft delete table ip6 crowdsec6 2>/dev/null || true
REVERT
  install_file "$tmp" "$dir/crowdsec.revert" 0700
  printf '%s\n' /etc/pam.d/sshd >"$tmp"
  install_file "$tmp" "$dir/pam.files" 0600
  rm -f "$tmp"
}

# fail2ban goes only once the engine is seen at work on this server (a local alert, or sshd lines
# counted); until then both run and this says so.
remove_fail2ban_when_proven() {
  if [ "$dry" = 1 ]; then
    say "dry-run: remove fail2ban once crowdsec_has_acted"
    return 0
  fi
  if ! dpkg -s fail2ban >/dev/null 2>&1; then
    say "unchanged fail2ban is not installed"
    return 0
  fi
  if crowdsec_has_acted; then
    systemctl disable --now fail2ban || true
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq fail2ban
    say "removed fail2ban (CrowdSec has parsed sshd lines or raised alerts)"
  else
    say "fail2ban kept: CrowdSec has not been seen at work yet; run this again later"
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
    # The CrowdSec probe only makes sense once CrowdSec is there.
    if [ "$name" = crowdsec.sh ] && [ "$crowdsec_refused" = 1 ]; then
      continue
    fi
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
install_crowdsec
install_aide
install_login_alert
link_checks
initialise_aide

if [ "$crowdsec_refused" = 1 ]; then
  exit 3
fi
