#!/usr/bin/env bash
#
# Probe for ruchoir-watch: is CrowdSec's engine running, and its firewall bouncer enforcing?
# Prints exactly one line, `ok|fail|unknown MESSAGE`, and exits 0 (the check contract).
# Linked into /etc/ruchoir-watch/checks.d/ by `infra/hardening/install shield`.
# CHECK_DRY_RUN=1 prints the command it would run.
set -uo pipefail

if [ "${CHECK_DRY_RUN:-0}" = 1 ]; then
  echo "ok would run: systemctl is-active crowdsec crowdsec-firewall-bouncer"
  exit 0
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "unknown systemctl is not available"
  exit 0
fi
if ! systemctl cat crowdsec >/dev/null 2>&1; then
  echo "unknown crowdsec is not installed"
  exit 0
fi

engine="$(systemctl is-active crowdsec 2>/dev/null || true)"
bouncer="$(systemctl is-active crowdsec-firewall-bouncer 2>/dev/null || true)"
if [ "$engine" = active ] && [ "$bouncer" = active ]; then
  echo "ok engine and firewall bouncer active"
else
  echo "fail engine ${engine:-unknown}, bouncer ${bouncer:-unknown}"
fi
exit 0
