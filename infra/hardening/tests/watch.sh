#!/usr/bin/env bash
#
# Tests of infra/hardening/watch: watch_transition, ruchoir-watch and every check, against stubs
# and fixtures. Nothing here reaches a real server: HTTP goes to a throwaway local server.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

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
RUCHOIR_HARDENING_ROLE=site
HARDENING_PEER_NAMES="app.example.org office.app.example.org"
EOF
export RUCHOIR_HARDENING_ENV="$scratch/hardening.env"
export RUCHOIR_HARDENING_LIB="$here/common/lib.sh"
export WATCH_LIB="$here/watch/lib.sh"
export WATCH_CHECK_LIB="$here/watch/check-lib.sh"

# shellcheck source=../common/lib.sh
. "$here/common/lib.sh"
# shellcheck source=../watch/lib.sh
. "$here/watch/lib.sh"

# ---- watch_transition, with ruchoir-notify stubbed as a function that logs its calls -------------
sent="$scratch/sent"
ruchoir-notify() { printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$sent"; }
count() { if [ -f "$sent" ]; then wc -l <"$sent" | tr -d ' '; else echo 0; fi; }
reset() {
  rm -rf "$scratch/state" "$sent"
  mkdir -p "$scratch/state"
}

reset
WATCH_NOW=1000 watch_transition "$scratch/state" disk "ok fine"
check "first ok sends nothing" test "$(count)" = 0
WATCH_NOW=1060 watch_transition "$scratch/state" disk "fail 91% used"
check "ok then fail sends one alert" test "$(count)" = 1
check "the alert carries the level, the check and the message" \
  grep -q '^alert|.*disk.*|.*91% used' "$sent"
WATCH_NOW=1120 watch_transition "$scratch/state" disk "fail 92% used"
WATCH_NOW=1180 watch_transition "$scratch/state" disk "fail 93% used"
check "fail twice sends nothing more" test "$(count)" = 1
WATCH_NOW=1240 watch_transition "$scratch/state" disk "ok 40% used"
check "fail then ok sends one recovery" test "$(count)" = 2
check "the recovery is a recovered level" grep -q '^recovered|.*disk' "$sent"
WATCH_NOW=1300 watch_transition "$scratch/state" disk "ok 40% used"
check "ok again sends nothing" test "$(count)" = 2

reset
WATCH_NOW=1000 watch_transition "$scratch/state" mem "fail low"
check "a first result of fail alerts at once" test "$(count)" = 1

# flapping: every change is one message, never more
reset
t=1000
for r in ok fail ok fail ok; do
  WATCH_NOW=$t watch_transition "$scratch/state" flap "$r x"
  t=$((t + 60))
done
check "a flapping check sends one message per change" test "$(count)" = 4

# unknown: silent for 5 minutes, then one alert
reset
WATCH_NOW=1000 watch_transition "$scratch/state" net "unknown curl missing"
WATCH_NOW=1120 watch_transition "$scratch/state" net "unknown curl missing"
WATCH_NOW=1299 watch_transition "$scratch/state" net "unknown curl missing"
check "unknown sends nothing before 5 minutes" test "$(count)" = 0
WATCH_NOW=1300 watch_transition "$scratch/state" net "unknown curl missing"
check "unknown alerts once after 5 minutes" test "$(count)" = 1
check "the unknown alert carries the message" grep -q '^alert|.*net.*|.*curl missing' "$sent"
WATCH_NOW=1360 watch_transition "$scratch/state" net "unknown curl missing"
check "unknown keeps quiet after its alert" test "$(count)" = 1
WATCH_NOW=1420 watch_transition "$scratch/state" net "ok back"
check "ok after an alerted unknown is a recovery" test "$(count)" = 2

# a short unknown between two oks restarts its clock and says nothing
reset
WATCH_NOW=1000 watch_transition "$scratch/state" net "ok"
WATCH_NOW=1060 watch_transition "$scratch/state" net "unknown blip"
WATCH_NOW=1120 watch_transition "$scratch/state" net "ok"
WATCH_NOW=1180 watch_transition "$scratch/state" net "unknown blip"
WATCH_NOW=1400 watch_transition "$scratch/state" net "unknown blip"
check "a brief unknown does not accumulate across an ok" test "$(count)" = 0

# unknown while already failing does not alert again nor clear the failure
reset
WATCH_NOW=1000 watch_transition "$scratch/state" x "fail down"
WATCH_NOW=1060 watch_transition "$scratch/state" x "unknown ?"
WATCH_NOW=1500 watch_transition "$scratch/state" x "unknown ?"
check "unknown during a failure sends nothing" test "$(count)" = 1
WATCH_NOW=1560 watch_transition "$scratch/state" x "ok up"
check "the failure is still recovered afterwards" test "$(count)" = 2

# a malformed result is read as unknown, never as ok
reset
WATCH_NOW=1000 watch_transition "$scratch/state" y "garbage"
WATCH_NOW=1400 watch_transition "$scratch/state" y "garbage"
check "an unparseable result counts as unknown and alerts after 5 min" test "$(count)" = 1

# ---- pure helpers ------------------------------------------------------------------------------
now_2030="$(date -u -d '2030-01-01' +%s)"
check "days_until_enddate counts days" \
  test "$(WATCH_NOW=$now_2030 days_until_enddate 'notAfter=Jan 11 00:00:00 2030 GMT')" = 10
check "days_until_enddate is negative once expired" \
  test "$(WATCH_NOW=$((now_2030 + 11 * 86400)) days_until_enddate 'notAfter=Jan 11 00:00:00 2030 GMT')" -lt 0
check "days_until_enddate fails on garbage" bash -c '. "$1"; ! days_until_enddate nonsense >/dev/null 2>&1' _ "$here/watch/lib.sh"

printf 'Use%%\n 83%%\n' >"$scratch/df.out"
check "pct_from_df reads the percentage" test "$(pct_from_df <"$scratch/df.out")" = 83

# restart_burst STATEFILE: reads "name count" lines on stdin, prints the names restarted more than
# 3 times in the last 10 minutes
rm -f "$scratch/rs"
printf 'api 0\ndb 5\n' | WATCH_NOW=1000 restart_burst "$scratch/rs" >/dev/null
out="$(printf 'api 2\ndb 5\n' | WATCH_NOW=1060 restart_burst "$scratch/rs")"
check "restart_burst stays quiet for 2 restarts" test -z "$out"
out="$(printf 'api 4\ndb 5\n' | WATCH_NOW=1120 restart_burst "$scratch/rs")"
check "restart_burst names a container restarted more than 3 times" test "$out" = "api"
out="$(printf 'api 4\ndb 5\n' | WATCH_NOW=2000 restart_burst "$scratch/rs")"
check "restart_burst forgets samples older than 10 minutes" test -z "$out"
out="$(printf 'api 0\ndb 5\n' | WATCH_NOW=2060 restart_burst "$scratch/rs")"
check "restart_burst ignores a recreated container (count went down)" test -z "$out"

# ---- ruchoir-watch end to end, with fake checks -------------------------------------------------
checks="$scratch/checks.d"
mkdir -p "$checks"
printf '#!/usr/bin/env bash\necho "ok all good"\n' >"$checks/good.sh"
printf '#!/usr/bin/env bash\necho "fail it is down"\n' >"$checks/bad.sh"
printf '#!/usr/bin/env bash\nsleep 30\necho "ok late"\n' >"$checks/slow.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$checks/silent.sh"
printf '#!/usr/bin/env bash\necho "fail first"\necho "ok second"\nexit 3\n' >"$checks/noisy.sh"
printf 'not a check\n' >"$checks/readme.txt"
chmod +x "$checks"/*.sh
printf '#!/usr/bin/env bash\nprintf "%%s|%%s|%%s\\n" "$1" "$2" "$3" >>"%s"\n' "$scratch/watch-sent" >"$scratch/notify-stub"
chmod +x "$scratch/notify-stub"
run_watch() {
  WATCH_NOTIFY="$scratch/notify-stub" WATCH_CHECKS_DIR="$checks" WATCH_STATE_DIR="$scratch/wstate" \
    WATCH_TIMEOUT=1 WATCH_NOW="$1" bash "$here/watch/ruchoir-watch"
}
run_watch 1000
check "ruchoir-watch alerts on a failing check" grep -q '^alert|.*bad' "$scratch/watch-sent"
check "ruchoir-watch does not alert on a good check" bash -c '! grep -q "good" "$1"' _ "$scratch/watch-sent"
check "a check that times out is stored as unknown" grep -q '^unknown' "$scratch/wstate/slow.last"
check "a check that prints nothing is stored as unknown" grep -q '^unknown' "$scratch/wstate/silent.last"
check "only the first line of a check counts" grep -q '^fail first' "$scratch/wstate/noisy.last"
check "a non-script file in checks.d is ignored" test ! -e "$scratch/wstate/readme.last"
before="$(wc -l <"$scratch/watch-sent")"
run_watch 1060
check "a second run with the same results sends nothing" test "$(wc -l <"$scratch/watch-sent")" = "$before"
run_watch 1400
check "after 5 minutes a silent check alerts as unknown" grep -q '^alert|.*silent' "$scratch/watch-sent"
check "a held lock makes the run skip and exit 0" bash -c '
  exec 9>"$1/.lock"
  flock -n 9
  WATCH_NOTIFY=true WATCH_CHECKS_DIR="$2" WATCH_STATE_DIR="$1" bash "$3" >/dev/null 2>&1' _ \
  "$scratch/wstate" "$checks" "$here/watch/ruchoir-watch"

# ---- the checks, one by one ---------------------------------------------------------------------
cdir="$here/watch/checks.d"
is() { # is WORD COMMAND...: the command prints exactly one line, starting with WORD, and exits 0
  local want="$1" out
  shift
  out="$("$@")" || return 1
  [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] && [[ "$out" == "$want "* ]]
}

# disk
check "disk ok under the limit" is ok env WATCH_DISK_MAX=100 bash "$cdir/disk.sh"
check "disk fails over the limit" is fail env WATCH_DISK_MAX=-1 bash "$cdir/disk.sh"

# memory
printf 'MemTotal:       16000000 kB\nMemFree: 100 kB\nMemAvailable:    8000000 kB\n' >"$scratch/mem-ok"
printf 'MemTotal:       16000000 kB\nMemFree: 100 kB\nMemAvailable:     800000 kB\n' >"$scratch/mem-low"
check "memory ok at 50 percent available" is ok env WATCH_MEMINFO="$scratch/mem-ok" bash "$cdir/memory.sh"
check "memory fails at 5 percent available" is fail env WATCH_MEMINFO="$scratch/mem-low" bash "$cdir/memory.sh"
check "memory is unknown when the file is unreadable" is unknown env WATCH_MEMINFO="$scratch/none" bash "$cdir/memory.sh"

# backup-age and pull-age
mkdir -p "$scratch/backups"
check "backup-age fails with no archive" is fail env WATCH_BACKUP_DIR="$scratch/backups" bash "$cdir/backup-age.sh"
touch "$scratch/backups/ruchoir-new.tar.gz.enc"
check "backup-age ok for a fresh archive" is ok env WATCH_BACKUP_DIR="$scratch/backups" bash "$cdir/backup-age.sh"
touch -d '30 hours ago' "$scratch/backups/ruchoir-new.tar.gz.enc"
check "backup-age fails for a 30 hour old archive" is fail env WATCH_BACKUP_DIR="$scratch/backups" bash "$cdir/backup-age.sh"
date +%s >"$scratch/last-ok"
check "pull-age ok for a fresh last-ok" is ok env WATCH_PULL_LASTOK="$scratch/last-ok" bash "$cdir/pull-age.sh"
echo $(($(date +%s) - 30 * 3600)) >"$scratch/last-ok"
check "pull-age fails after 30 hours" is fail env WATCH_PULL_LASTOK="$scratch/last-ok" bash "$cdir/pull-age.sh"
check "pull-age fails when no pull was ever recorded" is fail env WATCH_PULL_LASTOK="$scratch/missing" bash "$cdir/pull-age.sh"
echo garbage >"$scratch/last-ok"
check "pull-age is unknown on a garbled last-ok" is unknown env WATCH_PULL_LASTOK="$scratch/last-ok" bash "$cdir/pull-age.sh"

# secrets-mode
mkdir -p "$scratch/inst"
printf 'X=1\n' >"$scratch/inst/.env"
printf 'k\n' >"$scratch/inst/backup.key"
printf 'RUCHOIR_BACKUP_KEY_FILE=%s\n' "$scratch/inst/backup.key" >>"$scratch/inst/.env"
chmod 600 "$scratch/inst/.env" "$scratch/inst/backup.key"
me="$(id -un)"
check "secrets-mode ok at 600 for the expected owner" \
  is ok env WATCH_INSTANCE="$scratch/inst" WATCH_SECRETS_OWNER="$me" bash "$cdir/secrets-mode.sh"
chmod 644 "$scratch/inst/.env"
check "secrets-mode fails on a 644 .env" \
  is fail env WATCH_INSTANCE="$scratch/inst" WATCH_SECRETS_OWNER="$me" bash "$cdir/secrets-mode.sh"
chmod 600 "$scratch/inst/.env"
check "secrets-mode fails on the wrong owner" \
  is fail env WATCH_INSTANCE="$scratch/inst" WATCH_SECRETS_OWNER=nobody-such bash "$cdir/secrets-mode.sh"
chmod 640 "$scratch/inst/backup.key"
check "secrets-mode fails on a group readable backup key" \
  is fail env WATCH_INSTANCE="$scratch/inst" WATCH_SECRETS_OWNER="$me" bash "$cdir/secrets-mode.sh"

# containers, with a stub docker
cat >"$scratch/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  ps) cat "$DOCKER_PS" ;;
  inspect) cat "$DOCKER_INSPECT" ;;
esac
EOF
chmod +x "$scratch/docker"
printf 'api|Up 3 hours (healthy)|a1\ndb|Up 3 hours|b2\n' >"$scratch/ps-ok"
printf '/api 0\n/db 0\n' >"$scratch/inspect-ok"
printf 'api|Up 3 hours (unhealthy)|a1\ndb|Up 3 hours|b2\n' >"$scratch/ps-unhealthy"
printf 'api|Restarting (1) 4 seconds ago|a1\n' >"$scratch/ps-restarting"
ccheck() {
  env WATCH_DOCKER="$scratch/docker" WATCH_STATE_DIR="$scratch/cstate" DOCKER_PS="$1" DOCKER_INSPECT="$2" \
    bash "$cdir/containers.sh"
}
check "containers ok when all are healthy" is ok ccheck "$scratch/ps-ok" "$scratch/inspect-ok"
check "containers fail on an unhealthy one" is fail ccheck "$scratch/ps-unhealthy" "$scratch/inspect-ok"
check "containers fail on a restarting one" is fail ccheck "$scratch/ps-restarting" "$scratch/inspect-ok"
check "containers are unknown when docker is not there" \
  is unknown env WATCH_DOCKER="$scratch/nodocker" WATCH_STATE_DIR="$scratch/cstate" bash "$cdir/containers.sh"

# tls-expiry, with a stub for the certificate fetch
cat >"$scratch/enddate-stub" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  soon.example.org) echo "notAfter=$(LC_ALL=C date -u -d '+5 days' '+%b %e %H:%M:%S %Y GMT')" ;;
  broken.example.org) exit 1 ;;
  *) echo "notAfter=$(LC_ALL=C date -u -d '+60 days' '+%b %e %H:%M:%S %Y GMT')" ;;
esac
EOF
chmod +x "$scratch/enddate-stub"
tls() { env WATCH_ENDDATE_CMD="$scratch/enddate-stub" HARDENING_PEER_NAMES_OVERRIDE="$1" bash "$cdir/tls-expiry.sh"; }
check "tls-expiry ok when every name has 60 days" is ok tls "a.example.org b.example.org"
check "tls-expiry fails when one name has 5 days" is fail tls "a.example.org soon.example.org"
check "tls-expiry names the culprit" grep -q soon.example.org <(tls "a.example.org soon.example.org")
check "tls-expiry is unknown when a certificate cannot be fetched" is unknown tls "a.example.org broken.example.org"

# peer-http, against a throwaway local server (role site probes the app's names)
cat >"$scratch/server.py" <<'EOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

health = sys.argv[2]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        code, body = 200, b"hello"
        if self.path == "/api/v1/health":
            body = json.dumps({"status": "ok", "database": health, "cache": "ok"}).encode()
        elif self.path == "/v2/":
            code = 401
        elif self.path == "/missing":
            code = 404
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
EOF
if command -v python3 >/dev/null 2>&1; then
  port=18931
  python3 -I "$scratch/server.py" "$port" ok &
  server_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fs -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null && break
    sleep 0.3
  done
  peer() { # peer ROLE NAMES [extra env...]
    local role="$1" names="$2"
    shift 2
    env WATCH_PEER_SCHEME=http RUCHOIR_HARDENING_ROLE="$role" HARDENING_PEER_NAMES_OVERRIDE="$names" "$@" \
      bash "$cdir/peer-http.sh"
  }
  check "peer-http (watching app) ok when health reports database and cache ok" \
    is ok peer site "127.0.0.1:$port"
  check "peer-http (watching app) accepts the office name answering" \
    is ok peer site "127.0.0.1:$port office.localhost:$port"
  check "peer-http (watching app) fails on a dead name" is fail peer site "127.0.0.1:1"
  check "peer-http (watching site) ok: registry 401 and website 200" \
    is ok peer app "www.localhost:$port registry.localhost:$port"
  check "peer-http (watching site) fails when the website answers 404" \
    is fail peer app "www.localhost:$port" WATCH_SITE_PATH=/missing
  kill "$server_pid" 2>/dev/null || true
  python3 -I "$scratch/server.py" "$port" down &
  server_pid=$!
  sleep 0.8
  check "peer-http fails when the database is reported down" is fail peer site "127.0.0.1:$port"
else
  echo "  skip peer-http (no python3)"
fi

# ---- the installs, dry run into a throwaway prefix: second run changes nothing --------------------
inst() { # inst LOT ROLE
  HARDENING_DRY_RUN=1 HARDENING_PREFIX="$scratch/root-$2" bash "$here/install" "$1"
}
for role in app site; do
  sed "s/^RUCHOIR_HARDENING_ROLE=.*/RUCHOIR_HARDENING_ROLE=$role/" "$scratch/hardening.env" >"$scratch/env-$role"
  first="$(RUCHOIR_HARDENING_ENV="$scratch/env-$role" inst watch "$role")"
  second="$(RUCHOIR_HARDENING_ENV="$scratch/env-$role" inst watch "$role")"
  check "watch install ($role) installs something the first time" grep -q '^installed' <<<"$first"
  check "watch install ($role) second run prints only unchanged lines" \
    bash -c '! grep -v -e "^unchanged" -e "^dry run" <<<"$1"' _ "$second"
  check "watch install ($role) links the common checks" \
    test -L "$scratch/root-$role/etc/ruchoir-watch/checks.d/peer-http.sh"
done
check "app role links backup-age and not pull-age" \
  bash -c 'd="$1/etc/ruchoir-watch/checks.d"; [ -L "$d/backup-age.sh" ] && [ ! -e "$d/pull-age.sh" ] && [ -L "$d/secrets-mode.sh" ]' _ "$scratch/root-app"
check "site role links pull-age and not backup-age" \
  bash -c 'd="$1/etc/ruchoir-watch/checks.d"; [ -L "$d/pull-age.sh" ] && [ ! -e "$d/backup-age.sh" ]' _ "$scratch/root-site"
check "changing the role removes the other role's links" bash -c '
  RUCHOIR_HARDENING_ENV="$1" HARDENING_DRY_RUN=1 HARDENING_PREFIX="$2" bash "$3" watch >/dev/null
  [ ! -e "$2/etc/ruchoir-watch/checks.d/backup-age.sh" ] && [ -L "$2/etc/ruchoir-watch/checks.d/pull-age.sh" ]' _ \
  "$scratch/env-site" "$scratch/root-app" "$here/install"

check "every check prints one line and exits 0 with an unreadable env" \
  bash -c 'for c in "$1"/*.sh; do out="$(RUCHOIR_HARDENING_ENV=/nonexistent bash "$c")" || exit 1; [ "$(printf "%s\n" "$out" | wc -l | tr -d " ")" = 1 ] || exit 1; done' _ "$cdir" 2>/dev/null

if [ "$fails" -ne 0 ]; then
  echo "watch: $fails failed" >&2
  exit 1
fi
