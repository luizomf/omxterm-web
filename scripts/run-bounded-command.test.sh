#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_BOUNDED=(bash "${SCRIPT_DIR}/run-bounded-command.sh")
WORK="$(mktemp -d)"

cleanup() {
  case "${WORK}" in
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
      rm -rf "${WORK}"
      ;;
    *)
      echo "run-bounded-command.test.sh: refusing to remove unexpected temp directory" >&2
      exit 1
      ;;
  esac
}
trap cleanup EXIT

started_at="$(date +%s)"
(
  trap 'touch "${WORK}/cleanup-ran"' EXIT
  # shellcheck disable=SC2016 # Expanded by the synthetic child, not this test.
  "${RUN_BOUNDED[@]}" 1 bash -c '
    echo "$$" >"$1"
    trap "" TERM
    sleep 30 &
    echo "$!" >"$2"
    wait
  ' synthetic-hang "${WORK}/hung-leader.pid" "${WORK}/hung-child.pid"
)
status=$?
elapsed=$(( $(date +%s) - started_at ))

if [ "${status}" -ne 124 ]; then
  echo "run-bounded-command.test.sh: expected timeout status 124, got ${status}" >&2
  exit 1
fi
if [ "${elapsed}" -lt 1 ] || [ "${elapsed}" -gt 5 ]; then
  echo "run-bounded-command.test.sh: timeout took ${elapsed}s; expected 1-5s" >&2
  exit 1
fi
if [ ! -f "${WORK}/cleanup-ran" ]; then
  echo "run-bounded-command.test.sh: caller cleanup did not run after timeout" >&2
  exit 1
fi
for pid_file in "${WORK}/hung-leader.pid" "${WORK}/hung-child.pid"; do
  if kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
    echo "run-bounded-command.test.sh: timed-out synthetic process is still running" >&2
    exit 1
  fi
done

echo "run-bounded-command.test.sh: timeout terminated the process group in ${elapsed}s and cleanup ran"
