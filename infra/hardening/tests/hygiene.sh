#!/usr/bin/env bash
#
# Tests of infra/hardening/hygiene: daemon.json, sysctl, the sshd drop-in (checked by a real sshd in
# an ubuntu:26.04 container), the image report's version logic, the check and the installer's
# idempotency. The sshd part is skipped, loudly, when Docker is not available.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/hygiene"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fails=0
not() { ! "$@"; }
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

# daemon.json
check "daemon.json parses" python3 -m json.tool "$src/daemon.json" >/dev/null
check "daemon.json uses the local log driver" test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["log-driver"])' "$src/daemon.json")" = local
check "daemon.json turns live-restore on" test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["live-restore"])' "$src/daemon.json")" = True

# sysctl
check "sysctl keeps ip_forward on" grep -qE '^net\.ipv4\.ip_forward = 1$' "$src/sysctl.d/60-ruchoir.conf"
check "sysctl uses a loose rp_filter" grep -qE '^net\.ipv4\.conf\.all\.rp_filter = 2$' "$src/sysctl.d/60-ruchoir.conf"
check "sysctl restricts kernel pointers" grep -qE '^kernel\.kptr_restrict = 2$' "$src/sysctl.d/60-ruchoir.conf"
check "sysctl lines are all key = value" bash -c '! grep -vE "^(#|$|[a-z0-9_.]+ = [0-9]+$)" "$1"' _ "$src/sysctl.d/60-ruchoir.conf"

# sshd drop-in, parsed and evaluated by the real sshd of the target release
if docker image inspect ubuntu:26.04 >/dev/null 2>&1 || docker pull -q ubuntu:26.04 >/dev/null 2>&1; then
  sshd_out="$(docker run --rm -v "$src/sshd_config.d/50-ruchoir.conf:/drop/50-ruchoir.conf:ro" ubuntu:26.04 bash -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends openssh-server >/dev/null 2>&1
    ssh-keygen -A >/dev/null
    mkdir -p /etc/ssh/sshd_config.d /run/sshd
    cp /drop/50-ruchoir.conf /etc/ssh/sshd_config.d/
    # The distribution file includes the drop-ins first; this line after it proves a Match block in
    # a drop-in does not swallow the settings that follow the Include.
    grep -q "^Include /etc/ssh/sshd_config.d" /etc/ssh/sshd_config
    echo "MaxAuthTries 7" >> /etc/ssh/sshd_config
    sshd -t && echo "SYNTAX_OK"
    echo "ROOT: $(sshd -T -C user=root,host=h,addr=203.0.113.1 | grep -E "^(allowtcpforwarding|logingracetime|maxauthtries|clientaliveinterval|clientalivecountmax) " | tr "\n" ";")"
    echo "THEO: $(sshd -T -C user=theo,host=h,addr=203.0.113.1 | grep -E "^allowtcpforwarding " | tr "\n" ";")"
    echo "CRYPTO: $(sshd -T | grep -E "^(kexalgorithms|ciphers|macs) " | tr "\n" ";")"
  ' 2>&1)"
  check "sshd -t accepts the drop-in" grep -q SYNTAX_OK <<<"$sshd_out"
  check "sshd forbids forwarding for others" grep -q "^ROOT: .*allowtcpforwarding no" <<<"$sshd_out"
  check "sshd allows forwarding for theo" grep -q "^THEO: allowtcpforwarding yes" <<<"$sshd_out"
  check "sshd sets a 20 s login grace time" grep -q "^ROOT: .*logingracetime 20" <<<"$sshd_out"
  check "sshd keeps the settings after the Include" grep -q "^ROOT: .*maxauthtries 7" <<<"$sshd_out"
  check "sshd limits the key exchanges" grep -q "^CRYPTO: .*kexalgorithms sntrup761x25519-sha512,mlkem768x25519-sha256,curve25519-sha256" <<<"$sshd_out"
  check "sshd limits the ciphers" grep -q "ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com" <<<"$sshd_out"
  check "sshd limits the MACs" grep -q "macs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com" <<<"$sshd_out"
else
  printf '  FAIL sshd checks need Docker and the ubuntu:26.04 image\n'
  fails=$((fails + 1))
fi

# ruchoir-image-report: version logic
# shellcheck source=../hygiene/ruchoir-image-report
. "$src/ruchoir-image-report"
check "16.4 is newer than 16.3" newer_patch 16.4 16.3
check "16.3-alpine is not newer than itself" not newer_patch 16.3-alpine 16.3-alpine
check "16.10 is newer than 16.9 (numeric order)" newer_patch 16.10 16.9
check "an older patch is not newer" not newer_patch 16.2 16.3
check "another major is not a patch" not newer_patch 17.1 16.3
check "another flavour is not newer" not newer_patch 16.4 16.3-alpine
check "a flavour keeps its own line" newer_patch 16.4-alpine 16.3-alpine
check "v2.3.1 is newer than v2.3.0" newer_patch v2.3.1 v2.3.0
check "hotfix.2 is newer than hotfix.1" newer_patch v9.3.4-hotfix.2 v9.3.4-hotfix.1
check "the next patch beats a hotfix" newer_patch v9.3.5 v9.3.4-hotfix.1
check "a name with no version is not newer" not newer_patch latest 16.3
check "18-alpine is a floating tag" is_floating 18-alpine
check "v2.3.0 is not a floating tag" not is_floating v2.3.0

# reboot-pending (a check of ruchoir-watch: sources the watch check helpers)
export RUCHOIR_HARDENING_LIB="$here/common/lib.sh"
export WATCH_LIB="$here/watch/lib.sh"
export WATCH_CHECK_LIB="$here/watch/check-lib.sh"
flag="$scratch/reboot-required"
check "no flag reads ok" grep -q '^ok no reboot pending' <(REBOOT_REQUIRED_FILE="$flag" bash "$src/checks.d/reboot-pending.sh")
touch "$flag"
check "a fresh flag reads ok" grep -q '^ok reboot pending' <(REBOOT_REQUIRED_FILE="$flag" bash "$src/checks.d/reboot-pending.sh")
touch -d '40 hours ago' "$flag"
check "an old flag reads fail" grep -q '^fail ' <(REBOOT_REQUIRED_FILE="$flag" bash "$src/checks.d/reboot-pending.sh")
check "reboot-pending prints one line" test "$(REBOOT_REQUIRED_FILE="$flag" bash "$src/checks.d/reboot-pending.sh" | wc -l)" = 1

# ruchoir-reboot-notice
printf '#!/bin/sh\necho "NOTIFIED $*" >> "%s/notified"\n' "$scratch" >"$scratch/fake-notify"
chmod +x "$scratch/fake-notify"
rm -f "$flag"
NOTIFY_CMD="$scratch/fake-notify" REBOOT_REQUIRED_FILE="$flag" bash "$src/ruchoir-reboot-notice" before
check "no notice before when nothing is pending" test ! -e "$scratch/notified"
touch "$flag"
NOTIFY_CMD="$scratch/fake-notify" REBOOT_REQUIRED_FILE="$flag" bash "$src/ruchoir-reboot-notice" before
check "a notice before when a reboot is pending" grep -q 'NOTIFIED info Reboot in 5 minutes' "$scratch/notified"
NOTIFY_CMD="$scratch/fake-notify" bash "$src/ruchoir-reboot-notice" after
check "a notice after the boot" grep -q 'NOTIFIED info Server is back' "$scratch/notified"

# install.sh: into a scratch root, twice
cat >"$scratch/hardening.env" <<'EOF'
RUCHOIR_HARDENING_ROLE=app
EOF
mkdir -p "$scratch/root/etc/docker"
printf '{"registry-mirrors": ["https://mirror.example.org"]}\n' >"$scratch/root/etc/docker/daemon.json"
run_install() {
  HARDENING_PREFIX="$scratch/root" HYGIENE_SKIP_SYSTEM=1 HARDENING_ROOT="$here" \
    RUCHOIR_HARDENING_ENV="$scratch/hardening.env" bash "$src/install.sh"
}
first="$(run_install)"
second="$(run_install)"
check "install writes the sshd drop-in" test -f "$scratch/root/etc/ssh/sshd_config.d/50-ruchoir.conf"
check "install merges daemon.json and keeps the existing keys" grep -q registry-mirrors "$scratch/root/etc/docker/daemon.json"
check "install merges daemon.json and adds ours" grep -q live-restore "$scratch/root/etc/docker/daemon.json"
check "install links the check" test "$(readlink "$scratch/root/etc/ruchoir-watch/checks.d/reboot-pending.sh")" = /usr/local/lib/ruchoir-hardening/checks/reboot-pending.sh
check "install does not touch secrets-mode (the watch lot's)" test ! -e "$scratch/root/etc/ruchoir-watch/checks.d/secrets-mode.sh"
check "install adds the weekly timer" test -f "$scratch/root/etc/systemd/system/ruchoir-image-report.timer"
check "the first install installs" grep -q '^installed ' <<<"$first"
check "the second install only prints unchanged" bash -c '! grep -q "^installed " <<<"$1"' _ "$second"

if [ "$fails" -ne 0 ]; then
  echo "hygiene: $fails failed" >&2
  exit 1
fi
