#!/usr/bin/env bash
#
# Tests of infra/hardening/restore-test: the isolation check, the count comparison, the archive
# choice, the .env made for the throwaway project, the monitoring verdict, the script's refusal to
# start a project that is not isolated (with a stub `docker`), its overridable paths, and the
# installer's idempotence.
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

# shellcheck source=../restore-test/lib.sh
. "$here/restore-test/lib.sh"
script="$here/restore-test/ruchoir-restore-test"
lib="$here/restore-test/lib.sh"

work="$scratch/work"
mkdir -p "$work"

# A resolved configuration as `docker compose config --format json` prints it for the override.
cat >"$scratch/good.json" <<EOF
{
  "name": "ruchoir-restoretest",
  "services": {
    "postgres": {"image": "postgres:18-alpine", "mem_limit": "1073741824",
      "volumes": [{"type": "volume", "source": "postgres-data", "target": "/var/lib/postgresql"}]},
    "garage": {"image": "garage", "mem_limit": "1073741824",
      "volumes": [{"type": "bind", "source": "$work/infra/garage/garage.toml", "target": "/etc/garage.toml"}]},
    "api": {"image": "api", "mem_limit": "1610612736", "networks": {"default": null, "office": null},
      "volumes": [{"type": "bind", "source": "$work/imports", "target": "/srv/ruchoir/imports"}]}
  },
  "networks": {"default": {"name": "ruchoir-restoretest_default", "internal": true},
               "office": {"name": "ruchoir-restoretest_office", "internal": true}},
  "volumes": {"postgres-data": {"name": "ruchoir-restoretest_postgres-data"}}
}
EOF

# mutate NAME PYTHON-STATEMENT: a broken copy of the good sample.
mutate() {
  python3 -I - "$scratch/good.json" "$scratch/$1.json" "$2" <<'PY'
import json, sys
src, dest, stmt = sys.argv[1:4]
cfg = json.load(open(src))
exec(stmt)
json.dump(cfg, open(dest, "w"))
PY
}
mutate name_prod 'cfg["name"] = "ruchoir"'
mutate port 'cfg["services"]["api"]["ports"] = [{"mode": "ingress", "target": 8080, "published": "8080"}]'
mutate external_volume 'cfg["volumes"]["postgres-data"]["external"] = True'
mutate open_network 'cfg["networks"]["default"]["internal"] = False'
mutate external_network 'cfg["networks"]["office"]["external"] = True'
mutate no_limit 'del cfg["services"]["garage"]["mem_limit"]'
mutate bind_outside 'cfg["services"]["api"]["volumes"][0]["source"] = "/srv/ruchoir/imports"'
mutate host_net 'cfg["services"]["api"]["network_mode"] = "host"'
mutate named 'cfg["services"]["api"]["container_name"] = "ruchoir-api-1"'

check "assert_isolated passes on the throwaway project" assert_isolated "$scratch/good.json" "$work"
reason_of() { { assert_isolated "$scratch/$1.json" "$work" >/dev/null; } 2>&1 || true; }
check "assert_isolated refuses the production project name" grep -q "not 'ruchoir-restoretest'" <<<"$(reason_of name_prod)"
check "assert_isolated refuses a published port" grep -q "service api publishes a port" <<<"$(reason_of port)"
check "assert_isolated refuses an external volume" grep -q "volume postgres-data is external" <<<"$(reason_of external_volume)"
check "assert_isolated refuses a network with a route out" grep -q "network default is not internal" <<<"$(reason_of open_network)"
check "assert_isolated refuses an external network" grep -q "network office is external" <<<"$(reason_of external_network)"
check "assert_isolated refuses a service without a memory cap" grep -q "service garage has no memory limit" <<<"$(reason_of no_limit)"
check "assert_isolated refuses a bind mount outside the work directory" grep -q "mounts /srv/ruchoir/imports" <<<"$(reason_of bind_outside)"
check "assert_isolated refuses host networking" grep -q "network_mode host" <<<"$(reason_of host_net)"
check "assert_isolated refuses a container name" grep -q "sets a container name" <<<"$(reason_of named)"
for broken in name_prod port external_volume open_network external_network no_limit bind_outside host_net named; do
  check "assert_isolated exits non-zero: $broken" bash -c '! { . "$1"; assert_isolated "$2" "$3"; } 2>/dev/null' _ "$lib" "$scratch/$broken.json" "$work"
done

# counts_close
check "counts_close accepts 1000 and 1009" counts_close 1000 1009
check "counts_close accepts 5 and 14" counts_close 5 14
check "counts_close rejects 1000 and 1020" bash -c '. "$1"; ! counts_close 1000 1020' _ "$lib"
check "counts_close rejects 0 and 5" bash -c '. "$1"; ! counts_close 0 5' _ "$lib"
check "counts_close accepts 0 and 0" counts_close 0 0
check "counts_close accepts 20000 and 20190 (1 percent)" counts_close 20000 20190
check "counts_close rejects a non-number" bash -c '. "$1"; ! counts_close 12 abc' _ "$lib"

# newest_archive
bk="$scratch/backups"
mkdir -p "$bk"
touch "$bk/ruchoir-20261101T033600Z.tar.gz.enc" "$bk/ruchoir-20261101T033600Z.tar.gz.enc.sha256"
touch "$bk/ruchoir-20261102T033600Z.tar.gz.enc" # newest, but no checksum yet: still being written
check "newest_archive skips an archive without its checksum" test "$(newest_archive "$bk")" = "$bk/ruchoir-20261101T033600Z.tar.gz.enc"
touch "$bk/ruchoir-20261102T033600Z.tar.gz.enc.sha256"
check "newest_archive picks the newest sealed archive" test "$(newest_archive "$bk")" = "$bk/ruchoir-20261102T033600Z.tar.gz.enc"
check "newest_archive fails on an empty directory" bash -c '. "$1"; ! newest_archive "$2"' _ "$lib" "$scratch/nothing"

# env_for_restore
cat >"$scratch/prod.env" <<'EOF'
COMPOSE_PROFILES=office
COMPOSE_PROJECT_NAME=ruchoir
POSTGRES_PASSWORD=pw-kept
S3_ACCESS_KEY_ID=key-kept
RUCHOIR_IMAGE=registry.example.org/ruchoir/api:v1.2.3
RUCHOIR_SMTP_HOST=smtp.example.org
RUCHOIR_SMTP_PASSWORD=smtp-secret
RUCHOIR_PUSH_RELAY_URL=https://relay.example.org
RUCHOIR_OFFICE_URL=http://office
OFFICE_JWT_SECRET=office-secret
RUCHOIR_IMPORT_HOST_DIR=/srv/ruchoir/imports
RUCHOIR_BACKUP_KEY_FILE=/etc/ruchoir/backup.key
RUCHOIR_HOST_PORT=8080
RUCHOIR_AUTO_MIGRATE=false
RUCHOIR_SECRET_ENCRYPTION_KEY=enc-kept
EOF
env_for_restore "$scratch/prod.env" "$scratch/restore.env" "$work"
check "restore .env keeps the database password" grep -q '^POSTGRES_PASSWORD=pw-kept$' "$scratch/restore.env"
check "restore .env keeps the Garage key and the secret key" bash -c 'grep -q "^S3_ACCESS_KEY_ID=key-kept$" "$1" && grep -q "^RUCHOIR_SECRET_ENCRYPTION_KEY=enc-kept$" "$1"' _ "$scratch/restore.env"
check "restore .env keeps the image" grep -q '^RUCHOIR_IMAGE=registry.example.org/ruchoir/api:v1.2.3$' "$scratch/restore.env"
check "restore .env drops mail, push, editor, ports and profiles" bash -c '! grep -qE "SMTP|PUSH|OFFICE|HOST_PORT|COMPOSE_PROFILES|backup.key|/srv/ruchoir/imports" "$1"' _ "$scratch/restore.env"
check "restore .env fixes the project name once" test "$(grep -c '^COMPOSE_PROJECT_NAME=' "$scratch/restore.env")" = 1
check "restore .env names the project ruchoir-restoretest" grep -q '^COMPOSE_PROJECT_NAME=ruchoir-restoretest$' "$scratch/restore.env"
check "restore .env points the import directory into the work directory" grep -q "^RUCHOIR_IMPORT_HOST_DIR=$work/imports\$" "$scratch/restore.env"
check "restore .env forces automatic migration on" bash -c '[ "$(grep -c "^RUCHOIR_AUTO_MIGRATE=" "$1")" = 1 ] && grep -q "^RUCHOIR_AUTO_MIGRATE=true$" "$1"' _ "$scratch/restore.env"
check "restore .env is 0600" test "$(stat -c %a "$scratch/restore.env")" = 600

# last_ok_state
now=2000000000
day=86400
printf '%s\n' "$((now - 10 * day))" >"$scratch/ok"
check "check: a success 10 days ago is ok" test "$(last_ok_state "$scratch/ok" "$scratch/none" "$now" 35 | cut -d' ' -f1)" = ok
printf '%s\n' "$((now - 36 * day))" >"$scratch/old"
check "check: a success 36 days ago fails" test "$(last_ok_state "$scratch/old" "$scratch/none" "$now" 35 | cut -d' ' -f1)" = fail
printf '%s\n' "$((now - 3 * day))" >"$scratch/inst"
check "check: never run, installed 3 days ago, is ok" test "$(last_ok_state "$scratch/none" "$scratch/inst" "$now" 35 | cut -d' ' -f1)" = ok
printf '%s\n' "$((now - 40 * day))" >"$scratch/inst_old"
check "check: never run, installed 40 days ago, fails" test "$(last_ok_state "$scratch/none" "$scratch/inst_old" "$now" 35 | cut -d' ' -f1)" = fail
check "check: nothing at all fails" test "$(last_ok_state "$scratch/none" "$scratch/none" "$now" 35 | cut -d' ' -f1)" = fail

# The script itself, against a stub `docker` that records every call and answers `config` from a
# file. The point: when the resolved configuration is not isolated, nothing is ever started.
stub="$scratch/stub"
mkdir -p "$stub" "$scratch/prod" "$scratch/state"
cat >"$stub/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
case "$*" in
  *"config --format json"*) cat "$STUB_CONFIG_JSON" ;;
  *"config"*) printf 'name: ruchoir-restoretest\n' ;;
esac
exit 0
EOF
chmod +x "$stub/docker"
printf 'POSTGRES_PASSWORD=pw\n' >"$scratch/prod/.env"
printf 'services: {}\n' >"$scratch/prod/docker-compose.yml"
mkdir -p "$scratch/prod/infra/garage" "$scratch/prod/scripts"
printf 'x\n' >"$scratch/prod/infra/garage/garage.toml"
printf '#!/bin/sh\nexit 0\n' >"$scratch/prod/scripts/restore.sh"
printf 'key\n' >"$scratch/key"
cat >"$scratch/notify" <<'EOF'
#!/usr/bin/env bash
printf 'NOTIFY %s | %s | %s\n' "$1" "$2" "$3"
EOF
chmod +x "$scratch/notify"
run_script() { # run_script CONFIG_JSON: prints the script's output, returns its status
  : >"$scratch/stub.log"
  env PATH="$stub:$PATH" STUB_LOG="$scratch/stub.log" STUB_CONFIG_JSON="$1" \
    RESTORE_TEST_PROD_DIR="$scratch/prod" RESTORE_TEST_BACKUP_DIR="$bk" \
    RESTORE_TEST_KEY_FILE="$scratch/key" RESTORE_TEST_WORK_DIR="$scratch/rt-work" \
    RESTORE_TEST_STATE_DIR="$scratch/state" RESTORE_TEST_NOTIFY="$scratch/notify" \
    RESTORE_TEST_MIN_MEM_MB=0 bash "$script" 2>&1
}

status=0
out="$(run_script "$scratch/name_prod.json")" || status=$?
check "the script refuses a configuration naming the production project" grep -q "not isolated" <<<"$out"
check "the script alerts when it refuses" grep -q "NOTIFY alert" <<<"$out"
check "the script fails with a non-zero status" test "$status" -ne 0
check "the script never ran 'up' on a non-isolated configuration" bash -c '! grep -qE "(^| )up( |$)" "$1"' _ "$scratch/stub.log"
check "the script never wrote a last-success" test ! -e "$scratch/state/restore-test.last-ok"
check "the script removed its work directory" test ! -e "$scratch/rt-work"
check "the script removes the volumes restore.sh made, by exact name" bash -c 'for v in postgres-data valkey-data garage-meta garage-data; do grep -qx "volume rm -f ruchoir-restoretest_$v" "$1" || exit 1; done' _ "$scratch/stub.log"
check "the script removes no volume of another project" bash -c '! grep "volume rm" "$1" | grep -qv "ruchoir-restoretest_"' _ "$scratch/stub.log"
status=0
out="$(run_script "$scratch/port.json")" || status=$?
check "the script refuses a published port too" grep -q "publishes a port" <<<"$out"
check "...and again never ran 'up'" bash -c '! grep -qE "(^| )up( |$)" "$1"' _ "$scratch/stub.log"

# Defaults and overrides of the paths.
defaults="$(env -u RESTORE_TEST_PROD_DIR -u RESTORE_TEST_BACKUP_DIR -u RESTORE_TEST_KEY_FILE -u RESTORE_TEST_WORK_DIR -u RESTORE_TEST_STATE_DIR bash "$script" --print-config 2>&1 || true)"
check "default production directory" grep -qx "prod_dir=/opt/ruchoir" <<<"$defaults"
check "default backup directory" grep -qx "backup_dir=/srv/ruchoir/backups" <<<"$defaults"
check "default work directory" grep -qx "work_dir=/srv/ruchoir-restoretest" <<<"$defaults"
check "default key file, with no .env to read" grep -qx "key_file=/etc/ruchoir/backup.key" <<<"$defaults"
check "the project is fixed" grep -qx "project=ruchoir-restoretest" <<<"$defaults"
printf 'RUCHOIR_BACKUP_KEY_FILE=/somewhere/else.key\n' >"$scratch/prod/.env"
fromenv="$(env -u RESTORE_TEST_KEY_FILE RESTORE_TEST_PROD_DIR="$scratch/prod" bash "$script" --print-config 2>&1 || true)"
check "the key file is read from production's .env" grep -qx "key_file=/somewhere/else.key" <<<"$fromenv"
overridden="$(RESTORE_TEST_PROD_DIR=/p RESTORE_TEST_BACKUP_DIR=/b RESTORE_TEST_KEY_FILE=/k RESTORE_TEST_WORK_DIR=/w RESTORE_TEST_STATE_DIR=/s bash "$script" --print-config 2>&1 || true)"
check "every path can be overridden" bash -c 'for l in prod_dir=/p backup_dir=/b key_file=/k work_dir=/w state_dir=/s; do grep -qx "$l" <<<"$1" || exit 1; done' _ "$overridden"
check "the work directory cannot be production's" bash -c '! RESTORE_TEST_PROD_DIR=/p RESTORE_TEST_WORK_DIR=/p bash "$1" --print-config >/dev/null 2>&1' _ "$script"
check "the work directory cannot be the filesystem root" bash -c '! RESTORE_TEST_WORK_DIR=/ bash "$1" --print-config >/dev/null 2>&1' _ "$script"

# The monitoring check follows the contract: one line, ok|fail|unknown, exit 0.
chk="$here/restore-test/checks.d/restore-test.sh"
export RUCHOIR_HARDENING_LIB="$here/common/lib.sh" WATCH_LIB="$here/watch/lib.sh"
export WATCH_CHECK_LIB="$here/watch/check-lib.sh" RESTORE_TEST_LIB="$here/restore-test/lib.sh"
printf '%s\n' "$(date +%s)" >"$scratch/state/restore-test.last-ok"
line="$(RESTORE_TEST_STATE_DIR="$scratch/state" bash "$chk")"
check "the check prints a single ok line" bash -c '[ "$(wc -l <<<"$1")" = 1 ] && [[ "$1" == ok\ * ]]' _ "$line"
rm -f "$scratch/state/restore-test.last-ok"
line="$(RESTORE_TEST_STATE_DIR="$scratch/state" bash "$chk")"
check "the check prints fail when nothing is known" bash -c '[[ "$1" == fail\ * ]]' _ "$line"
check "the check exits 0 whatever it says" env RESTORE_TEST_STATE_DIR="$scratch/state" bash "$chk" >/dev/null

# The installer is idempotent.
mkdir -p "$scratch/root"
inst() { HARDENING_DRY_RUN=1 HARDENING_PREFIX="$scratch/root" HARDENING_ROOT="$here" RUCHOIR_HARDENING_ROLE=app bash "$here/restore-test/install.sh" 2>&1; }
first="$(inst)"
second="$(inst)"
check "install installs the files the first time" grep -q "^installed $scratch/root/usr/local/sbin/ruchoir-restore-test" <<<"$first"
check "install links the check where the watch looks" test "$(readlink "$scratch/root/etc/ruchoir-watch/checks.d/restore-test.sh")" = /usr/local/lib/ruchoir-hardening/checks/restore-test.sh
check "install copies the check where the lots keep theirs" test -x "$scratch/root/usr/local/lib/ruchoir-hardening/checks/restore-test.sh"
check "install records the install date" test -s "$scratch/root/var/lib/ruchoir-hardening/restore-test.installed"
check "a second install prints only unchanged lines" bash -c '! grep -q "^installed" <<<"$1"' _ "$second"
check "install refuses the site role" bash -c '! HARDENING_DRY_RUN=1 HARDENING_PREFIX="$2" HARDENING_ROOT="$3" RUCHOIR_HARDENING_ROLE=site bash "$1" >/dev/null 2>&1' _ "$here/restore-test/install.sh" "$scratch/root" "$here"
check "the timer fires on the 1st at 05:00 UTC" grep -q '^OnCalendar=\*-\*-01 05:00:00 UTC$' "$here/restore-test/ruchoir-restore-test.timer"

# scripts/backup.sh and scripts/restore.sh name the Garage and Valkey volumes after the Compose
# project of their directory. Written as `ruchoir_*` they would have touched production's volumes
# from any other project, which is what the restore test runs in. A stub `docker` records the
# volumes each one mounts.
repo="$(cd "$here/../.." && pwd)"
vols="$scratch/vols"
mkdir -p "$vols/scripts" "$vols/bin" "$vols/empty"
cp "$repo/scripts/backup.sh" "$repo/scripts/restore.sh" "$vols/scripts/"
cat >"$vols/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_LOG"
case "$*" in
  "compose config") printf 'name: %s\nservices: {}\n' "$STUB_PROJECT" ;;
  *to_regclass*) printf 'instance_events\n' ;;
  *"valkey-cli SAVE"*) ;;
  *"cat /data/dump.rdb"*) printf 'rdb' ;;
  *"pg_dump"*) printf 'dump' ;;
  *"tar -C /src"*) # backup.sh reading a volume: leave a tar in the mounted output directory
    out="$(sed -n 's/.* -v \([^ ]*\):\/out.*/\1/p' <<<"$*")"
    name="$(sed -n 's/.*-cf \/out\/\([^ ]*\) .*/\1/p' <<<"$*")"
    tar -C "$STUB_EMPTY" -cf "$out/$name" . ;;
esac
exit 0
EOF
chmod +x "$vols/bin/docker"
printf 'key-for-the-rehearsal\n' >"$vols/key"
: >"$vols/.env"
run_in_project() { # run_in_project PROJECT COMMAND...
  local project="$1"
  shift
  : >"$scratch/stub.log"
  (cd "$vols" && env PATH="$vols/bin:$PATH" STUB_LOG="$scratch/stub.log" STUB_PROJECT="$project" \
    STUB_EMPTY="$vols/empty" RUCHOIR_BACKUP_KEY_FILE="$vols/key" "$@") >"$scratch/run.out" 2>&1
}
run_in_project ruchoir-restoretest bash scripts/backup.sh --no-pause --out "$vols/out" || true
check "backup.sh mounts the volumes of its own project" grep -q 'ruchoir-restoretest_garage-meta:/src:ro' "$scratch/stub.log"
check "backup.sh mounts no ruchoir_ volume from another project" bash -c '! grep -q -- "-v ruchoir_" "$1"' _ "$scratch/stub.log"
archive="$(find "$vols/out" -name 'ruchoir-*.tar.gz.enc' 2>/dev/null | head -n 1)"
check "backup.sh wrote an archive in the rehearsal" test -n "$archive"
run_in_project ruchoir-restoretest bash scripts/restore.sh "$archive" --yes || true
check "restore.sh writes the volumes of its own project" grep -q 'ruchoir-restoretest_garage-data:/dst' "$scratch/stub.log"
check "restore.sh writes the valkey volume of its own project" grep -q 'ruchoir-restoretest_valkey-data:/dst' "$scratch/stub.log"
check "restore.sh touches no ruchoir_ volume from another project" bash -c '! grep -q -- "-v ruchoir_" "$1"' _ "$scratch/stub.log"
check "restore.sh waits for PostgreSQL over TCP, not the init-time socket" grep -q 'pg_isready -h 127.0.0.1' "$scratch/stub.log"
check "restore.sh creates the API when it never existed (up, not start)" grep -q 'compose up -d api' "$scratch/stub.log"
run_in_project ruchoir bash scripts/restore.sh "$archive" --yes || true
check "in the production project the volumes are still ruchoir_*" grep -q -- '-v ruchoir_garage-meta:/dst' "$scratch/stub.log"
run_in_project "" bash scripts/restore.sh "$archive" --yes && no_project=0 || no_project=1
check "restore.sh refuses when it cannot tell the project" test "$no_project" = 1

if [ "$fails" -ne 0 ]; then
  echo "restore-test: $fails failed" >&2
  exit 1
fi
