#!/usr/bin/env bash
#
# Decisions of the monthly restore test, kept in functions so the tests can source and exercise
# them. Sourced by ruchoir-restore-test and by tests/restore-test.sh, never run.

# The one Compose project the test may ever act on. Production is `ruchoir`.
RESTORE_TEST_PROJECT="ruchoir-restoretest"

# value_of FILE KEY: the last KEY=value of an env file, quotes removed; empty when absent. The file
# is read, never sourced (it is not a shell script), as scripts/backup.sh does.
value_of() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# counts_close RESTORED LIVE: succeeds when the two counts agree closely enough for an archive that
# may be a day old: within 10 rows or 1 % of the larger one, whichever is larger. A zero against a
# non-zero is never close, however small the other count: an empty table where the instance has rows
# is exactly what a bad restore looks like.
counts_close() {
  local a="$1" b="$2" larger diff tolerance
  case "$a$b" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$a" -eq "$b" ]; then return 0; fi
  if [ "$a" -eq 0 ] || [ "$b" -eq 0 ]; then return 1; fi
  if [ "$a" -gt "$b" ]; then larger="$a" diff=$((a - b)); else larger="$b" diff=$((b - a)); fi
  tolerance=$((larger / 100))
  if [ "$tolerance" -lt 10 ]; then tolerance=10; fi
  [ "$diff" -le "$tolerance" ]
}

# assert_isolated CONFIG_JSON WORKDIR: reads the output of `docker compose config --format json`
# and fails, naming the reason on stderr, unless the project cannot touch anything of production's:
# the fixed project name, no published port, no outbound network (every network internal, none
# external), no external volume, no container name or host networking, no bind mount outside
# WORKDIR, and a memory cap on every service. Called on the resolved configuration before any
# container is started.
assert_isolated() {
  local config="$1" workdir="$2"
  python3 -I - "$config" "$workdir" "$RESTORE_TEST_PROJECT" <<'PY'
import json
import sys

config_path, workdir, project = sys.argv[1:4]
with open(config_path) as f:
    cfg = json.load(f)

problems = []
if cfg.get("name") != project:
    problems.append("the project is named %r, not %r" % (cfg.get("name"), project))

for name, svc in sorted((cfg.get("services") or {}).items()):
    if svc.get("ports"):
        problems.append("service %s publishes a port" % name)
    if svc.get("container_name"):
        problems.append("service %s sets a container name" % name)
    if svc.get("network_mode"):
        problems.append("service %s sets network_mode %s" % (name, svc["network_mode"]))
    if svc.get("privileged"):
        problems.append("service %s is privileged" % name)
    limit = svc.get("mem_limit") or (
        ((svc.get("deploy") or {}).get("resources") or {}).get("limits") or {}
    ).get("memory")
    if not limit:
        problems.append("service %s has no memory limit" % name)
    for vol in svc.get("volumes") or []:
        if vol.get("type") == "bind":
            source = vol.get("source", "")
            if not (source == workdir or source.startswith(workdir.rstrip("/") + "/")):
                problems.append("service %s mounts %s, outside %s" % (name, source, workdir))

for name, net in sorted((cfg.get("networks") or {}).items()):
    net = net or {}
    if net.get("external"):
        problems.append("network %s is external" % name)
    if not net.get("internal"):
        problems.append("network %s is not internal (it has a route out)" % name)

for name, vol in sorted((cfg.get("volumes") or {}).items()):
    if (vol or {}).get("external"):
        problems.append("volume %s is external" % name)

if problems:
    for p in problems:
        print("not isolated: " + p, file=sys.stderr)
    sys.exit(1)
PY
}

# newest_archive DIR: the newest sealed archive that has its checksum file beside it (backup.sh
# writes the checksum last, so an archive without one may still be being written). Prints the path;
# fails when there is none. Names sort chronologically (ISO basic stamp).
newest_archive() {
  local dir="$1" files i
  files=("$dir"/ruchoir-*.tar.gz.enc) # a glob sorts, and the stamp makes that chronological
  for ((i = ${#files[@]} - 1; i >= 0; i--)); do
    if [ -r "${files[i]}" ] && [ -r "${files[i]}.sha256" ]; then
      printf '%s\n' "${files[i]}"
      return 0
    fi
  done
  return 1
}

# env_for_restore SRC_ENV DEST_ENV WORKDIR: the .env of the throwaway project, made from production's:
# everything the API needs to read the restored data (database and Garage credentials, the secret
# encryption key, the image) is kept, and everything that could reach out or collide is dropped or
# replaced: outgoing mail and push, the editor, ports, the import directory, the project name, and
# automatic migration (forced on).
env_for_restore() {
  local src="$1" dest="$2" workdir="$3"
  (
    umask 077
    grep -vE '^(COMPOSE_[A-Z_]*|RUCHOIR_SMTP_[A-Z_]*|RUCHOIR_PUSH_[A-Z_]*|RUCHOIR_OFFICE_[A-Z_]*|OFFICE_[A-Z_]*|RUCHOIR_IMPORT_HOST_DIR|RUCHOIR_BACKUP_[A-Z_]*|RUCHOIR_HOST_PORT|RUCHOIR_AUTO_MIGRATE|RUCHOIR_EMOJI_DIR|RUCHOIR_TLS_[A-Z_]*|POSTGRES_HOST_PORT|VALKEY_HOST_PORT|GARAGE_S3_HOST_PORT)=' "$src" >"$dest" || true
    {
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$RESTORE_TEST_PROJECT"
      printf 'RUCHOIR_IMPORT_HOST_DIR=%s/imports\n' "$workdir"
      # The throwaway database is a copy: a restored older schema is migrated, as a real recovery would.
      printf 'RUCHOIR_AUTO_MIGRATE=true\n'
    } >>"$dest"
  )
  chmod 600 "$dest"
}

# last_ok_state EPOCH_FILE INSTALLED_FILE NOW MAX_DAYS: the verdict of the monitoring check, as
# "ok MESSAGE" or "fail MESSAGE". Succeeded recently: ok. Never succeeded yet: ok while the install
# is younger than MAX_DAYS (the first run is done by hand, and the timer's first date may be weeks
# away), fail after.
last_ok_state() {
  local ok_file="$1" installed_file="$2" now="$3" max_days="$4" last age_days
  if [ -r "$ok_file" ]; then
    last="$(cat "$ok_file")"
    case "$last" in '' | *[!0-9]*) echo "fail the last-success file is unreadable"; return 0 ;; esac
    age_days=$(((now - last) / 86400))
    if [ "$age_days" -gt "$max_days" ]; then
      echo "fail the last successful restore test is $age_days days old (limit $max_days)"
    else
      echo "ok last successful restore test $age_days days ago"
    fi
    return 0
  fi
  if [ -r "$installed_file" ]; then
    last="$(cat "$installed_file")"
    case "$last" in '' | *[!0-9]*) echo "fail the install date is unreadable"; return 0 ;; esac
    age_days=$(((now - last) / 86400))
    if [ "$age_days" -gt "$max_days" ]; then
      echo "fail no restore test has ever succeeded ($age_days days since the install)"
    else
      echo "ok no restore test yet, installed $age_days days ago"
    fi
    return 0
  fi
  echo "fail the restore test is not installed (no last-success and no install date)"
}
