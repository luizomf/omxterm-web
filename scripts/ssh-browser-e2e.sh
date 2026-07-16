#!/usr/bin/env bash

# Disposable browser -> OMXTerm -> OpenSSH E2E for issue #159. This is opt-in:
# it builds three local images and installs Chromium on the first Playwright run.

set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || {
  echo "ssh-browser-e2e.sh: could not resolve the script directory" >&2
  exit 1
}
REPO_ROOT="$(realpath "${SCRIPT_DIRECTORY}/.." 2>/dev/null)" || {
  echo "ssh-browser-e2e.sh: could not resolve the repository root" >&2
  exit 1
}
if [ -z "${REPO_ROOT}" ] \
  || [ ! "${REPO_ROOT}/scripts/ssh-browser-e2e.sh" -ef "${BASH_SOURCE[0]}" ] \
  || [ ! -f "${REPO_ROOT}/package.json" ] \
  || [ ! -f "${REPO_ROOT}/tests/e2e/compose.yml" ]; then
  echo "ssh-browser-e2e.sh: resolved repository root is invalid" >&2
  exit 1
fi

TEMP_ROOT="$(realpath "${TMPDIR:-/tmp}" 2>/dev/null)" || {
  echo "ssh-browser-e2e.sh: could not resolve the OS temp directory" >&2
  exit 1
}
if [ -z "${TEMP_ROOT}" ] || [ "${TEMP_ROOT}" = '/' ] || [ ! -d "${TEMP_ROOT}" ]; then
  echo "ssh-browser-e2e.sh: resolved OS temp directory is invalid" >&2
  exit 1
fi

WORK_CANDIDATE="$(mktemp -d "${TEMP_ROOT}/omxterm-e2e.XXXXXXXXXX")" || {
  echo "ssh-browser-e2e.sh: could not create the temporary work directory" >&2
  exit 1
}
WORK="$(realpath "${WORK_CANDIDATE}" 2>/dev/null)" || {
  rmdir "${WORK_CANDIDATE}" >/dev/null 2>&1 || true
  echo "ssh-browser-e2e.sh: could not resolve the temporary work directory" >&2
  exit 1
}
case "${WORK}" in
  "${TEMP_ROOT}"/omxterm-e2e.*) ;;
  *)
    echo "ssh-browser-e2e.sh: temporary work directory is outside the OS temp directory" >&2
    exit 1
    ;;
esac

RUN_ID="$(basename "${WORK}" | tr '[:upper:]' '[:lower:]' | tr -dc 'a-z0-9' | tail -c 10)"
if [ -z "${RUN_ID}" ]; then
  rmdir "${WORK}" >/dev/null 2>&1 || true
  echo "ssh-browser-e2e.sh: could not derive a safe run id" >&2
  exit 1
fi
PROJECT="omxterm-e2e-${RUN_ID}"
COMPOSE_FILE="${REPO_ROOT}/tests/e2e/compose.yml"
COMPOSE=(docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}")
RUN_BOUNDED=(bash "${REPO_ROOT}/scripts/run-bounded-command.sh")
COMPOSE_STARTED=0
E2E_TIMEOUT_SECONDS="${OMXTERM_E2E_TIMEOUT_SECONDS:-600}"
TEARDOWN_TIMEOUT_SECONDS=60
RUN_DEADLINE=0
OUTPUT_SCAN_COMPLETED=0
OMXTERM_E2E_PRIVATE_KEY_MARKER=''
# shellcheck source=scripts/ssh-browser-e2e-lib.sh
source "${REPO_ROOT}/scripts/ssh-browser-e2e-lib.sh"

# Traps are installed before credentials are generated or any container starts.
cleanup() {
  local status=$?
  local cleanup_failed=0
  local docker_resources_remain=0
  local resource_ids=''
  local query_status=0
  trap - EXIT INT TERM HUP USR1
  CLEANUP_DEADLINE=$((SECONDS + TEARDOWN_TIMEOUT_SECONDS))

  if [ "${COMPOSE_STARTED}" -eq 1 ]; then
    run_during_cleanup "${COMPOSE[@]}" down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || cleanup_failed=1
  fi

  local scan_status=0
  if [ "${OUTPUT_SCAN_COMPLETED}" -eq 0 ]; then
    scan_captured_output
    scan_status=$?
  fi
  if [ "${scan_status}" -eq 1 ]; then
    echo "ssh-browser-e2e.sh: secret material detected in captured output; diagnostics withheld" >&2
    cleanup_failed=1
  elif [ "${scan_status}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: captured output could not be verified; diagnostics withheld" >&2
    cleanup_failed=1
  elif [ "${status}" -ne 0 ]; then
    for log_file in "${WORK}"/*.log; do
      [ -f "${log_file}" ] || continue
      # Playwright diagnostics can include input DOM values even when traces,
      # screenshots, and videos are disabled. Never replay that log to stdout;
      # the test location and generic failure above remain safe diagnostics.
      [ "$(basename "${log_file}")" = 'playwright.log' ] && continue
      echo "ssh-browser-e2e.sh: tail of $(basename "${log_file}")" >&2
      tail -n 30 "${log_file}" >&2
    done
  fi

  case "${WORK}" in
    "${TEMP_ROOT}"/omxterm-e2e.*)
      rm -rf "${WORK}" || cleanup_failed=1
      ;;
    *)
      echo "ssh-browser-e2e.sh: refusing to remove unexpected temp directory" >&2
      cleanup_failed=1
      ;;
  esac

  resource_ids="$(run_during_cleanup docker ps --all --quiet --filter "label=com.docker.compose.project=${PROJECT}")"
  query_status=$?
  if [ "${query_status}" -ne 0 ] || [ -n "${resource_ids}" ]; then docker_resources_remain=1; fi
  resource_ids="$(run_during_cleanup docker network ls --quiet --filter "label=com.docker.compose.project=${PROJECT}")"
  query_status=$?
  if [ "${query_status}" -ne 0 ] || [ -n "${resource_ids}" ]; then docker_resources_remain=1; fi
  resource_ids="$(run_during_cleanup docker volume ls --quiet --filter "label=com.docker.compose.project=${PROJECT}")"
  query_status=$?
  if [ "${query_status}" -ne 0 ] || [ -n "${resource_ids}" ]; then docker_resources_remain=1; fi

  if [ "${docker_resources_remain}" -ne 0 ] || [ -e "${WORK}" ]; then
    echo "ssh-browser-e2e.sh: cleanup verification failed" >&2
    cleanup_failed=1
  else
    echo "ssh-browser-e2e.sh: cleanup verified (containers, networks, volumes, temp files)"
  fi

  if [ "${cleanup_failed}" -ne 0 ]; then status=1; fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 124' USR1

if ! command -v docker >/dev/null 2>&1 \
  || ! docker info >/dev/null 2>&1 \
  || ! docker compose version >/dev/null 2>&1; then
  echo "ssh-browser-e2e.sh: Docker with Compose is required" >&2
  exit 1
fi
for executable in node npm openssl ssh-keygen; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    echo "ssh-browser-e2e.sh: required executable not found: ${executable}" >&2
    exit 1
  fi
done

if ! [[ "${E2E_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ssh-browser-e2e.sh: OMXTERM_E2E_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi
if ! chmod 0700 "${WORK}"; then
  echo "ssh-browser-e2e.sh: could not restrict temporary work directory permissions" >&2
  exit 1
fi
WORK_MODE="$(stat -f '%Lp' "${WORK}" 2>/dev/null || stat -c '%a' "${WORK}" 2>/dev/null)"
if ! [[ "${WORK_MODE}" =~ ^0?700$ ]]; then
  echo "ssh-browser-e2e.sh: temporary work directory permissions are not 0700" >&2
  exit 1
fi

export OMXTERM_E2E_CLIENT_PRIVATE_KEY="${WORK}/client_key"
export OMXTERM_E2E_CLIENT_PUBLIC_KEY="${WORK}/client_key.pub"
export OMXTERM_E2E_HOST_PRIVATE_KEY="${WORK}/host_key"
export OMXTERM_E2E_PLAYWRIGHT_OUTPUT="${WORK}/playwright-output"
for credential_path in \
  "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}" \
  "${OMXTERM_E2E_CLIENT_PUBLIC_KEY}" \
  "${OMXTERM_E2E_HOST_PRIVATE_KEY}" \
  "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}"; do
  case "${credential_path}" in
    "${WORK}"/*) ;;
    *)
      echo "ssh-browser-e2e.sh: refusing credential path outside the temporary work directory" >&2
      exit 1
      ;;
  esac
done

export OMXTERM_E2E_ACCESS_TOKEN
OMXTERM_E2E_ACCESS_TOKEN="$(openssl rand -hex 32)" || {
  echo "ssh-browser-e2e.sh: access-token generation failed" >&2
  exit 1
}
if [ -z "${OMXTERM_E2E_ACCESS_TOKEN}" ]; then
  echo "ssh-browser-e2e.sh: access-token generation returned an empty value" >&2
  exit 1
fi

if ! ssh-keygen -q -t ed25519 -N '' -C "omxterm-e2e-client-${RUN_ID}" -f "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}"; then
  echo "ssh-browser-e2e.sh: SSH client-key generation failed" >&2
  exit 1
fi
if ! ssh-keygen -q -t ed25519 -N '' -C "omxterm-e2e-host-${RUN_ID}" -f "${OMXTERM_E2E_HOST_PRIVATE_KEY}"; then
  echo "ssh-browser-e2e.sh: SSH host-key generation failed" >&2
  exit 1
fi
if ! chmod 0600 "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}" "${OMXTERM_E2E_HOST_PRIVATE_KEY}" \
  || ! chmod 0644 "${OMXTERM_E2E_CLIENT_PUBLIC_KEY}" "${OMXTERM_E2E_HOST_PRIVATE_KEY}.pub"; then
  echo "ssh-browser-e2e.sh: generated SSH key permissions could not be restricted" >&2
  exit 1
fi
OMXTERM_E2E_PRIVATE_KEY_MARKER="$(awk 'NR == 2 { print substr($0, 1, 16); found = 1; exit } END { if (!found) exit 1 }' "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}")" || {
  echo "ssh-browser-e2e.sh: private-key scan marker preparation failed" >&2
  exit 1
}
if [ -z "${OMXTERM_E2E_PRIVATE_KEY_MARKER}" ]; then
  echo "ssh-browser-e2e.sh: private-key scan marker is empty" >&2
  exit 1
fi
export OMXTERM_E2E_PRIVATE_KEY_MARKER

export OMXTERM_E2E_HOST_FINGERPRINT
OMXTERM_E2E_HOST_FINGERPRINT="$(ssh-keygen -l -E sha256 -f "${OMXTERM_E2E_HOST_PRIVATE_KEY}.pub" | awk '{print $2}')" || {
  echo "ssh-browser-e2e.sh: SSH host fingerprint calculation failed" >&2
  exit 1
}
if [[ "${OMXTERM_E2E_HOST_FINGERPRINT}" != SHA256:* ]]; then
  echo "ssh-browser-e2e.sh: SSH host fingerprint calculation returned an invalid value" >&2
  exit 1
fi

# A run-specific /24 avoids collisions between concurrent harnesses. Compose
# fails closed if the daemon already owns an overlapping range.
OCTET="$(node --input-type=module -e '
  import { createHash } from "node:crypto";
  const firstByte = createHash("sha256").update(process.argv[1]).digest()[0];
  console.log((firstByte % 200) + 20);
' "${RUN_ID}")" || {
  echo "ssh-browser-e2e.sh: isolated subnet preparation failed" >&2
  exit 1
}
if ! [[ "${OCTET}" =~ ^[0-9]+$ ]] || [ "${OCTET}" -lt 20 ] || [ "${OCTET}" -gt 219 ]; then
  echo "ssh-browser-e2e.sh: isolated subnet preparation returned an invalid octet" >&2
  exit 1
fi
export OMXTERM_E2E_SUBNET="10.231.${OCTET}.0/24"
export OMXTERM_E2E_BROKER_ADDRESS="10.231.${OCTET}.10"
export OMXTERM_E2E_SSH_ADDRESS="10.231.${OCTET}.20"

export OMXTERM_E2E_BROWSER_PORT
OMXTERM_E2E_BROWSER_PORT="$(node --input-type=module -e '
  import net from "node:net";
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address) console.log(address.port);
    server.close();
  });
')" || {
  echo "ssh-browser-e2e.sh: loopback browser port preparation failed" >&2
  exit 1
}
if ! [[ "${OMXTERM_E2E_BROWSER_PORT}" =~ ^[0-9]+$ ]] \
  || [ "${OMXTERM_E2E_BROWSER_PORT}" -lt 1 ] \
  || [ "${OMXTERM_E2E_BROWSER_PORT}" -gt 65535 ]; then
  echo "ssh-browser-e2e.sh: loopback browser port preparation returned an invalid value" >&2
  exit 1
fi
export OMXTERM_E2E_ORIGIN="http://127.0.0.1:${OMXTERM_E2E_BROWSER_PORT}"

echo "ssh-browser-e2e.sh: building isolated OpenSSH fixture and OMXTerm"
COMPOSE_STARTED=1
RUN_DEADLINE=$((SECONDS + E2E_TIMEOUT_SECONDS))
run_before_deadline "${COMPOSE[@]}" up --detach --build --wait >"${WORK}/compose-up.log" 2>&1
status=$?
if [ "${status}" -ne 0 ]; then
  startup_status="${status}"
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
    exit 124
  fi
  capture_compose_logs "${WORK}/compose.log"
  log_status=$?
  if [ "${log_status}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: startup diagnostics are unavailable" >&2
  fi
  echo "ssh-browser-e2e.sh: Compose startup failed (diagnostics withheld until secret scan)" >&2
  exit "${startup_status}"
fi
verify_runtime_isolation
status=$?
if [ "${status}" -ne 0 ]; then
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
  fi
  exit "${status}"
fi

if [ "${OMXTERM_E2E_FORCE_FAILURE:-}" = "after-start" ]; then
  echo "ssh-browser-e2e.sh: forced failure requested after startup" >&2
  exit 97
fi
if [ "${OMXTERM_E2E_PAUSE_AFTER_START:-}" = "true" ]; then
  echo "ssh-browser-e2e.sh: interruption checkpoint reached"
  run_before_deadline bash -c 'while :; do sleep 10; done'
  status=$?
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
  fi
  exit "${status}"
fi

echo "ssh-browser-e2e.sh: ensuring the pinned Playwright Chromium is installed"
run_before_deadline npx playwright install chromium >"${WORK}/playwright-install.log" 2>&1
status=$?
if [ "${status}" -ne 0 ]; then
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
    exit 124
  fi
  echo "ssh-browser-e2e.sh: Chromium installation failed" >&2
  exit 1
fi

echo "ssh-browser-e2e.sh: running real browser, fingerprint, PTY, and bar assertions"
run_before_deadline npx playwright test --config tests/e2e/playwright.config.ts >"${WORK}/playwright.log" 2>&1
status=$?
if [ "${status}" -ne 0 ]; then
  browser_status="${status}"
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
    exit 124
  fi
  capture_compose_logs "${WORK}/compose.log"
  log_status=$?
  if [ "${log_status}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: browser failure diagnostics are unavailable" >&2
  fi
  echo "ssh-browser-e2e.sh: browser E2E failed (diagnostics withheld until secret scan)" >&2
  exit "${browser_status}"
fi
capture_compose_logs "${WORK}/compose.log"
status=$?
if [ "${status}" -ne 0 ]; then
  exit "${status}"
fi

verify_captured_output_and_report_success
status=$?
if [ "${status}" -ne 0 ]; then exit "${status}"; fi
