#!/usr/bin/env bash
#
# Check "peer-http" of ruchoir-watch: the other server's public names answer. The role decides what
# is asked of each name in HARDENING_PEER_NAMES:
#
#   this server is "site", the peer is the app server: a name starting with "office." (the editor)
#   must answer below HTTP 500; any other name must answer 200 on /api/v1/health with the database
#   and the cache reported ok.
#   this server is "app", the peer is the site server: a name starting with "registry." must answer
#   401 on /v2/ (the registry asks for credentials); any other name must answer 200 on its home page.
#
# WATCH_PEER_SCHEME (default https) and WATCH_SITE_PATH (default /) exist for tests.
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

role="${RUCHOIR_HARDENING_ROLE:-}"
if [ -z "$role" ]; then
  role="$(env_get RUCHOIR_HARDENING_ROLE)" || check_unknown "RUCHOIR_HARDENING_ROLE is not set"
fi
names="${HARDENING_PEER_NAMES_OVERRIDE:-}"
if [ -z "$names" ]; then
  names="$(env_get HARDENING_PEER_NAMES)" || check_unknown "HARDENING_PEER_NAMES is not set"
fi
scheme="${WATCH_PEER_SCHEME:-https}"
site_path="${WATCH_SITE_PATH:-/}"
command -v curl >/dev/null 2>&1 || check_unknown "curl is not available"

body="$(mktemp)"
trap 'rm -f "$body"; _check_exit' EXIT

# probe PATH: prints the HTTP status ("000" when nothing answered); the body goes to $body.
probe() {
  curl -sS -m 10 -o "$body" -w '%{http_code}' "$scheme://$name$1" 2>/dev/null || true
}

failures=()
for name in $names; do
  case "$role:$name" in
    site:office.*)
      code="$(probe /)"
      case "$code" in 000 | "" | 5??) failures+=("$name answered HTTP ${code:-none}") ;; esac
      ;;
    site:*)
      code="$(probe /api/v1/health)"
      if [ "$code" != 200 ]; then
        failures+=("$name health answered HTTP $code")
      elif ! grep -Eq '"database" *: *"ok"' "$body" || ! grep -Eq '"cache" *: *"ok"' "$body"; then
        failures+=("$name health does not report the database and the cache ok")
      fi
      ;;
    app:registry.*)
      code="$(probe /v2/)"
      [ "$code" = 401 ] || failures+=("$name /v2/ answered HTTP $code, expected 401")
      ;;
    app:*)
      code="$(probe "$site_path")"
      [ "$code" = 200 ] || failures+=("$name answered HTTP $code, expected 200")
      ;;
    *) check_unknown "unknown role: $role" ;;
  esac
done

if [ "${#failures[@]}" -gt 0 ]; then
  check_fail "${failures[*]}"
fi
check_ok "all names answer ($names)"
