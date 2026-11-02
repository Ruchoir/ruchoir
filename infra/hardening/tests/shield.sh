#!/usr/bin/env bash
#
# Tests of infra/hardening/shield: allowlist rendering, the sign-in scenario played against log
# lines, the login alert's source matching, the AIDE scripts (with a stub aide), the probes' output
# contract, and (when Docker is available) nginx -t on a scratch config that includes the files.
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

# shellcheck source=../shield/lib.sh
. "$here/shield/lib.sh"
# shellcheck source=../shield/pam/ruchoir-login-alert
. "$here/shield/pam/ruchoir-login-alert"

house=198.51.100.7
peer=203.0.113.20

# Allowlist rendering
allow="$(render_allowlist "$house" "$peer")"
check "allowlist names the house" grep -q "\"$house\"" <<<"$allow"
check "allowlist names the peer server" grep -q "\"$peer\"" <<<"$allow"
check "allowlist names the loopback ranges" grep -q '127.0.0.0/8' <<<"$allow"
check "allowlist names the IPv6 loopback" grep -q '"::1"' <<<"$allow"
printf '%s\n' "$allow" >"$scratch/allowlist.yaml"
check "allowlist is valid YAML with a whitelist" python3 -I -c '
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
assert d["name"] and "198.51.100.7" in d["whitelist"]["ip"] and "203.0.113.20" in d["whitelist"]["ip"]
' "$scratch/allowlist.yaml"
check "allowlist refuses an address that is not one" bash -c '. "$1"; ! render_allowlist "198.51.100.7; rm" 203.0.113.20 >/dev/null 2>&1' _ "$here/shield/lib.sh"
check "allowlist refuses 999.1.1.1" bash -c '. "$1"; ! render_allowlist 999.1.1.1 203.0.113.20 >/dev/null 2>&1' _ "$here/shield/lib.sh"
exempt="$(render_nginx_exempt "$house" "$peer")"
check "nginx exemption lists house and peer" bash -c 'grep -q "$1 1;" <<<"$3" && grep -q "$2 1;" <<<"$3"' _ "$house" "$peer" "$exempt"

# The sign-in scenario, played against nginx access-log lines
cat >"$scratch/play.py" <<'PY'
import re, sys, yaml

# Plays the scenario's filter: `a == 'x'`, `a in ['x', 'y']`, joined by `&&`, against the meta
# CrowdSec's nginx parser gives (log_type, http_verb, http_path, http_status).
scenario = yaml.safe_load(open(sys.argv[1]))
assert scenario["type"] == "leaky" and scenario["name"] == "ruchoir/auth-bf"
verb, path, status = sys.argv[2:5]
meta = {"log_type": "http_access-log", "http_verb": verb, "http_path": path, "http_status": status}
ok = True
for clause in scenario["filter"].split("&&"):
    clause = clause.strip()
    m = re.fullmatch(r"evt\.Meta\.(\w+) == '([^']*)'", clause)
    if m:
        ok = ok and meta[m.group(1)] == m.group(2)
        continue
    m = re.fullmatch(r"evt\.Meta\.(\w+) in \[(.*)\]", clause)
    if m:
        values = re.findall(r"'([^']*)'", m.group(2))
        ok = ok and meta[m.group(1)] in values
        continue
    raise SystemExit("unsupported clause: " + clause)
print("match" if ok else "no match")
PY
scenario="$here/shield/crowdsec/scenarios/ruchoir-auth-bf.yaml"
played() { # played LOGLINE -> match | no match
  local meta verb path status
  meta="$(log_line_meta "$1")" || { echo "no match"; return 0; }
  read -r verb path status <<<"$meta"
  python3 -I "$scratch/play.py" "$scenario" "$verb" "$path" "$status"
}
failed_login='203.0.113.50 - - [02/Nov/2026:10:00:00 +0000] "POST /api/v1/auth/login HTTP/2.0" 401 61 "-" "Mozilla/5.0"'
ok_login='203.0.113.50 - - [02/Nov/2026:10:00:01 +0000] "POST /api/v1/auth/login HTTP/2.0" 200 412 "-" "Mozilla/5.0"'
throttled='203.0.113.50 - - [02/Nov/2026:10:00:02 +0000] "POST /api/v1/auth/login HTTP/2.0" 429 40 "-" "Mozilla/5.0"'
bad_totp='203.0.113.50 - - [02/Nov/2026:10:00:03 +0000] "POST /api/v1/auth/mfa/totp/verify HTTP/2.0" 401 61 "-" "Mozilla/5.0"'
session_probe='203.0.113.50 - - [02/Nov/2026:10:00:04 +0000] "GET /api/v1/auth/session HTTP/2.0" 401 30 "-" "Mozilla/5.0"'
other_401='203.0.113.50 - - [02/Nov/2026:10:00:05 +0000] "POST /api/v1/spaces HTTP/2.0" 401 30 "-" "Mozilla/5.0"'
check "scenario parses as a leaky bucket" python3 -I -c '
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])); assert d["groupby"] and d["capacity"] and d["leakspeed"]
' "$scenario"
check "scenario matches a failed sign-in (401)" test "$(played "$failed_login")" = match
check "scenario matches a failed second factor" test "$(played "$bad_totp")" = match
check "scenario ignores a successful sign-in" test "$(played "$ok_login")" = "no match"
check "scenario ignores an already throttled one (429)" test "$(played "$throttled")" = "no match"
check "scenario ignores the session probe (GET 401)" test "$(played "$session_probe")" = "no match"
check "scenario ignores a 401 elsewhere" test "$(played "$other_401")" = "no match"

# The SSH login alert's source matching
export -f is_known_source
check "login alert: the house is known" is_known_source "$house" "$house" "$peer"
check "login alert: the peer server is known" is_known_source "$peer" "$house" "$peer"
check "login alert: an empty source (local) is known" is_known_source "" "$house" "$peer"
check "login alert: another address is unknown" bash -c '! is_known_source 192.0.2.99 "$1" "$2"' _ "$house" "$peer"

# The login alert never blocks: runs with a broken environment and still exits 0
check "login alert exits 0 with nothing configured" bash -c 'PAM_TYPE=open_session PAM_USER=x PAM_RHOST=192.0.2.1 bash "$1"' _ "$here/shield/pam/ruchoir-login-alert"
check "login alert exits 0 on a close_session" bash -c 'PAM_TYPE=close_session bash "$1"' _ "$here/shield/pam/ruchoir-login-alert"

# AIDE scripts, with a stub aide that exits with the code in $scratch/aide.code
mkdir -p "$scratch/bin" "$scratch/state" "$scratch/reports" "$scratch/db"
cat >"$scratch/bin/aide" <<EOF
#!/usr/bin/env bash
case "\$*" in
  *--check*) printf 'Total number of entries: 10\nChanged entries: 1\n\nf > ... : /etc/passwd\n'; exit \$(cat "$scratch/aide.code") ;;
  *--update*) touch "$scratch/db/ruchoir.db.new"; exit \$(cat "$scratch/aide.code") ;;
esac
EOF
cat >"$scratch/bin/notify" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$scratch/notified"
EOF
chmod +x "$scratch/bin/aide" "$scratch/bin/notify"
aide_env=(AIDE_BIN="$scratch/bin/aide" AIDE_CONF=/dev/null REPORT_DIR="$scratch/reports" STATE_DIR="$scratch/state" NOTIFY="$scratch/bin/notify")
run_check() { env "${aide_env[@]}" bash "$here/shield/aide/ruchoir-aide-check"; }
echo 0 >"$scratch/aide.code"
run_check
check "aide check: no change is ok" grep -q '^ok ' "$scratch/state/aide.status"
check "aide check: no change sends nothing" test ! -e "$scratch/notified"
echo 4 >"$scratch/aide.code"
run_check
check "aide check: a change is fail" grep -q '^fail ' "$scratch/state/aide.status"
check "aide check: a change alerts once" test "$(grep -c "^alert" "$scratch/notified")" = 1
run_check
check "aide check: the same change does not alert twice" test "$(grep -c "^alert" "$scratch/notified")" = 1
echo 18 >"$scratch/aide.code"
run_check
check "aide check: AIDE failing to run is unknown" grep -q '^unknown ' "$scratch/state/aide.status"
touch "$scratch/db/ruchoir.db"
echo 4 >"$scratch/aide.code"
env AIDE_BIN="$scratch/bin/aide" AIDE_CONF=/dev/null STATE_DIR="$scratch/state" DB_DIR="$scratch/db" bash "$here/shield/aide/ruchoir-aide-accept" --quiet
check "aide accept: moves the new database in place" test ! -e "$scratch/db/ruchoir.db.new"
check "aide accept: status is ok again" grep -q '^ok ' "$scratch/state/aide.status"
check "aide accept: clears the alert memory" test ! -e "$scratch/state/aide.alerted"

# Probes: exactly one line, ok|fail|unknown, exit 0
for probe in crowdsec aide; do
  out="$(STATE_DIR="$scratch/state" bash "$here/shield/checks.d/$probe.sh")"
  check "probe $probe prints one line of the contract" bash -c '[ "$(wc -l <<<"$1")" = 1 ] && grep -Eq "^(ok|fail|unknown) " <<<"$1"' _ "$out"
  dry="$(CHECK_DRY_RUN=1 STATE_DIR="$scratch/state" bash "$here/shield/checks.d/$probe.sh")"
  check "probe $probe dry run prints one ok line" bash -c '[ "$(wc -l <<<"$1")" = 1 ] && grep -q "^ok " <<<"$1"' _ "$dry"
done
out="$(STATE_DIR="$scratch/empty" bash "$here/shield/checks.d/aide.sh")"
check "probe aide: no status file is unknown" grep -q '^unknown ' <<<"$out"
printf 'fail files changed\n' >"$scratch/state/aide.status"
out="$(STATE_DIR="$scratch/state" bash "$here/shield/checks.d/aide.sh")"
check "probe aide: relays a fail" grep -q '^fail ' <<<"$out"
touch -d '3 days ago' "$scratch/state/aide.status"
out="$(STATE_DIR="$scratch/state" bash "$here/shield/checks.d/aide.sh")"
check "probe aide: a stale status is unknown" grep -q '^unknown ' <<<"$out"

# nginx -t on a scratch config that includes the shipped files
if command -v docker >/dev/null 2>&1 && docker image inspect nginx:stable >/dev/null 2>&1; then
  conf="$scratch/nginx"
  mkdir -p "$conf/conf.d" "$conf/snippets"
  cp "$here/shield/nginx/00-hardening.conf" "$here/shield/nginx/default-server.conf" "$conf/conf.d/"
  cp "$here/shield/nginx/proxy-common.conf" "$conf/snippets/ruchoir-proxy.conf"
  render_nginx_exempt "$house" "$peer" >"$conf/ruchoir-exempt.conf"
  cat >"$conf/nginx.conf" <<'CONF'
events {}
http {
    include /etc/nginx/ruchoir-test/conf.d/*.conf;
    server {
        listen 8080;
        server_name example.test;
        location / {
            proxy_pass http://127.0.0.1:9;
            proxy_http_version 1.1;
            include /etc/nginx/ruchoir-test/snippets/ruchoir-proxy.conf;
        }
    }
}
CONF
  # The shipped file includes /etc/nginx/ruchoir-exempt.conf, so mount it there as well.
  nginx_out="$(docker run --rm -v "$conf/nginx.conf:/etc/nginx/nginx.conf:ro" \
    -v "$conf:/etc/nginx/ruchoir-test:ro" -v "$conf/ruchoir-exempt.conf:/etc/nginx/ruchoir-exempt.conf:ro" \
    nginx:stable nginx -t 2>&1 || true)"
  check "nginx -t accepts the shipped files" grep -q 'test is successful' <<<"$nginx_out"
else
  echo "  skip nginx -t (docker or the nginx:stable image is not available)"
fi

if [ "$fails" -ne 0 ]; then
  echo "shield: $fails failed" >&2
  exit 1
fi
