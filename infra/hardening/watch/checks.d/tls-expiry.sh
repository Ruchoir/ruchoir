#!/usr/bin/env bash
#
# Check "tls-expiry" of ruchoir-watch: every public name of the other server (HARDENING_PEER_NAMES)
# has a certificate valid for at least 14 more days. A certificate that cannot be read is unknown,
# not ok. WATCH_ENDDATE_CMD names a command printing `notAfter=...` for a host, for tests.
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

names="${HARDENING_PEER_NAMES_OVERRIDE:-}"
if [ -z "$names" ]; then
  names="$(env_get HARDENING_PEER_NAMES)" || check_unknown "HARDENING_PEER_NAMES is not set"
fi

fetch_enddate() {
  if [ -n "${WATCH_ENDDATE_CMD:-}" ]; then
    "$WATCH_ENDDATE_CMD" "$1"
    return
  fi
  timeout 15 openssl s_client -connect "$1:443" -servername "$1" </dev/null 2>/dev/null \
    | openssl x509 -noout -enddate
}

soon=()
unreadable=()
valid=""
for name in $names; do
  enddate="$(fetch_enddate "$name" 2>/dev/null)" || enddate=""
  days="$(days_until_enddate "$enddate" 2>/dev/null)" || days=""
  if [ -z "$days" ]; then
    unreadable+=("$name")
  elif [ "$days" -lt 14 ]; then
    soon+=("$name in $days days")
  else
    valid="${valid:+$valid, }$name $days days"
  fi
done

if [ "${#soon[@]}" -gt 0 ]; then
  check_fail "certificate expires soon: ${soon[*]}"
fi
if [ "${#unreadable[@]}" -gt 0 ]; then
  check_unknown "cannot read the certificate of: ${unreadable[*]}"
fi
check_ok "certificates valid: $valid"
