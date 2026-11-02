#!/usr/bin/env bash
#
# Check "restore-test" of ruchoir-watch (role app): the monthly restore test has succeeded within the
# last 35 days. Until the first success, it stays quiet for 35 days after the install (the first run
# is done by hand, and the timer's first date may be weeks away).
# Prints one line "ok|fail|unknown MESSAGE" (see the header of ruchoir-watch). Installed by
# restore-test/install.sh as a link in /etc/ruchoir-watch/checks.d/. RESTORE_TEST_STATE_DIR points
# elsewhere, for tests.
set -euo pipefail

# shellcheck source=../../watch/check-lib.sh
. "${WATCH_CHECK_LIB:-/usr/local/lib/ruchoir-hardening/check-lib.sh}"
# shellcheck source=../lib.sh
. "${RESTORE_TEST_LIB:-/usr/local/lib/ruchoir-hardening/restore-test/lib.sh}"

state_dir="${RESTORE_TEST_STATE_DIR:-/var/lib/ruchoir-hardening}"
verdict="$(last_ok_state "$state_dir/restore-test.last-ok" "$state_dir/restore-test.installed" "$(watch_now)" 35)" \
  || check_unknown "the restore test state could not be read"
case "$verdict" in
  ok\ *) check_ok "${verdict#ok }" ;;
  fail\ *) check_fail "${verdict#fail }" ;;
  *) check_unknown "unexpected verdict: $verdict" ;;
esac
