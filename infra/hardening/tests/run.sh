#!/usr/bin/env bash
#
# Run every hardening test file (tests/*.sh but this one). Each file exits non-zero on failure.
#
#   bash infra/hardening/tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=0
for test in "$here"/*.sh; do
  [ "$(basename "$test")" = run.sh ] && continue
  printf '== %s\n' "$(basename "$test")"
  if ! bash "$test"; then
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  echo "some hardening tests failed" >&2
  exit 1
fi
echo "all hardening tests passed"
