#!/usr/bin/env bash
#
# Check "containers" of ruchoir-watch: no container is unhealthy or restarting, and none restarted
# more than 3 times in the last 10 minutes (restart counts are sampled every run, in
# $WATCH_STATE_DIR/containers.restarts). WATCH_DOCKER names the docker command, for tests.
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# watch/install.sh as a link in /etc/ruchoir-watch/checks.d/.
set -euo pipefail

# shellcheck source=../check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"

docker="${WATCH_DOCKER:-docker}"
state_dir="${WATCH_STATE_DIR:-/var/lib/ruchoir-hardening/watch}"
command -v "$docker" >/dev/null 2>&1 || check_unknown "docker is not available"
listing="$("$docker" ps -a --format '{{.Names}}|{{.Status}}|{{.ID}}' 2>/dev/null)" \
  || check_unknown "docker did not answer"

problems=()
ids=()
while IFS='|' read -r name status id; do
  [ -n "$name" ] || continue
  ids+=("$id")
  case "$status" in
    *"(unhealthy)"*) problems+=("$name is unhealthy") ;;
    Restarting*) problems+=("$name is restarting") ;;
  esac
done <<<"$listing"

if [ "${#ids[@]}" -gt 0 ]; then
  counts="$("$docker" inspect --format '{{.Name}} {{.RestartCount}}' "${ids[@]}" 2>/dev/null | sed 's|^/||')" \
    || check_unknown "docker inspect failed"
  mkdir -p "$state_dir"
  while read -r name; do
    if [ -n "$name" ]; then problems+=("$name restarted more than 3 times in 10 minutes"); fi
  done < <(printf '%s\n' "$counts" | restart_burst "$state_dir/containers.restarts")
fi

if [ "${#problems[@]}" -gt 0 ]; then
  check_fail "${problems[*]}"
fi
check_ok "${#ids[@]} containers, none unhealthy or restarting"
