#!/usr/bin/env bash
#
# Restore a Ruchoir instance from an archive written by scripts/backup.sh.
#
# This REPLACES the instance's three stores with the ones in the archive. It is not a merge and
# there is no undo, so it asks before it starts and says exactly what it is about to overwrite.
#
# Usage:
#   scripts/restore.sh ARCHIVE [--yes]
#
# Environment (or .env):
#   RUCHOIR_BACKUP_KEY_FILE  the passphrase file the archive was sealed with (required)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

archive=""
assume_yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) assume_yes=1 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) archive="$1" ;;
  esac
  shift
done
[ -n "$archive" ] || { echo "usage: scripts/restore.sh ARCHIVE [--yes]" >&2; exit 2; }
[ -r "$archive" ] || { echo "cannot read $archive" >&2; exit 1; }

env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/"
}

key_file="${RUCHOIR_BACKUP_KEY_FILE:-$(env_value RUCHOIR_BACKUP_KEY_FILE)}"
pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-ruchoir}"
pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-ruchoir}"
[ -n "$key_file" ] && [ -r "$key_file" ] || { echo "RUCHOIR_BACKUP_KEY_FILE is not set or not readable" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
compose() { docker compose "$@"; }

echo "Opening $archive"
if [ -r "$archive.sha256" ]; then
  # The archive against what was written: this catches a truncated copy before anything is stopped.
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256" >/dev/null) \
    && echo "  archive checksum matches"
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$key_file" -in "$archive" \
  | tar -C "$work" -xzf -

# And the members against the manifest written beside them: an archive that decrypts is not yet an
# archive that is whole.
(cd "$work" && sha256sum -c SHA256SUMS >/dev/null) && echo "  contents checksum matches"
taken_at="$(sed -n 's/.*"taken_at": "\([^"]*\)".*/\1/p' "$work/manifest.json")"
paused="$(sed -n 's/.*"api_paused": \([a-z]*\).*/\1/p' "$work/manifest.json")"
echo "  taken at $taken_at (api_paused: $paused)"
[ "$paused" = "true" ] || echo "  NOTE: taken without pausing the API, so the three stores may be a few seconds apart"

if [ "$assume_yes" != 1 ]; then
  echo
  echo "This will REPLACE the current database, object store and sessions of the instance in $here."
  printf 'Type the word restore to continue: '
  read -r answer
  [ "$answer" = "restore" ] || { echo "nothing was changed."; exit 1; }
fi

echo "Restoring"
compose stop api >/dev/null 2>&1 || true

echo "  PostgreSQL"
compose up -d postgres >/dev/null
# Wait for it rather than assume: a compose that has just started is not a database that answers.
for _ in $(seq 1 30); do
  compose exec -T postgres pg_isready -U "$pg_user" -d "$pg_db" >/dev/null 2>&1 && break
  sleep 1
done
# --clean --if-exists drops what the archive is about to recreate, so a restore onto a live instance
# lands on the archive's state and not on a merge of two.
compose exec -T postgres pg_restore -U "$pg_user" -d "$pg_db" --clean --if-exists --no-owner \
  < "$work/postgres.dump" >/dev/null

echo "  Garage (objects and metadata)"
compose stop garage >/dev/null 2>&1 || true
for vol in garage-meta garage-data; do
  docker run --rm -v "ruchoir_${vol}:/dst" -v "$work:/in:ro" alpine:3 \
    sh -c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar -C /dst -xf /in/${vol}.tar" >/dev/null
done
compose up -d garage >/dev/null

echo "  Valkey"
compose stop valkey >/dev/null 2>&1 || true
docker run --rm -v "ruchoir_valkey-data:/dst" -v "$work:/in:ro" alpine:3 \
  sh -c "cp /in/valkey.rdb /dst/dump.rdb; rm -f /dst/appendonlydir/* 2>/dev/null || true" >/dev/null
compose up -d valkey >/dev/null

compose start api >/dev/null 2>&1 || compose up -d api >/dev/null
echo
echo "Done. Sessions from the archive are back, so anyone signed in since it was taken is signed out."
echo "Check the API came up: docker compose logs --tail 30 api"
