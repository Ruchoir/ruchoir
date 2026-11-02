#!/usr/bin/env bash
#
# Probe for ruchoir-watch: fail2ban runs and has the expected jails loaded.
# Prints exactly one line, `ok|fail|unknown MESSAGE`, and exits 0 (the check contract).
# Linked into /etc/ruchoir-watch/checks.d/ by `infra/hardening/install shield`.
# CHECK_DRY_RUN=1 prints the command it would run; F2B_CLIENT names fail2ban-client (tests).
set -uo pipefail

client="${F2B_CLIENT:-fail2ban-client}"
expected="sshd ruchoir-auth nginx-limit-req nginx-botsearch"

if [ "${CHECK_DRY_RUN:-0}" = 1 ]; then
  echo "ok would run: $client status (jails: $expected)"
  exit 0
fi
if ! command -v "$client" >/dev/null 2>&1 && [ ! -x "$client" ]; then
  echo "fail fail2ban is not installed"
  exit 0
fi
if [ -z "${F2B_CLIENT:-}" ] && ! systemctl is-active --quiet fail2ban 2>/dev/null; then
  echo "fail fail2ban is not running"
  exit 0
fi
status="$("$client" status 2>/dev/null || true)"
list="$(sed -n 's/.*Jail list:[[:space:]]*//p' <<<"$status" | tr -d ',')"
if [ -z "$list" ]; then
  echo "fail fail2ban answers, but no jail is loaded"
  exit 0
fi
missing=""
for jail in $expected; do
  case " $list " in *" $jail "*) ;; *) missing="$missing $jail" ;; esac
done
if [ -n "$missing" ]; then
  echo "fail fail2ban is missing the jail(s):$missing"
else
  echo "ok fail2ban runs with its ${expected// /, } jails"
fi
exit 0
