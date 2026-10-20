#!/usr/bin/env sh
# Stands in for the system browser during the end to end run: `xdg-open` hands it the sign-in page's
# address, which the test reads to learn the app's challenge.
printf '%s\n' "$1" >> "${E2E_OPENED_FILE:?}"
