#!/usr/bin/env bash
#
# Decisions of the backup pull, as functions so the tests can source them. Sourced, never run.
# Installed with the puller as /usr/local/lib/ruchoir-hardening/backup-pull-lib.sh.
#
# Archives are named ruchoir-YYYYMMDDTHHMMSSZ.tar.gz.enc, with ruchoir-....tar.gz.enc.sha256 beside
# them (scripts/backup.sh). The names sort chronologically. Every function prints base names, one
# per line, oldest first.

BACKUP_KEEP_NIGHTLY="${BACKUP_KEEP_NIGHTLY:-30}"
BACKUP_KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-12}"

# list_archives DIR: the archive base names in DIR, oldest first.
list_archives() {
  local dir="$1" f
  for f in "$dir"/ruchoir-????????T??????Z.tar.gz.enc; do
    [ -e "$f" ] || continue
    basename "$f"
  done | sort
}

# retention_keep DIR: what to keep. The newest BACKUP_KEEP_NIGHTLY archives, plus the first archive
# of each month for the BACKUP_KEEP_MONTHS months ending with the newest archive's month (so
# twelve calendar months, the current one included). Nothing else.
retention_keep() {
  local dir="$1" name stamp month idx newest_idx floor seen=""
  local -a all=()
  mapfile -t all < <(list_archives "$dir")
  [ "${#all[@]}" -gt 0 ] || return 0

  stamp="${all[-1]#ruchoir-}"
  newest_idx=$((10#${stamp:0:4} * 12 + 10#${stamp:4:2} - 1))
  floor=$((newest_idx - BACKUP_KEEP_MONTHS + 1))

  {
    printf '%s\n' "${all[@]}" | tail -n "$BACKUP_KEEP_NIGHTLY"
    for name in "${all[@]}"; do
      stamp="${name#ruchoir-}"
      month="${stamp:0:6}"
      case " $seen " in *" $month "*) continue ;; esac
      seen="$seen $month"
      idx=$((10#${stamp:0:4} * 12 + 10#${stamp:4:2} - 1))
      if [ "$idx" -ge "$floor" ]; then printf '%s\n' "$name"; fi
    done
  } | sort -u
}

# checksum_state DIR NAME: ok, bad or missing. The .sha256 beside an archive holds the path it had
# on the writing host (backup.sh runs `sha256sum "$archive"`), so only its hash field is used and
# the archive is hashed where it stands.
checksum_state() {
  local dir="$1" name="$2" want have
  if [ ! -f "$dir/$name.sha256" ]; then
    echo missing
    return 0
  fi
  want="$(awk 'NR == 1 { print $1 }' "$dir/$name.sha256")"
  have="$(sha256sum <"$dir/$name" | awk '{ print $1 }')"
  if [ -n "$want" ] && [ "$want" = "$have" ]; then echo ok; else echo bad; fi
}

# archives_in_state STATE DIR: archives whose checksum is in STATE.
archives_in_state() {
  local state="$1" dir="$2" name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ "$(checksum_state "$dir" "$name")" = "$state" ]; then printf '%s\n' "$name"; fi
  done < <(list_archives "$dir")
}

# verified_archives DIR: archives whose .sha256 exists and matches. An archive without one is still
# being written; one with a wrong one is damaged. Neither is listed.
verified_archives() {
  archives_in_state ok "$1"
}

# mismatched_archives DIR: archives that have a .sha256 which does not match. A missing checksum is
# not a mismatch (the writer may not be done), so it is not listed.
mismatched_archives() {
  archives_in_state bad "$1"
}

# archive_epoch NAME: the moment an archive was taken, in epoch seconds, from its name.
archive_epoch() {
  local stamp="${1#ruchoir-}"
  stamp="${stamp%%.*}"
  date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" +%s
}

# newest_age DIR NOW: seconds between the newest archive and NOW (epoch). Prints nothing when DIR
# holds no archive.
newest_age() {
  local dir="$1" now="$2" newest
  newest="$(list_archives "$dir" | tail -n 1)"
  [ -n "$newest" ] || return 0
  echo $((now - $(archive_epoch "$newest")))
}
