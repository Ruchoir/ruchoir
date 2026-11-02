#!/usr/bin/env bash
#
# Tests of infra/hardening/common: lib.sh, ruchoir-notify (dry run) and ruchoir-guard (dry run).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fails=0
check() { # check NAME CONDITION...
  local name="$1"
  shift
  if "$@"; then
    printf '  ok   %s\n' "$name"
  else
    printf '  FAIL %s\n' "$name"
    fails=$((fails + 1))
  fi
}

cat >"$scratch/hardening.env" <<'EOF'
RUCHOIR_HARDENING_ROLE=app
NOTIFY_NTFY_URL=https://ntfy.example.org
NOTIFY_NTFY_TOPIC=app-alerts
NOTIFY_NTFY_TOKEN=tk_secret_never_printed
NOTIFY_MAIL_TO=someone@example.org
NOTIFY_MAIL_FROM="Ruchoir <alerts@example.org>"
NOTIFY_SMTP_HOST=smtp.example.org
NOTIFY_SMTP_PORT=587
NOTIFY_SMTP_USER=user
NOTIFY_SMTP_PASSWORD=smtp_secret_never_printed
EOF
export RUCHOIR_HARDENING_ENV="$scratch/hardening.env"

# shellcheck source=../common/lib.sh
. "$here/common/lib.sh"

# env_get
check "env_get reads a plain value" test "$(env_get RUCHOIR_HARDENING_ROLE)" = app
check "env_get strips quotes" test "$(env_get NOTIFY_MAIL_FROM)" = "Ruchoir <alerts@example.org>"
out="$( (env_get MISSING_KEY) 2>&1 || true)"
check "env_get names a missing key" grep -q MISSING_KEY <<<"$out"
check "env_get fails on a missing key" bash -c '. "$1"; ! env_get MISSING_KEY 2>/dev/null' _ "$here/common/lib.sh"

# install_file
printf 'one\n' >"$scratch/src"
first="$(install_file "$scratch/src" "$scratch/dest" 0640)"
second="$(install_file "$scratch/src" "$scratch/dest" 0640)"
check "install_file installs the first time" test "$first" = "installed $scratch/dest"
check "install_file is unchanged the second time" test "$second" = "unchanged $scratch/dest"
check "install_file sets the mode" test "$(stat -c %a "$scratch/dest")" = 640
printf 'two\n' >"$scratch/src"
third="$(install_file "$scratch/src" "$scratch/dest" 0640)"
check "install_file replaces a changed file" test "$third" = "installed $scratch/dest"
chmod 0644 "$scratch/dest"
fourth="$(install_file "$scratch/src" "$scratch/dest" 0640)"
check "install_file fixes a wrong mode" test "$fourth" = "installed $scratch/dest"

# ruchoir-notify, dry run
notify_out="$(NOTIFY_DRY_RUN=1 bash "$here/common/ruchoir-notify" alert "API down" "health answered 502" 2>&1)"
check "notify dry run shows the ntfy message" grep -q "ntfy POST https://ntfy.example.org/app-alerts" <<<"$notify_out"
check "notify dry run uses priority 5 for an alert" grep -q "Priority: 5" <<<"$notify_out"
check "notify dry run shows the mail subject" grep -qE "Subject: \[[^]]+\] API down" <<<"$notify_out"
check "notify never prints the ntfy token" bash -c '! grep -q tk_secret_never_printed <<<"$1"' _ "$notify_out"
check "notify never prints the SMTP password" bash -c '! grep -q smtp_secret_never_printed <<<"$1"' _ "$notify_out"
recovered="$(NOTIFY_DRY_RUN=1 bash "$here/common/ruchoir-notify" recovered "API down" "back" 2>&1)"
check "notify uses priority 3 for a recovery" grep -q "Priority: 3" <<<"$recovered"
check "notify refuses an unknown level" bash -c '! NOTIFY_DRY_RUN=1 bash "$1" panic t b >/dev/null 2>&1' _ "$here/common/ruchoir-notify"

# ruchoir-guard, dry run: says what it would back up and arm, runs nothing
mkdir -p "$scratch/guard.d"
printf '%s\n' "$scratch/dest" >"$scratch/guard.d/demo.files"
guard_out="$(GUARD_DRY_RUN=1 GUARD_DIR="$scratch/guard.d" bash "$here/common/ruchoir-guard" apply demo 5 -- true 2>&1)"
check "guard backs up the listed files" grep -q "back up $scratch/dest" <<<"$guard_out"
check "guard arms a revert in 5 minutes" grep -q "arm revert of demo in 5 min" <<<"$guard_out"
check "guard refuses a name without a file list" bash -c '! GUARD_DRY_RUN=1 GUARD_DIR="$2" bash "$1" apply nope 5 -- true >/dev/null 2>&1' _ "$here/common/ruchoir-guard" "$scratch/guard.d"

if [ "$fails" -ne 0 ]; then
  echo "common: $fails failed" >&2
  exit 1
fi
