#!/usr/bin/env bash
#
# Helpers for checks written in bash. Sourced, never run. Installed as
# /usr/local/lib/ruchoir-hardening/check-lib.sh. The contract is in the header of ruchoir-watch:
# one line "ok|fail|unknown MESSAGE" on stdout, exit 0.
#
# A check sources this, then calls exactly one of check_ok, check_fail or check_unknown, each of
# which prints its line and ends the script with status 0. If the script dies before that (an
# unset variable, a failed command), the exit trap prints "unknown" instead of silence.

# shellcheck source=../common/lib.sh
. "${RUCHOIR_HARDENING_LIB:-/usr/local/lib/ruchoir-hardening/lib.sh}"
# shellcheck source=lib.sh
. "${WATCH_LIB:-/usr/local/lib/ruchoir-hardening/watch-lib.sh}"

CHECK_EMITTED=0

_check_finish() {
  CHECK_EMITTED=1
  exit 0
}

_check_oneline() {
  printf '%s' "$*" | tr '\n\r' '  ' | cut -c 1-300
}

check_ok() {
  printf 'ok %s\n' "$(_check_oneline "$@")"
  _check_finish
}

check_fail() {
  printf 'fail %s\n' "$(_check_oneline "$@")"
  _check_finish
}

check_unknown() {
  printf 'unknown %s\n' "$(_check_oneline "$@")"
  _check_finish
}

_check_exit() {
  if [ "$CHECK_EMITTED" != 1 ]; then
    printf 'unknown the check ended without a result\n'
  fi
  exit 0
}
trap _check_exit EXIT
