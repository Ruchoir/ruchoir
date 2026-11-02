#!/usr/bin/env bash
#
# Helpers shared by every hardening script. Sourced, never run.
#
# The host-specific values (addresses, names, the alert recipient, credentials) live only in
# /etc/ruchoir-hardening/hardening.env on each server, root 0600, never in the repository. See
# infra/hardening/hardening.env.example for the keys. RUCHOIR_HARDENING_ENV points elsewhere (tests).

RUCHOIR_HARDENING_ENV="${RUCHOIR_HARDENING_ENV:-/etc/ruchoir-hardening/hardening.env}"

say() {
  printf '%s\n' "$*"
}

# env_get KEY: the value of KEY in the env file, quotes removed. Fails, naming the key, when the key
# is missing or empty, so a half-filled file stops an install instead of writing a broken unit.
env_get() {
  local key="$1" line value
  if [ ! -r "$RUCHOIR_HARDENING_ENV" ]; then
    echo "cannot read $RUCHOIR_HARDENING_ENV (needed for $key)" >&2
    return 1
  fi
  line="$(grep -E "^${key}=" "$RUCHOIR_HARDENING_ENV" | tail -n 1 || true)"
  value="${line#*=}"
  if [ "${#value}" -ge 2 ]; then
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  if [ -z "$line" ] || [ -z "$value" ]; then
    echo "$key is not set in $RUCHOIR_HARDENING_ENV" >&2
    return 1
  fi
  printf '%s' "$value"
}

# install_file SRC DEST MODE: copy SRC to DEST only when the content or the mode differs. Prints
# "installed DEST" or "unchanged DEST", so a second run of an install shows it changed nothing.
install_file() {
  local src="$1" dest="$2" mode="$3"
  if [ -f "$dest" ] && cmp -s "$src" "$dest" \
    && [ "$(stat -c %a "$dest")" = "$(printf '%o' "$((8#$mode))")" ]; then
    say "unchanged $dest"
    return 0
  fi
  install -D -m "$mode" "$src" "$dest"
  say "installed $dest"
}
