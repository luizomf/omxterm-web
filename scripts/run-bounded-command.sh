#!/usr/bin/env bash

# Run one command in its own process group so a deadline can terminate the
# command and every descendant without signaling unrelated local processes.

set -uo pipefail

TIMEOUT_SECONDS="${1:-}"
if ! [[ "${TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] || [ "$#" -lt 2 ]; then
  echo "usage: run-bounded-command.sh <positive-timeout-seconds> <command> [args...]" >&2
  exit 2
fi
shift

COMMAND_PID=''
TIMER_PID=''
TIMED_OUT=0
TERMINATION_GRACE_SECONDS=1

signal_command_group() {
  local signal="$1"
  [ -n "${COMMAND_PID}" ] || return 0
  kill "-${signal}" -- "-${COMMAND_PID}" >/dev/null 2>&1 || true
}

stop_timer() {
  [ -n "${TIMER_PID}" ] || return 0
  kill -TERM -- "-${TIMER_PID}" >/dev/null 2>&1 || true
  wait "${TIMER_PID}" >/dev/null 2>&1 || true
  TIMER_PID=''
}

# shellcheck disable=SC2329 # Invoked indirectly by the USR1 trap.
handle_timeout() {
  TIMED_OUT=1
  signal_command_group TERM
}

# shellcheck disable=SC2329 # Invoked indirectly by signal traps.
handle_interruption() {
  local status="$1"
  trap - EXIT INT TERM HUP USR1
  stop_timer
  signal_command_group TERM
  sleep "${TERMINATION_GRACE_SECONDS}"
  signal_command_group KILL
  wait "${COMMAND_PID}" >/dev/null 2>&1 || true
  exit "${status}"
}

trap handle_timeout USR1
trap 'handle_interruption 130' INT
trap 'handle_interruption 143' TERM
trap 'handle_interruption 129' HUP

# Job control assigns each asynchronous job its own process group even in a
# non-interactive Bash. The group id is the leader pid returned by `$!`.
set -m
"$@" &
COMMAND_PID=$!
(
  sleep "${TIMEOUT_SECONDS}"
  kill -USR1 "$$" >/dev/null 2>&1 || true
) &
TIMER_PID=$!
set +m

wait "${COMMAND_PID}"
status=$?

if [ "${TIMED_OUT}" -eq 1 ]; then
  deadline=$((SECONDS + TERMINATION_GRACE_SECONDS))
  while kill -0 -- "-${COMMAND_PID}" >/dev/null 2>&1 && [ "${SECONDS}" -lt "${deadline}" ]; do
    sleep 0.05
  done
  signal_command_group KILL
  wait "${COMMAND_PID}" >/dev/null 2>&1 || true
  stop_timer
  exit 124
fi

stop_timer
exit "${status}"
