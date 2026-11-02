#!/usr/bin/env bash
#
# Helpers of the shield lot (fail2ban, Spamhaus DROP, nginx limits, AIDE, login alert). Sourced by
# install.sh and by tests/shield.sh, never run. The decisions live here as functions so the tests
# can call them.

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

# render_ignoreip HOUSE_IP PEER_IP: the value of fail2ban's `ignoreip`: loopback, the house and the
# other server, space-separated. An address in it is never banned.
render_ignoreip() {
  local house="$1" peer="$2"
  is_valid_address "$house" || { echo "invalid house address: $house" >&2; return 1; }
  is_valid_address "$peer" || { echo "invalid peer address: $peer" >&2; return 1; }
  printf '127.0.0.0/8 ::1 %s %s\n' "$house" "$peer"
}

# render_jail TEMPLATE HOUSE_IP PEER_IP: the jail file, with @IGNOREIP@ replaced.
render_jail() {
  local template="$1" ignoreip
  ignoreip="$(render_ignoreip "$2" "$3")" || return 1
  sed "s|@IGNOREIP@|$ignoreip|" "$template"
}

# render_nginx_exempt HOUSE_IP PEER_IP: the nginx geo block that marks the addresses exempt from
# limit_req and limit_conn (the house, the other server, loopback). 00-hardening.conf maps it to
# an empty key, and nginx does not count a request whose key is empty.
# nginx_server_tokens_off FILE: make nginx.conf say `server_tokens off;`. Ubuntu's declares
# `server_tokens build;` inside http {}, and nginx refuses the directive twice, so it cannot live in
# conf.d: an existing active line is rewritten, otherwise one is added right after `http {`.
# Prints "changed" or "unchanged".
nginx_server_tokens_off() {
  local file="$1"
  if grep -qE '^\s*server_tokens\s+off;' "$file" && ! grep -qE '^\s*server_tokens\s+(on|build)\b' "$file"; then
    echo unchanged
    return 0
  fi
  if grep -qE '^\s*server_tokens\s' "$file"; then
    sed -i -E 's/^(\s*)server_tokens\s+[^;]*;.*$/\1server_tokens off;/' "$file"
  else
    sed -i -E '0,/^\s*http\s*\{/s//&\n\tserver_tokens off;/' "$file"
  fi
  echo changed
}

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
