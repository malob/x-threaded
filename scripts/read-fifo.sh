#!/usr/bin/env bash
# Print one FIFO's contents, but stop waiting after the requested number of
# seconds. Uses only stock macOS/POSIX tools; in particular, not GNU `timeout`.
set -u

file="${1:?usage: read-fifo.sh FILE [SECONDS]}"
seconds="${2:-15}"
reader_pid=""
watchdog_pid=""

# shellcheck disable=SC2329 # Invoked by the EXIT trap below.
cleanup() {
  if [[ -n "$watchdog_pid" ]]; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n "$reader_pid" ]]; then
    kill "$reader_pid" 2>/dev/null || true
    wait "$reader_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 130' HUP INT TERM

cat "$file" &
reader_pid=$!

# The watchdog owns a separate sleep process. Its EXIT trap reaps that process
# when the reader finishes early and the parent stops the watchdog.
(
  sleep_pid=""
  # shellcheck disable=SC2329 # Invoked by the subshell's EXIT trap below.
  cleanup_watchdog() {
    if [[ -n "$sleep_pid" ]]; then
      kill "$sleep_pid" 2>/dev/null || true
      wait "$sleep_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_watchdog EXIT
  trap 'exit 0' HUP INT TERM

  sleep "$seconds" &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
  sleep_pid=""
  kill "$reader_pid" 2>/dev/null || true
) &
watchdog_pid=$!

status=0
wait "$reader_pid" || status=$?
reader_pid=""

kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
watchdog_pid=""

exit "$status"
