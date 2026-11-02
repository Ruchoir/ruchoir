#!/usr/bin/env bash
#
# Check "secrets-mode" of ruchoir-watch (role app): the instance's .env and the backup key file it
# names are mode 600 and owned by root (WATCH_INSTANCE and WATCH_SECRETS_OWNER override the
# checkout and the owner, for tests).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

instance="${WATCH_INSTANCE:-/opt/ruchoir}"
owner="${WATCH_SECRETS_OWNER:-root}"
env_file="$instance/.env"
[ -e "$env_file" ] || check_fail "$env_file is missing"

files=("$env_file")
key_line="$(grep -E '^RUCHOIR_BACKUP_KEY_FILE=' "$env_file" 2>/dev/null | tail -n 1 || true)"
key="${key_line#*=}"
key="${key#\"}"
key="${key%\"}"
key="${key#\'}"
key="${key%\'}"
if [ -n "$key" ]; then
  [ -e "$key" ] || check_fail "the backup key file named in .env is missing"
  files+=("$key")
fi

bad=()
for file in "${files[@]}"; do
  stat_out="$(stat -c '%a %U' "$file")" || check_unknown "cannot stat $file"
  mode="${stat_out% *}"
  who="${stat_out#* }"
  if [ "$mode" != 600 ] || [ "$who" != "$owner" ]; then
    bad+=("$(basename "$file") is $mode $who")
  fi
done
if [ "${#bad[@]}" -gt 0 ]; then
  check_fail "${bad[*]}: expected 600 $owner"
fi
check_ok "the secrets are 600 $owner"
