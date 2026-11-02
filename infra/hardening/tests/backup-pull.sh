#!/usr/bin/env bash
#
# Tests of infra/hardening/backup-pull: retention, checksum verification, and the whole pull run
# against a local directory standing in for the app server.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
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

# shellcheck source=../backup-pull/lib.sh
. "$here/backup-pull/lib.sh"

name_of() { date -u -d "$1" +ruchoir-%Y%m%dT%H%M%SZ.tar.gz.enc; }

# --- retention_keep: 70 nightly archives over three months ----------------------------------------
mkdir "$scratch/ret"
for i in $(seq 0 69); do
  : >"$scratch/ret/$(name_of "2026-08-25 03:36:$(printf '%02d' $((i % 60))) UTC + $i days")"
done
kept="$(retention_keep "$scratch/ret")"
check "retention keeps 33 of 70" test "$(wc -l <<<"$kept")" -eq 33
check "retention keeps the newest" grep -q "ruchoir-20261102T" <<<"$kept"
check "retention keeps the 30th newest" grep -q "ruchoir-20261004T" <<<"$kept"
check "retention drops the 31st newest" bash -c '! grep -q "ruchoir-20261003T" <<<"$1"' _ "$kept"
check "retention keeps the first of August" grep -q "ruchoir-20260825T" <<<"$kept"
check "retention drops the second of August" bash -c '! grep -q "ruchoir-20260826T" <<<"$1"' _ "$kept"
check "retention keeps the first of September" grep -q "ruchoir-20260901T" <<<"$kept"
check "retention keeps the first of October" grep -q "ruchoir-20261001T" <<<"$kept"
check "retention drops the second of October" bash -c '! grep -q "ruchoir-20261002T" <<<"$1"' _ "$kept"

# Monthly firsts go back 12 months, no further. Newest is November 2026: its window is
# December 2025 to November 2026.
mkdir "$scratch/old"
for d in 2025-11-01 2025-11-02 2025-12-01 2025-12-02 2026-06-01 2026-06-15 2026-11-02; do
  : >"$scratch/old/$(name_of "$d 03:36:00 UTC")"
done
old_kept="$(BACKUP_KEEP_NIGHTLY=1 retention_keep "$scratch/old")"
check "retention drops a month older than 12 months" bash -c '! grep -q "ruchoir-20251101T" <<<"$1"' _ "$old_kept"
check "retention keeps the first of the oldest month in range" grep -q "ruchoir-20251201T" <<<"$old_kept"
check "retention keeps a recent monthly first" grep -q "ruchoir-20260601T" <<<"$old_kept"
check "retention drops a non-first of an old month" bash -c '! grep -q "ruchoir-20260615T" <<<"$1"' _ "$old_kept"

mkdir "$scratch/none"
check "retention of an empty directory is empty" test -z "$(retention_keep "$scratch/none")"

# --- verified_archives: the .sha256 may carry the writer's path, only the hash counts -------------
mkdir "$scratch/ver"
good="$(name_of '2026-11-01 03:36:00 UTC')"
bad="$(name_of '2026-11-02 03:36:00 UTC')"
nosum="$(name_of '2026-11-03 03:36:00 UTC')"
printf 'good archive\n' >"$scratch/ver/$good"
printf 'bad archive\n' >"$scratch/ver/$bad"
printf 'half written\n' >"$scratch/ver/$nosum"
# backup.sh writes `sha256sum "$archive"`, so the line holds the full path on the writing host.
printf '%s  /srv/elsewhere/backups/%s\n' "$(sha256sum <"$scratch/ver/$good" | cut -d' ' -f1)" "$good" >"$scratch/ver/$good.sha256"
printf '%s  /srv/elsewhere/backups/%s\n' "$(printf 'something else' | sha256sum | cut -d' ' -f1)" "$bad" >"$scratch/ver/$bad.sha256"
verified="$(verified_archives "$scratch/ver")"
check "verified lists the archive whose checksum matches" grep -qx "$good" <<<"$verified"
check "verified skips an archive with a wrong checksum" bash -c '! grep -qx "$2" <<<"$1"' _ "$verified" "$bad"
check "verified skips an archive without a checksum" bash -c '! grep -qx "$2" <<<"$1"' _ "$verified" "$nosum"
mismatched="$(mismatched_archives "$scratch/ver")"
check "mismatched lists the wrong checksum" grep -qx "$bad" <<<"$mismatched"
check "mismatched does not list a missing checksum" bash -c '! grep -qx "$2" <<<"$1"' _ "$mismatched" "$nosum"
check "mismatched does not list a good archive" bash -c '! grep -qx "$2" <<<"$1"' _ "$mismatched" "$good"

# --- archive_epoch / newest_age -------------------------------------------------------------------
check "archive_epoch reads the stamp" test "$(archive_epoch ruchoir-20261102T033600Z.tar.gz.enc)" = "$(date -u -d '2026-11-02 03:36:00' +%s)"
newest_ret="$(list_archives "$scratch/ret" | tail -n 1)"
check "newest_age is the age of the newest archive" test "$(newest_age "$scratch/ret" "$(($(archive_epoch "$newest_ret") + 7200))")" -eq 7200

# --- the whole pull, against a local directory standing in for the app server ---------------------
export RUCHOIR_HARDENING_ENV="$scratch/hardening.env"
cat >"$RUCHOIR_HARDENING_ENV" <<'ENV'
RUCHOIR_HARDENING_ROLE=site
HARDENING_PEER_HOST=peer.example.org
HARDENING_PEER_IP=203.0.113.20
NOTIFY_NTFY_URL=https://ntfy.example.org
NOTIFY_NTFY_TOPIC=app-alerts
NOTIFY_NTFY_TOKEN=tk_unused
NOTIFY_MAIL_TO=someone@example.org
NOTIFY_MAIL_FROM=alerts@example.org
NOTIFY_SMTP_HOST=smtp.example.org
NOTIFY_SMTP_PORT=587
NOTIFY_SMTP_USER=u
NOTIFY_SMTP_PASSWORD=p
ENV
src="$scratch/src"
dest="$scratch/dest"
state="$scratch/state"
mkdir -p "$src" "$dest" "$state"
mk_archive() { # mk_archive DIR WHEN CONTENT
  local n
  n="$(name_of "$2")"
  printf '%s\n' "$3" >"$1/$n"
  printf '%s  /srv/ruchoir/backups/%s\n' "$(printf '%s\n' "$3" | sha256sum | cut -d' ' -f1)" "$n" >"$1/$n.sha256"
}
now="$(date -u -d '2026-11-02 04:30:00' +%s)"
mk_archive "$src" '2026-11-01 03:36:00 UTC' one
mk_archive "$src" '2026-11-02 03:36:00 UTC' two
# A half-written archive: no checksum yet.
printf 'partial\n' >"$src/$(name_of '2026-11-02 04:29:00 UTC')"
# A file that is not ours.
printf 'x\n' >"$src/notes.txt"

pull() {
  BACKUP_PULL_SOURCE="$src/" BACKUP_PULL_DEST="$dest" BACKUP_PULL_STATE="$state" \
    BACKUP_PULL_NOW="$now" BACKUP_PULL_OWNER="$(id -un)" NOTIFY_DRY_RUN=1 \
    BACKUP_PULL_NOTIFY="$here/common/ruchoir-notify" \
    bash "$here/backup-pull/ruchoir-backup-pull" 2>&1
}
out="$(pull)" && rc=0 || rc=$?
check "pull succeeds" test "$rc" -eq 0
check "pull stored the verified archives" test "$(ls "$dest"/ruchoir-*.tar.gz.enc | wc -l)" -eq 2
check "pull stored their checksums" test "$(ls "$dest"/ruchoir-*.sha256 | wc -l)" -eq 2
check "pull ignored the half-written archive" bash -c '! ls "$1" | grep -q 20261102T042900Z' _ "$dest"
check "pull ignored a file that is not an archive" test ! -e "$dest/notes.txt"
check "SHA256SUMS.latest is the newest checksum, by base name" \
  test "$(cat "$dest/SHA256SUMS.latest")" = "$(printf '%s  %s' "$(printf 'two\n' | sha256sum | cut -d' ' -f1)" "$(name_of '2026-11-02 03:36:00 UTC')")"
check "SHA256SUMS.latest verifies" bash -c 'cd "$1" && sha256sum -c --status SHA256SUMS.latest' _ "$dest"
check "last-ok holds the epoch" test "$(cat "$state/backup-pull.last-ok")" = "$now"
check "no alert on success" bash -c '! grep -q "ntfy POST" <<<"$1"' _ "$out"
check "no staging left behind" bash -c '! ls -A "$1" | grep -qi staging' _ "$dest"

# Delete a pulled archive: the next pull brings it back.
find "$dest" -name "$(name_of '2026-11-01 03:36:00 UTC')*" -delete
pull >/dev/null
check "pull restores a deleted copy" test -f "$dest/$(name_of '2026-11-01 03:36:00 UTC')"

# A new night.
mk_archive "$src" '2026-11-03 03:36:00 UTC' three
now3="$(date -u -d '2026-11-03 04:30:00' +%s)"
now="$now3"
pull >/dev/null
check "pull brings the new archive" test -f "$dest/$(name_of '2026-11-03 03:36:00 UTC')"
check "SHA256SUMS.latest moves to the newest" grep -q "$(name_of '2026-11-03 03:36:00 UTC')" "$dest/SHA256SUMS.latest"

# A corrupt archive on the source: alert, not stored, the good ones remain, last-ok untouched.
mk_archive "$src" '2026-11-04 03:36:00 UTC' four
printf 'corrupted\n' >"$src/$(name_of '2026-11-04 03:36:00 UTC')"
now4="$(date -u -d '2026-11-04 04:30:00' +%s)"
now="$now4"
out="$(pull)" && rc=0 || rc=$?
check "pull fails on a checksum mismatch" test "$rc" -ne 0
check "pull alerts on a checksum mismatch" grep -q "ntfy POST" <<<"$out"
check "the alert names the archive" grep -q "20261104T033600Z" <<<"$out"
check "the corrupt archive is not stored" test ! -e "$dest/$(name_of '2026-11-04 03:36:00 UTC')"
check "last-ok is not moved by a failed run" test "$(cat "$state/backup-pull.last-ok")" = "$now3"
check "the good archives are still there" test -f "$dest/$(name_of '2026-11-03 03:36:00 UTC')"
# It is retried: once the source is fixed, the next run stores it.
mk_archive "$src" '2026-11-04 03:36:00 UTC' four
pull >/dev/null
check "a fixed archive is stored on the retry" test -f "$dest/$(name_of '2026-11-04 03:36:00 UTC')"

# A stale source: nothing new for more than 26 hours alerts.
now="$(date -u -d '2026-11-06 04:30:00' +%s)"
out="$(pull)" && rc=0 || rc=$?
check "pull fails when no archive is newer than 26 hours" test "$rc" -ne 0
check "pull alerts on a stale backup" grep -q "ntfy POST" <<<"$out"

# A corrupt stored copy is noticed too.
printf 'rot\n' >"$dest/$(name_of '2026-11-03 03:36:00 UTC')"
now="$now4"
out="$(pull)" && rc=0 || rc=$?
check "pull alerts on a corrupt stored copy" grep -q "20261103T033600Z" <<<"$out"
check "a corrupt stored copy is set aside, not deleted" test -f "$dest/quarantine/$(name_of '2026-11-03 03:36:00 UTC')"
check "a corrupt stored copy keeps its checksum beside it" test -f "$dest/quarantine/$(name_of '2026-11-03 03:36:00 UTC').sha256"

# An unreachable source: alert, nonzero.
out="$(BACKUP_PULL_SOURCE="$scratch/missing/" BACKUP_PULL_DEST="$dest" BACKUP_PULL_STATE="$state" BACKUP_PULL_NOW="$now4" \
  BACKUP_PULL_OWNER="$(id -un)" NOTIFY_DRY_RUN=1 BACKUP_PULL_NOTIFY="$here/common/ruchoir-notify" \
  bash "$here/backup-pull/ruchoir-backup-pull" 2>&1)" && rc=0 || rc=$?
check "pull fails when the source cannot be read" test "$rc" -ne 0
check "pull alerts when the source cannot be read" grep -q "ntfy POST" <<<"$out"

# --- scripts/backup.sh: sharing the archive with a group -----------------------------------------
# The function is lifted out of the script between its markers, so the test runs the real text.
fn="$(sed -n '/^# begin share_with_group/,/^# end share_with_group/p' "$repo/scripts/backup.sh")"
check "backup.sh carries share_with_group" test -n "$fn"
mkdir "$scratch/bk"
printf 'a\n' >"$scratch/bk/a.enc"
printf 'b\n' >"$scratch/bk/a.enc.sha256"
chmod 0644 "$scratch/bk/a.enc" "$scratch/bk/a.enc.sha256"
chmod 0755 "$scratch/bk"
(eval "$fn"; share_with_group "" "$scratch/bk" "$scratch/bk/a.enc" "$scratch/bk/a.enc.sha256")
check "without a group, the modes are left alone" test "$(stat -c %a "$scratch/bk/a.enc")" = 644
(eval "$fn"; share_with_group "$(id -gn)" "$scratch/bk" "$scratch/bk/a.enc" "$scratch/bk/a.enc.sha256")
check "with a group, the archive is 0640" test "$(stat -c %a "$scratch/bk/a.enc")" = 640
check "with a group, the checksum is 0640" test "$(stat -c %a "$scratch/bk/a.enc.sha256")" = 640
check "with a group, the directory is 0750" test "$(stat -c %a "$scratch/bk")" = 750
check "with a group, the group is set" test "$(stat -c %G "$scratch/bk/a.enc")" = "$(id -gn)"

if [ "$fails" -ne 0 ]; then
  echo "backup-pull: $fails failed" >&2
  exit 1
fi
