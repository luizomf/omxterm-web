#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034 # Consumed by the sourced E2E library.
RUN_BOUNDED=(bash "${SCRIPT_DIR}/run-bounded-command.sh")
WORK="$(mktemp -d)"
FAKE_BIN="${WORK}/bin"
mkdir -p "${FAKE_BIN}"

cleanup_test() {
  case "${WORK}" in
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
      rm -rf "${WORK}"
      ;;
    *)
      echo "ssh-browser-e2e.test.sh: refusing to remove unexpected temp directory" >&2
      exit 1
      ;;
  esac
}
trap cleanup_test EXIT

cat >"${FAKE_BIN}/fake-compose" <<'EOF'
#!/usr/bin/env bash
set -u
operation="$1"
shift
if [ "${OMXTERM_E2E_TEST_HANG:-}" = "compose-${operation}" ]; then sleep 30; fi
case "${operation}" in
  ps)
    printf 'id-%s\n' "${*: -1}"
    ;;
  port)
    printf '127.0.0.1:%s\n' "${OMXTERM_E2E_BROWSER_PORT}"
    ;;
  logs)
    case "${OMXTERM_E2E_TEST_LOG_STATUS:-0}" in
      124) sleep 30 ;;
      0) echo 'captured metadata log' ;;
      *) exit "${OMXTERM_E2E_TEST_LOG_STATUS}" ;;
    esac
    ;;
  *) exit 2 ;;
esac
EOF

cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -u
if [ "$1" = 'network' ]; then
  operation='network-inspect'
  shift 2
else
  operation="$1"
  shift
fi
if [ "${OMXTERM_E2E_TEST_HANG:-}" = "docker-${operation}" ]; then sleep 30; fi
format="$2"
target="$3"
case "${format}:${target}" in
  *NetworkSettings.Networks*id-omxterm-web|*NetworkSettings.Networks*id-ssh-fixture) echo 1 ;;
  *NetworkSettings.Networks*id-loopback-gateway) echo 2 ;;
  *PortBindings*id-omxterm-web|*PortBindings*id-ssh-fixture) echo '{}' ;;
  *Config.User*id-loopback-gateway) echo nobody ;;
  *Internal*omxterm-web-e2e-test_isolated) echo true ;;
  *) exit 3 ;;
esac
EOF
chmod +x "${FAKE_BIN}/fake-compose" "${FAKE_BIN}/docker"

PATH="${FAKE_BIN}:${PATH}"
export PATH OMXTERM_E2E_BROWSER_PORT=32123
# shellcheck disable=SC2034 # Consumed by the sourced E2E library.
PROJECT='omxterm-web-e2e-test'
# shellcheck disable=SC2034 # Consumed by the sourced E2E library.
COMPOSE=("${FAKE_BIN}/fake-compose")
# shellcheck source=scripts/ssh-browser-e2e-lib.sh
source "${SCRIPT_DIR}/ssh-browser-e2e-lib.sh"

RUN_DEADLINE=$((SECONDS + 10))
verify_runtime_isolation
status=$?
if [ "${status}" -ne 0 ]; then
  echo "ssh-browser-e2e.test.sh: valid runtime isolation fixture failed with status ${status}" >&2
  exit 1
fi

for hung_operation in compose-ps docker-inspect docker-network-inspect compose-port; do
  export OMXTERM_E2E_TEST_HANG="${hung_operation}"
  RUN_DEADLINE=$((SECONDS + 1))
  started_at="${SECONDS}"
  verify_runtime_isolation >/dev/null 2>&1
  status=$?
  elapsed=$((SECONDS - started_at))
  if [ "${status}" -ne 124 ] || [ "${elapsed}" -gt 3 ]; then
    echo "ssh-browser-e2e.test.sh: ${hung_operation} was not bounded (status ${status}, ${elapsed}s)" >&2
    exit 1
  fi
done
unset OMXTERM_E2E_TEST_HANG

export OMXTERM_E2E_TEST_LOG_STATUS=23
RUN_DEADLINE=$((SECONDS + 10))
capture_compose_logs "${WORK}/ordinary-failure.log" 2>"${WORK}/ordinary-failure.err"
status=$?
if [ "${status}" -ne 23 ] || ! grep -F -q 'status 23' "${WORK}/ordinary-failure.err"; then
  echo "ssh-browser-e2e.test.sh: ordinary Compose log failure did not fail closed" >&2
  exit 1
fi

export OMXTERM_E2E_TEST_LOG_STATUS=124
# shellcheck disable=SC2034 # Consumed by the sourced E2E library.
RUN_DEADLINE=$((SECONDS + 1))
capture_compose_logs "${WORK}/timeout.log" 2>"${WORK}/timeout.err"
status=$?
if [ "${status}" -ne 124 ] || ! grep -F -q 'timed out while capturing Compose logs' "${WORK}/timeout.err"; then
  echo "ssh-browser-e2e.test.sh: Compose log timeout did not fail closed" >&2
  exit 1
fi

if grep -E -q 'capture_compose_logs .*\|\| true' "${SCRIPT_DIR}/ssh-browser-e2e.sh"; then
  echo "ssh-browser-e2e.test.sh: Compose log failure status is still discarded" >&2
  exit 1
fi

export OMXTERM_E2E_ACCESS_TOKEN='synthetic-full-token'
export OMXTERM_E2E_PRIVATE_KEY_MARKER='synthetic-marker'
export OMXTERM_E2E_PLAYWRIGHT_OUTPUT="${WORK}/playwright-output"
mkdir -p "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}"
OUTPUT_SCAN_COMPLETED=0
printf 'ordinary diagnostic\n' >"${WORK}/scan-clean.log"
verify_captured_output_and_report_success >"${WORK}/scan-clean.out"
status=$?
if [ "${status}" -ne 0 ] \
  || [ "${OUTPUT_SCAN_COMPLETED}" -ne 1 ] \
  || ! grep -F -q 'scan found no full access token, OpenSSH private-key header, or sampled private-key marker' "${WORK}/scan-clean.out"; then
  echo "ssh-browser-e2e.test.sh: clean scan did not report its narrow successful result" >&2
  exit 1
fi

printf '%s\n' "${OMXTERM_E2E_PRIVATE_KEY_MARKER}" >"${WORK}/scan-detection.log"
scan_output="$(verify_captured_output_and_report_success 2>"${WORK}/scan-detection.err")"
status=$?
if [ "${status}" -ne 1 ] \
  || grep -F -q 'ssh-browser-e2e.sh: passed' <<<"${scan_output}" \
  || ! grep -F -q 'secret material detected' "${WORK}/scan-detection.err"; then
  echo "ssh-browser-e2e.test.sh: marker detection did not fail before the positive message" >&2
  exit 1
fi
rm "${WORK}/scan-detection.log"

cat >"${FAKE_BIN}/grep" <<'EOF'
#!/usr/bin/env bash
exit 2
EOF
chmod +x "${FAKE_BIN}/grep"
hash -r
scan_output="$(verify_captured_output_and_report_success 2>"${WORK}/scan-error.err")"
status=$?
rm "${FAKE_BIN}/grep"
hash -r
if [ "${status}" -ne 2 ] \
  || /usr/bin/grep -F -q 'ssh-browser-e2e.sh: passed' <<<"${scan_output}" \
  || ! /usr/bin/grep -F -q 'captured-output scan failed with status 2' "${WORK}/scan-error.err"; then
  echo "ssh-browser-e2e.test.sh: scan operational error did not fail before the positive message" >&2
  exit 1
fi

echo "ssh-browser-e2e.test.sh: runtime calls are bounded; log and output scans fail closed"
