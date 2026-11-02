#!/usr/bin/env bash
#
# Tests of infra/hardening/shield: the jail and ignoreip rendering, the fail2ban filters played with
# fail2ban-regex in a ubuntu:26.04 container, the Spamhaus DROP parser and its ruleset (nft -c), the
# login alert's source matching, the AIDE scripts (with a stub aide), the probes' output contract,
# and (when Docker is available) nginx -t on a scratch config that includes the files.
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

# Rendering from the env values
ignoreip="$(render_ignoreip "$house" "$peer")"
check "ignoreip names the house" grep -qw "$house" <<<"$ignoreip"
check "ignoreip names the peer server" grep -qw "$peer" <<<"$ignoreip"
check "ignoreip names the loopback ranges" grep -q '127.0.0.0/8 ::1' <<<"$ignoreip"
check "ignoreip refuses an address that is not one" bash -c '. "$1"; ! render_ignoreip "198.51.100.7; rm" 203.0.113.20 >/dev/null 2>&1' _ "$here/shield/lib.sh"
check "ignoreip refuses 999.1.1.1" bash -c '. "$1"; ! render_ignoreip 999.1.1.1 203.0.113.20 >/dev/null 2>&1' _ "$here/shield/lib.sh"
jail_template="$here/shield/fail2ban/jail.d/ruchoir.local"
render_jail "$jail_template" "$house" "$peer" >"$scratch/ruchoir.local"
check "jail: the ignoreip placeholder is replaced" bash -c '! grep -q @IGNOREIP@ "$1" && grep -q "^ignoreip = 127.0.0.0/8 ::1 $2 $3$" "$1"' _ "$scratch/ruchoir.local" "$house" "$peer"
check "jail: bans through nftables-multiport" grep -q '^banaction = nftables-multiport$' "$scratch/ruchoir.local"
check "jail: bans are incremental" grep -q '^bantime.increment = true$' "$scratch/ruchoir.local"
check "jail: the four jails are enabled" bash -c 'for j in sshd ruchoir-auth nginx-limit-req nginx-botsearch; do grep -q "^\[$j\]" "$1" || exit 1; done; [ "$(grep -c "^enabled = true" "$1")" = 4 ]' _ "$scratch/ruchoir.local"
check "jail: ruchoir-auth bans 10 failures in 5 minutes for 1 hour" bash -c 'sed -n "/^\[ruchoir-auth\]/,/^\[nginx-limit-req\]/p" "$1" | grep -q "^maxretry = 10$" && sed -n "/^\[ruchoir-auth\]/,/^\[nginx-limit-req\]/p" "$1" | grep -q "^findtime = 5m$" && sed -n "/^\[ruchoir-auth\]/,/^\[nginx-limit-req\]/p" "$1" | grep -q "^bantime = 1h$"' _ "$scratch/ruchoir.local"
exempt="$(render_nginx_exempt "$house" "$peer")"
check "nginx exemption lists house and peer" bash -c 'grep -q "$1 1;" <<<"$3" && grep -q "$2 1;" <<<"$3"' _ "$house" "$peer" "$exempt"

# fail2ban: the filters and the whole configuration, inside a throwaway ubuntu:26.04 container with
# fail2ban installed from the Ubuntu archive (the image is cached as ruchoir-f2b-test).
f2b_image=ruchoir-f2b-test
f2b_ready=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker image inspect "$f2b_image" >/dev/null 2>&1; then
    f2b_ready=1
  else
    echo "  building $f2b_image (ubuntu:26.04 with fail2ban and nftables, once)"
    if printf 'FROM ubuntu:26.04\nRUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends fail2ban nftables jq python3 ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t "$f2b_image" - >/dev/null 2>&1; then
      f2b_ready=1
    fi
  fi
fi
if [ "$f2b_ready" = 1 ]; then
  f2b="$scratch/f2b"
  mkdir -p "$f2b"
  cat >"$f2b/auth-yes.log" <<'LOG'
203.0.113.50 - - [02/Nov/2026:10:00:00 +0000] "POST /api/v1/auth/login HTTP/2.0" 401 61 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:03 +0000] "POST /api/v1/auth/mfa/totp/verify HTTP/2.0" 401 61 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:04 +0000] "POST /api/v1/auth/mfa/recovery/verify HTTP/2.0" 401 61 "-" "Mozilla/5.0"
LOG
  cat >"$f2b/auth-no.log" <<'LOG'
203.0.113.50 - - [02/Nov/2026:10:00:01 +0000] "POST /api/v1/auth/login HTTP/2.0" 200 412 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:02 +0000] "POST /api/v1/auth/login HTTP/2.0" 429 40 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:05 +0000] "GET /api/v1/auth/session HTTP/2.0" 401 30 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:06 +0000] "POST /api/v1/spaces HTTP/2.0" 401 30 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:07 +0000] "GET /e/studio/c/general HTTP/2.0" 200 5120 "-" "Mozilla/5.0"
LOG
  cat >"$f2b/limit-yes.log" <<'LOG'
2026/11/02 10:00:00 [warn] 811#811: *45 limiting requests, excess: 200.500 by zone "ruchoir_all", client: 203.0.113.50, server: app.example.test, request: "GET / HTTP/2.0", host: "app.example.test"
LOG
  cat >"$f2b/limit-no.log" <<'LOG'
2026/11/02 10:00:01 [error] 811#811: *46 open() "/usr/share/nginx/html/x" failed (2: No such file or directory), client: 203.0.113.50, server: app.example.test, request: "GET /x HTTP/2.0"
LOG
  cat >"$f2b/bot-yes.log" <<'LOG'
203.0.113.50 - - [02/Nov/2026:10:00:00 +0000] "GET /wp-login.php HTTP/1.1" 404 146 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:01 +0000] "GET /phpmyadmin/index.php HTTP/1.1" 404 146 "-" "Mozilla/5.0"
LOG
  cat >"$f2b/bot-no.log" <<'LOG'
203.0.113.50 - - [02/Nov/2026:10:00:02 +0000] "GET /e/studio/c/general HTTP/2.0" 200 5120 "-" "Mozilla/5.0"
203.0.113.50 - - [02/Nov/2026:10:00:03 +0000] "GET /missing.png HTTP/2.0" 404 146 "-" "Mozilla/5.0"
LOG
  cat >"$f2b/ssh-yes.log" <<'LOG'
Nov  2 10:00:00 host sshd[100]: Failed password for root from 203.0.113.9 port 40000 ssh2
Nov  2 10:00:01 host sshd[101]: Invalid user admin from 203.0.113.9 port 40001
LOG
  cat >"$f2b/ssh-no.log" <<'LOG'
Nov  2 10:00:02 host sshd[102]: Accepted publickey for deploy from 203.0.113.9 port 40002 ssh2: ED25519 SHA256:abc
Nov  2 10:00:03 host sshd[103]: Failed password for deploy from 203.0.113.9 port 40003 ssh2
Nov  2 10:00:04 host sshd[104]: Failed password for invalid user backup-pull from 203.0.113.9 port 40004 ssh2
Nov  2 10:00:05 host sshd[105]: Connection closed by authenticating user deploy 203.0.113.9 port 40005 [preauth]
LOG
  mkdir -p "$f2b/fake-logs"
  cat >"$f2b/run.sh" <<'RUN'
#!/bin/bash
# Runs inside the container. Prints `name matched ignored` per sample, then the config test.
set -u
s=/src/shield/fail2ban
regex() { # regex NAME LOG FILTER
  fail2ban-regex "/work/$2" "$3" 2>&1 | sed -n 's/^Lines: \([0-9]*\) lines, \([0-9]*\) ignored, \([0-9]*\) matched.*/\1 \2 \3/p' | { read -r lines ignored matched; echo "$1 ${matched:-?} ${ignored:-?}"; }
}
cp "$s/filter.d/ruchoir-auth.conf" /etc/fail2ban/filter.d/
regex ssh-baseline ssh-no.log sshd
cp "$s/filter.d/sshd.local" /etc/fail2ban/filter.d/
regex auth-yes auth-yes.log /etc/fail2ban/filter.d/ruchoir-auth.conf
regex auth-no auth-no.log /etc/fail2ban/filter.d/ruchoir-auth.conf
regex limit-yes limit-yes.log /etc/fail2ban/filter.d/nginx-limit-req.conf
regex limit-no limit-no.log /etc/fail2ban/filter.d/nginx-limit-req.conf
regex bot-yes bot-yes.log /etc/fail2ban/filter.d/nginx-botsearch.conf
regex bot-no bot-no.log /etc/fail2ban/filter.d/nginx-botsearch.conf
regex ssh-yes ssh-yes.log sshd
regex ssh-no ssh-no.log sshd
mkdir -p /var/log/nginx
touch /var/log/nginx/access.log /var/log/nginx/error.log
cp /work/ruchoir.local /etc/fail2ban/jail.d/ruchoir.local
if fail2ban-client -t >/work/config-test.out 2>&1; then echo "config ok"; else echo "config FAILED"; cat /work/config-test.out; fi
if ls /etc/fail2ban/action.d/nftables-multiport.conf >/dev/null 2>&1; then echo "action present"; fi
RUN
  cp "$scratch/ruchoir.local" "$f2b/ruchoir.local"
  chmod -R a+rX "$f2b"
  f2b_out="$(docker run --rm -v "$f2b:/work" -v "$here:/src:ro" "$f2b_image" bash /work/run.sh 2>&1 || true)"
  f2b_count() { awk -v n="$1" -v col="$2" '$1 == n { print $col }' <<<"$f2b_out"; }
  check "fail2ban ruchoir-auth matches 3 failed sign-in attempts (login, totp, recovery)" test "$(f2b_count auth-yes 2)" = 3
  check "fail2ban ruchoir-auth ignores 200, 429, GET 401, other 401 and a normal page" test "$(f2b_count auth-no 2)" = 0
  check "fail2ban nginx-limit-req matches a limit_req rejection" test "$(f2b_count limit-yes 2)" = 1
  check "fail2ban nginx-limit-req ignores other error lines" test "$(f2b_count limit-no 2)" = 0
  check "fail2ban nginx-botsearch matches probes for wp-login.php and phpmyadmin" test "$(f2b_count bot-yes 2)" = 2
  check "fail2ban nginx-botsearch ignores a normal page and an ordinary missing file" test "$(f2b_count bot-no 2)" = 0
  check "fail2ban sshd counts a failed password and an invalid user" test "$(f2b_count ssh-yes 2)" = 2
  check "fail2ban sshd, without our override, would count those deploy and backup-pull failures" test "$(f2b_count ssh-baseline 2)" -ge 2
  check "fail2ban sshd, with our override, never counts the deploy and backup-pull accounts" test "$(f2b_count ssh-no 2)" = 0
  check "fail2ban accepts the whole configuration (fail2ban-client -t)" grep -q '^config ok$' <<<"$f2b_out"
  check "fail2ban ships the nftables-multiport action" grep -q '^action present$' <<<"$f2b_out"
  if ! grep -q '^config ok$' <<<"$f2b_out"; then printf '%s\n' "$f2b_out" | tail -20; fi
else
  echo "  skip fail2ban filter and configuration tests (docker is not available, or the $f2b_image image could not be built)"
fi

# Spamhaus DROP: the parser on fixtures, the nftables ruleset
drop="$here/shield/spamhaus/ruchoir-spamhaus-drop"
sp="$scratch/spamhaus"
mkdir -p "$sp"
printf 'HARDENING_HOUSE_IP=%s\nHARDENING_PEER_IP=%s\n' "$house" "$peer" >"$sp/hardening.env"
python3 -I - "$sp" <<'PY'
import json, sys
d = sys.argv[1]
def write(name, lines):
    open(d + "/" + name, "w").write("\n".join(lines) + "\n")
meta = json.dumps({"type": "metadata", "timestamp": 1793628842, "records": 0, "copyright": "test"})
v4 = [json.dumps({"cidr": "10.%d.0.0/16" % (i * 2), "sblid": "SBL1", "rir": "ripencc"}) for i in range(1, 121)]
v6 = [json.dumps({"cidr": "2001:db8:%x::/48" % (i * 2), "sblid": "SBL1", "rir": "ripencc"}) for i in range(1, 13)]
write("v4-good.json", v4 + [meta])
write("v6-good.json", v6 + [meta])
# entries that cover the house (198.51.100.7) and the peer (203.0.113.20)
write("v4-covering.json", v4 + [json.dumps({"cidr": "198.51.100.0/24", "sblid": "SBL2", "rir": "arin"}),
                                json.dumps({"cidr": "203.0.113.0/25", "sblid": "SBL3", "rir": "arin"}), meta])
write("v4-badentry.json", v4 + [json.dumps({"cidr": "not-a-network"}), meta])
write("v4-hostbits.json", v4 + [json.dumps({"cidr": "10.1.2.3/16"}), meta])
write("v4-wrongfamily.json", v4 + [json.dumps({"cidr": "2001:db8::/32"}), meta])
write("v4-notjson.json", v4 + ["<html>error</html>", meta])
write("v4-small.json", v4[:50] + [meta])
write("v4-empty.json", [meta])
write("v4-huge.json", ['{"cidr":"%d.%d.%d.%d/32"}' % (10, (i >> 16) & 255, (i >> 8) & 255, i & 255) for i in range(100001)])
PY
spam() { # spam V4FILE [V6FILE]: render-only run; prints stdout, exit status in $?
  RUCHOIR_HARDENING_ENV="$sp/hardening.env" python3 -I "$drop" --render-only --v4-file "$sp/$1" --v6-file "$sp/${2:-v6-good.json}" 2>&1
}
good="$(spam v4-good.json)"
check "spamhaus: valid lists render the table" grep -q '^table inet ruchoir_drop {$' <<<"$good"
check "spamhaus: both sets and the input chain are there" bash -c 'grep -q "set drop_v4" <<<"$1" && grep -q "set drop_v6" <<<"$1" && grep -q "hook input priority -100" <<<"$1" && grep -q "ip saddr @drop_v4" <<<"$1"' _ "$good"
check "spamhaus: entries of both families are loaded" bash -c 'grep -q "10.2.0.0/16" <<<"$1" && grep -q "2001:db8:2::/48" <<<"$1"' _ "$good"
check "spamhaus: the table is replaced in one transaction (create, delete, define)" bash -c '[ "$(sed -n 1,2p <<<"$1" | tr "\n" "|")" = "table inet ruchoir_drop|delete table inet ruchoir_drop|" ]' _ "$good"
covering="$(spam v4-covering.json)"
check "spamhaus: an entry covering the house is dropped and said so" grep -q "dropped 198.51.100.0/24 from the list: it covers $house" <<<"$covering"
check "spamhaus: an entry covering the peer is dropped and said so" grep -q "dropped 203.0.113.0/25 from the list: it covers $peer" <<<"$covering"
check "spamhaus: the ruleset holds neither of those networks" bash -c 'rules="$(grep -v "^dropped " <<<"$1")"; ! grep -q "198.51.100" <<<"$rules" && ! grep -q "203.0.113" <<<"$rules"' _ "$covering"
check "spamhaus: the rest of the list is kept" grep -q '10.2.0.0/16' <<<"$covering"
for bad in v4-badentry v4-hostbits v4-wrongfamily v4-notjson v4-small v4-empty v4-huge; do
  out="$(spam "$bad.json" || true)"
  check "spamhaus: $bad is refused" bash -c 'grep -q "^REFUSED: " <<<"$1" && ! grep -q "^table inet" <<<"$1"' _ "$out"
done
check "spamhaus: an IPv4 file in the IPv6 slot is refused" bash -c 'spam() { RUCHOIR_HARDENING_ENV="$1/hardening.env" python3 -I "$2" --render-only --v4-file "$1/v4-good.json" --v6-file "$1/v4-good.json" 2>&1; }; spam "$1" "$2" | grep -q "^REFUSED: "' _ "$sp" "$drop"

# The real run, with a stub nft and a stub notifier: a refused list keeps the previous set and alerts
cat >"$sp/nft" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$sp/nft.calls"
case "\$1" in list) exit 1 ;; esac
exit 0
EOF
cat >"$sp/notify" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$sp/notify.calls"
EOF
chmod +x "$sp/nft" "$sp/notify"
real() { # real V4FILE
  RUCHOIR_HARDENING_ENV="$sp/hardening.env" STATE_DIR="$sp/state" NFT_BIN="$sp/nft" NOTIFY_BIN="$sp/notify" \
    python3 -I "$drop" --v4-file "$sp/$1" --v6-file "$sp/v6-good.json" >/dev/null 2>&1
}
mkdir -p "$sp/state"
real v4-good.json
check "spamhaus: a good list is checked (nft -c) then loaded" bash -c 'grep -q "^-c -f " "$1" && grep -q "^-f " "$1"' _ "$sp/nft.calls"
check "spamhaus: a good list records the refresh stamp" grep -q '^ok 120 IPv4 and 12 IPv6' "$sp/state/spamhaus.refreshed"
check "spamhaus: a good list keeps a copy for the next boot" test -s "$sp/state/spamhaus/drop.nft"
check "spamhaus: a good list sends no alert" test ! -e "$sp/notify.calls"
rm -f "$sp/nft.calls"
real v4-small.json || true
check "spamhaus: a refused list alerts" grep -q '^alert Spamhaus DROP list not updated' "$sp/notify.calls"
check "spamhaus: a refused list leaves the live ruleset alone (only a reload of the last good one)" bash -c '! grep -q "^-c -f " "$1"' _ "$sp/nft.calls"
check "spamhaus: after a refusal with no table loaded, the last good ruleset is reloaded" grep -q "^-f $sp/state/spamhaus/drop.nft" "$sp/nft.calls"

# The ruleset really parses in nft (inside a container; nft -c needs NET_ADMIN)
if [ "$f2b_ready" = 1 ]; then
  RUCHOIR_HARDENING_ENV="$sp/hardening.env" python3 -I "$drop" --render-only --v4-file "$sp/v4-covering.json" --v6-file "$sp/v6-good.json" 2>/dev/null | grep -v '^dropped ' >"$sp/ruleset.nft"
  nft_out="$(docker run --rm --cap-add NET_ADMIN -v "$sp:/work:ro" "$f2b_image" nft -c -f /work/ruleset.nft 2>&1 && echo NFT-OK || true)"
  check "spamhaus: the rendered ruleset passes nft -c -f" grep -q '^NFT-OK$' <<<"$nft_out"
  if ! grep -q '^NFT-OK$' <<<"$nft_out"; then printf '%s\n' "$nft_out" | head -10; fi
else
  echo "  skip nft -c (docker or the $f2b_image image is not available)"
fi

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
for probe in fail2ban aide spamhaus-age; do
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

# Probe spamhaus-age: a stamp from today is ok, one from 3 days ago fails, none is unknown
mkdir -p "$scratch/age"
out="$(STATE_DIR="$scratch/age" bash "$here/shield/checks.d/spamhaus-age.sh")"
check "probe spamhaus-age: no stamp is unknown" grep -q '^unknown ' <<<"$out"
printf 'ok 1 IPv4 and 1 IPv6 networks\n' >"$scratch/age/spamhaus.refreshed"
out="$(STATE_DIR="$scratch/age" bash "$here/shield/checks.d/spamhaus-age.sh")"
check "probe spamhaus-age: a fresh stamp is ok" grep -q '^ok ' <<<"$out"
touch -d '3 days ago' "$scratch/age/spamhaus.refreshed"
out="$(STATE_DIR="$scratch/age" bash "$here/shield/checks.d/spamhaus-age.sh")"
check "probe spamhaus-age: a stamp older than 48 hours fails" grep -q '^fail ' <<<"$out"

# Probe fail2ban, with stub fail2ban-client programs
cat >"$scratch/bin/f2b-all" <<'STUB'
#!/usr/bin/env bash
printf 'Status\n|- Number of jail:\t4\n`- Jail list:\tnginx-botsearch, nginx-limit-req, ruchoir-auth, sshd\n'
STUB
cat >"$scratch/bin/f2b-missing" <<'STUB'
#!/usr/bin/env bash
printf 'Status\n|- Number of jail:\t1\n`- Jail list:\tsshd\n'
STUB
chmod +x "$scratch/bin/f2b-all" "$scratch/bin/f2b-missing"
out="$(F2B_CLIENT="$scratch/bin/f2b-all" bash "$here/shield/checks.d/fail2ban.sh")"
check "probe fail2ban: all four jails loaded is ok" grep -q '^ok ' <<<"$out"
out="$(F2B_CLIENT="$scratch/bin/f2b-missing" bash "$here/shield/checks.d/fail2ban.sh")"
check "probe fail2ban: a missing jail fails and names it" bash -c 'grep -q "^fail " <<<"$1" && grep -q ruchoir-auth <<<"$1"' _ "$out"


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
