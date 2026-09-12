#!/usr/bin/env bash
#
# Back up a Ruchoir instance: PostgreSQL, Garage and Valkey, in one encrypted archive.
#
# The three stores are dumped while the API is stopped, which is what makes the archive a single
# restore point rather than three snapshots of three different moments. The stop lasts as long as
# the dump does (seconds on a small instance) and the datastores themselves keep running, so this is
# the cheapest honest consistency there is: nothing can be written between the first dump and the
# last. Pass --no-pause to skip it if a few seconds of downtime is worse for you than a file that
# was uploaded between two dumps; the archive then says so, and `restore.sh` repeats it.
#
# Usage:
#   scripts/backup.sh [--no-pause] [--out DIR]
#
# Environment (or .env next to this repository's docker-compose.yml):
#   RUCHOIR_BACKUP_DIR       where archives are written (default ./backups)
#   RUCHOIR_BACKUP_KEY_FILE  passphrase file for the archive encryption (required)
#   RUCHOIR_BACKUP_KEEP      how many archives to keep (default 14, 0 keeps everything)
#
# The key file must NOT live on the instance being backed up: an archive encrypted with a key that
# burns in the same fire is a compressed copy of the problem.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

pause=1
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pause) pause=0 ;;
    --out) out="${2:?--out needs a directory}"; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# `.env` is read key by key rather than sourced: it is not a shell script, and an unquoted address
# with angle brackets in it (RUCHOIR_SMTP_FROM) is a redirection to a shell. Same reason
# bootstrap-garage.sh stopped sourcing it.
env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/"
}

backup_dir="${out:-${RUCHOIR_BACKUP_DIR:-$(env_value RUCHOIR_BACKUP_DIR)}}"
backup_dir="${backup_dir:-./backups}"
key_file="${RUCHOIR_BACKUP_KEY_FILE:-$(env_value RUCHOIR_BACKUP_KEY_FILE)}"
keep="${RUCHOIR_BACKUP_KEEP:-$(env_value RUCHOIR_BACKUP_KEEP)}"
keep="${keep:-14}"
pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-ruchoir}"
pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-ruchoir}"

if [ -z "$key_file" ]; then
  echo "RUCHOIR_BACKUP_KEY_FILE is not set: refusing to write an unencrypted copy of everything." >&2
  echo "Generate one with: openssl rand -base64 48 > /somewhere/else/ruchoir-backup.key" >&2
  exit 1
fi
if [ ! -r "$key_file" ]; then
  echo "cannot read the backup key file: $key_file" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$backup_dir"

compose() { docker compose "$@"; }

say() { printf '  %s\n' "$1"; }

echo "Ruchoir backup $stamp"

if [ "$pause" = 1 ]; then
  say "pausing the API so the three dumps describe the same moment"
  compose stop api >/dev/null 2>&1 || true
fi
# Restarting matters more than any later step succeeding, so it is armed before the first dump.
restart_api() {
  if [ "$pause" = 1 ]; then
    compose start api >/dev/null 2>&1 || true
  fi
}
trap 'restart_api; rm -rf "$work"' EXIT

say "PostgreSQL"
compose exec -T postgres pg_dump -U "$pg_user" -d "$pg_db" -Fc > "$work/postgres.dump"

say "Valkey"
# SAVE is synchronous on purpose: BGSAVE would return before the file on disk is the one we copy.
compose exec -T valkey valkey-cli SAVE >/dev/null
compose exec -T valkey cat /data/dump.rdb > "$work/valkey.rdb"

say "Garage (objects and metadata)"
# Read straight from the volumes with a throwaway container: Garage has no dump command, and its
# metadata and data directories are what a restore needs to put back.
for vol in garage-meta garage-data; do
  docker run --rm -v "ruchoir_${vol}:/src:ro" -v "$work:/out" alpine:3 \
    tar -C /src -cf "/out/${vol}.tar" . >/dev/null
done

say "manifest and checksums"
{
  printf '{\n'
  printf '  "instance": "%s",\n' "$(env_value RUCHOIR_PUBLIC_BASE_URL)"
  printf '  "taken_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "api_paused": %s,\n' "$([ "$pause" = 1 ] && echo true || echo false)"
  printf '  "postgres_image": "%s",\n' "$(compose config --images 2>/dev/null | grep -m1 postgres || echo unknown)"
  printf '  "garage_image": "%s",\n' "$(compose config --images 2>/dev/null | grep -m1 garage || echo unknown)"
  printf '  "format": 1\n'
  printf '}\n'
} > "$work/manifest.json"
(cd "$work" && sha256sum ./* > SHA256SUMS)

say "sealing"
archive="$backup_dir/ruchoir-$stamp.tar.gz.enc"
tar -C "$work" -czf - . \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$key_file" \
  > "$archive"
sha256sum "$archive" > "$archive.sha256"

restart_api
trap 'rm -rf "$work"' EXIT

size="$(du -h "$archive" | cut -f1)"
echo "wrote $archive ($size)"

if [ "$keep" -gt 0 ]; then
  # Oldest first, keep the newest `keep`. Names sort chronologically because the stamp is ISO basic.
  mapfile -t old < <(ls -1 "$backup_dir"/ruchoir-*.tar.gz.enc 2>/dev/null | head -n "-$keep")
  for f in "${old[@]:-}"; do
    [ -n "$f" ] || continue
    rm -f "$f" "$f.sha256"
    say "removed $(basename "$f") (kept the newest $keep)"
  done
fi
