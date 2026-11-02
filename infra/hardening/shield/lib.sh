#!/usr/bin/env bash
#
# Helpers of the shield lot (CrowdSec, nginx limits, AIDE, login alert). Sourced by install.sh and
# by tests/shield.sh, never run. The decisions live here as functions so the tests can call them.

# is_valid_address ADDR: an IPv4 or IPv6 address, nothing else (no CIDR, no name). The addresses
# end up inside generated configuration files, so they are checked before being written.
is_valid_address() {
  local addr="$1" part
  case "$addr" in
    "" | *[!0-9a-fA-F:.]*) return 1 ;;
  esac
  if [[ "$addr" == *:* ]]; then
    # IPv6: at least two colons.
    [ "$(tr -cd ':' <<<"$addr" | wc -c)" -ge 2 ]
  else
    [[ "$addr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    for part in ${addr//./ }; do
      [ "$((10#$part))" -le 255 ] || return 1
    done
  fi
}

# render_allowlist HOUSE_IP PEER_IP: a CrowdSec parser whitelist (s02-enrich) naming the house, the
# other server and the loopback ranges. An address in it is never turned into an alert, so never
# banned. Works with the old 1.4 engine and with current ones.
render_allowlist() {
  local house="$1" peer="$2"
  is_valid_address "$house" || { echo "invalid house address: $house" >&2; return 1; }
  is_valid_address "$peer" || { echo "invalid peer address: $peer" >&2; return 1; }
  cat <<YAML
# Managed by infra/hardening (shield). Do not edit: rerun the installer.
name: ruchoir/allowlist
description: "The house, the other server and the loopback never get banned"
whitelist:
  reason: "Ruchoir infrastructure and administrators"
  ip:
    - "127.0.0.1"
    - "::1"
    - "$house"
    - "$peer"
  cidr:
    - "127.0.0.0/8"
YAML
}

# render_nginx_exempt HOUSE_IP PEER_IP: the nginx geo block that marks the addresses exempt from
# limit_req and limit_conn (the house, the other server, loopback). 00-hardening.conf maps it to
# an empty key, and nginx does not count a request whose key is empty.
render_nginx_exempt() {
  local house="$1" peer="$2"
  is_valid_address "$house" || { echo "invalid house address: $house" >&2; return 1; }
  is_valid_address "$peer" || { echo "invalid peer address: $peer" >&2; return 1; }
  cat <<CONF
# Managed by infra/hardening (shield). Do not edit: rerun the installer.
geo \$ruchoir_exempt {
    default 0;
    127.0.0.1 1;
    ::1 1;
    $house 1;
    $peer 1;
}
CONF
}

# log_line_meta LINE: reads one nginx access-log line in the default "combined" format and prints
# `verb path status`, the three fields CrowdSec's nginx parser hands to scenarios as
# http_verb, http_path and http_status. Used by the tests to play a scenario's filter.
log_line_meta() {
  local line="$1"
  if [[ "$line" =~ \"([A-Z]+)\ ([^\ ?\"]*)[^\"]*\"\ ([0-9]{3})\  ]]; then
    printf '%s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  else
    return 1
  fi
}

# crowdsec_has_acted: true when the engine has raised an alert on its own or counted sshd lines
# (a community-blocklist decision does not count: it proves nothing about this server's logs).
# The old and the new engine print their tables differently, so this looks for any local alert row
# or any metrics line counting the ssh source.
crowdsec_has_acted() {
  local alerts metrics
  alerts="$(cscli alerts list -o raw 2>/dev/null | tail -n +2 | grep -c . || true)"
  [ "${alerts:-0}" -gt 0 ] && return 0
  metrics="$(cscli metrics 2>/dev/null || true)"
  grep -Eqi 'journalctl:.*ssh|ssh.*[1-9][0-9]*' <<<"$metrics"
}
