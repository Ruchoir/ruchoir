#!/usr/bin/env bash
#
# Helpers of ruchoir-watch and of its checks. Sourced, never run. Installed as
# /usr/local/lib/ruchoir-hardening/watch-lib.sh.
#
# The decision that matters lives here so it can be tested: watch_transition turns a stream of
# check results into alerts, one per change of state and none while nothing changes.

# Seconds an "unknown" result must last before it is worth an alert.
WATCH_UNKNOWN_GRACE="${WATCH_UNKNOWN_GRACE:-300}"

watch_now() {
  printf '%s' "${WATCH_NOW:-$(date +%s)}"
}

# watch_transition STATE_DIR CHECK RESULT
#
# RESULT is one line, "ok|fail|unknown MESSAGE" (the check contract, see ruchoir-watch). Anything
# else is read as unknown, never as ok. Per check the state is ok, fail or unknown-alerted:
#
#   ok       -> fail           alert
#   fail     -> ok             recovered
#   *        -> unknown        silent until the unknown has lasted 5 minutes, then one alert
#   unknown-alerted -> ok      recovered
#   fail     -> unknown        nothing: the failure stands, the unknown does not hide or repeat it
#
# A notification that fails to go out leaves the state alone, so the next run tries again.
# The notifier is ruchoir-notify, or $WATCH_NOTIFY (tests).
watch_transition() {
  local dir="$1" check="$2" result="$3"
  local now word msg prev first notify
  notify="${WATCH_NOTIFY:-ruchoir-notify}"
  now="$(watch_now)"
  word="${result%% *}"
  msg=""
  case "$result" in *" "*) msg="${result#* }" ;; esac
  case "$word" in
    ok | fail | unknown) ;;
    *)
      msg="the check printed an unreadable result: $result"
      word=unknown
      ;;
  esac
  mkdir -p "$dir"
  prev="$(cat "$dir/$check.state" 2>/dev/null || true)"

  case "$word" in
    ok)
      rm -f "$dir/$check.unknown"
      case "$prev" in
        fail | unknown-alerted)
          "$notify" recovered "$check recovered" "${msg:-back to normal}" || return 0
          ;;
      esac
      printf 'ok\n' >"$dir/$check.state"
      ;;
    fail)
      rm -f "$dir/$check.unknown"
      if [ "$prev" != fail ]; then
        "$notify" alert "$check failing" "${msg:-no detail}" || return 0
      fi
      printf 'fail\n' >"$dir/$check.state"
      ;;
    unknown)
      case "$prev" in fail | unknown-alerted) return 0 ;; esac
      if [ ! -s "$dir/$check.unknown" ]; then
        printf '%s\n' "$now" >"$dir/$check.unknown"
      fi
      first="$(cat "$dir/$check.unknown")"
      case "$first" in *[!0-9]* | "") first="$now" ;; esac
      if [ $((now - first)) -ge "$WATCH_UNKNOWN_GRACE" ]; then
        "$notify" alert "$check cannot be checked" "${msg:-no detail}" || return 0
        printf 'unknown-alerted\n' >"$dir/$check.state"
      fi
      ;;
  esac
}

# days_until_enddate "notAfter=Jan 11 00:00:00 2030 GMT": whole days left (negative once expired),
# from `openssl x509 -enddate`. Fails on anything else.
days_until_enddate() {
  local raw="${1#notAfter=}" end
  case "$1" in notAfter=?*) ;; *) return 1 ;; esac
  end="$(LC_ALL=C date -u -d "$raw" +%s 2>/dev/null)" || return 1
  printf '%s' $(((end - $(watch_now)) / 86400))
}

# pct_from_df: the used percentage, from `df --output=pcent PATH` on stdin.
pct_from_df() {
  local line pct=""
  while read -r line; do
    case "$line" in
      *%) pct="${line%\%}" ;;
    esac
  done
  case "$pct" in *[!0-9]* | "") return 1 ;; esac
  printf '%s' "$pct"
}

# restart_burst SAMPLES_FILE
#
# Reads "NAME RESTART_COUNT" lines on stdin (one per container, from docker). Prints the names that
# restarted more than 3 times in the last 10 minutes, one per line, and records this sample in
# SAMPLES_FILE for the next run. A container recreated meanwhile (its count went down) starts over.
restart_burst() {
  local file="$1" now cutoff name count ts sname scount tmp
  local -A current=() oldest=()
  now="$(watch_now)"
  cutoff=$((now - 600))
  while read -r name count; do
    [ -n "$name" ] || continue
    case "$count" in *[!0-9]* | "") continue ;; esac
    current["$name"]="$count"
  done
  tmp="$(mktemp)"
  if [ -r "$file" ]; then
    while read -r ts sname scount; do
      [ -n "$sname" ] || continue
      [ "$ts" -ge "$cutoff" ] 2>/dev/null || continue
      if [ -n "${current[$sname]:-}" ] && [ "$scount" -gt "${current[$sname]}" ]; then
        continue
      fi
      printf '%s %s %s\n' "$ts" "$sname" "$scount" >>"$tmp"
      if [ -z "${oldest[$sname]:-}" ]; then oldest["$sname"]="$scount"; fi
    done <"$file"
  fi
  for name in "${!current[@]}"; do
    printf '%s %s %s\n' "$now" "$name" "${current[$name]}" >>"$tmp"
    if [ -n "${oldest[$name]:-}" ] && [ $((current[$name] - oldest[$name])) -gt 3 ]; then
      printf '%s\n' "$name"
    fi
  done | sort
  mkdir -p "$(dirname "$file")"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}
