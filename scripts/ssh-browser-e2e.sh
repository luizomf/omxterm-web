#!/usr/bin/env bash

# Disposable browser -> OMXTerm -> OpenSSH E2E for issue #159. This is opt-in:
# it builds three local images and installs Chromium on the first Playwright run.

set -uo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
WORK="$(mktemp -d)"
RUN_ID="$(basename "${WORK}" | tr '[:upper:]' '[:lower:]' | tr -dc 'a-z0-9' | tail -c 10)"
PROJECT="omxterm-e2e-${RUN_ID}"
COMPOSE_FILE="${REPO_ROOT}/tests/e2e/compose.yml"
COMPOSE=(docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}")
RUN_BOUNDED=(bash "${REPO_ROOT}/scripts/run-bounded-command.sh")
COMPOSE_STARTED=0
E2E_TIMEOUT_SECONDS="${OMXTERM_E2E_TIMEOUT_SECONDS:-600}"
TEARDOWN_TIMEOUT_SECONDS=60
RUN_DEADLINE=0

run_before_deadline() {
  local remaining=$((RUN_DEADLINE - SECONDS))
  if [ "${remaining}" -lt 1 ]; then return 124; fi
  "${RUN_BOUNDED[@]}" "${remaining}" "$@"
}

run_during_cleanup() {
  local remaining=$((CLEANUP_DEADLINE - SECONDS))
  if [ "${remaining}" -lt 1 ]; then return 124; fi
  "${RUN_BOUNDED[@]}" "${remaining}" "$@"
}

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

  local private_key_marker=''
  if [ -n "${OMXTERM_E2E_CLIENT_PRIVATE_KEY:-}" ] && [ -f "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}" ]; then
    private_key_marker="$(sed -n '2p' "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}" | cut -c 1-16)"
  fi
  local secret_leak=0
  for log_file in "${WORK}"/*.log; do
    [ -f "${log_file}" ] || continue
    if { [ -n "${OMXTERM_E2E_ACCESS_TOKEN:-}" ] && grep -F -q "${OMXTERM_E2E_ACCESS_TOKEN}" "${log_file}"; } \
      || grep -F -q -- 'BEGIN OPENSSH PRIVATE KEY' "${log_file}" \
      || { [ -n "${private_key_marker}" ] && grep -F -q "${private_key_marker}" "${log_file}"; }; then
      secret_leak=1
    fi
  done
  if [ -d "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT:-}" ]; then
    if { [ -n "${OMXTERM_E2E_ACCESS_TOKEN:-}" ] && grep -R -F -q "${OMXTERM_E2E_ACCESS_TOKEN}" "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}"; } \
      || grep -R -F -q -- 'BEGIN OPENSSH PRIVATE KEY' "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}" \
      || { [ -n "${private_key_marker}" ] && grep -R -F -q "${private_key_marker}" "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}"; }; then
      secret_leak=1
    fi
  fi
  if [ "${secret_leak}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: secret material detected in captured output; diagnostics withheld" >&2
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
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
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

verify_runtime_isolation() {
  local broker_id fixture_id gateway_id isolated_network
  broker_id="$("${COMPOSE[@]}" ps --quiet omxterm)"
  fixture_id="$("${COMPOSE[@]}" ps --quiet ssh-fixture)"
  gateway_id="$("${COMPOSE[@]}" ps --quiet loopback-gateway)"
  isolated_network="${PROJECT}_isolated"

  if [ "$(docker inspect --format '{{len .NetworkSettings.Networks}}' "${broker_id}")" != '1' ] \
    || [ "$(docker inspect --format '{{len .NetworkSettings.Networks}}' "${fixture_id}")" != '1' ] \
    || [ "$(docker inspect --format '{{len .NetworkSettings.Networks}}' "${gateway_id}")" != '2' ] \
    || [ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${broker_id}")" != '{}' ] \
    || [ "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${fixture_id}")" != '{}' ] \
    || [ "$(docker inspect --format '{{.Config.User}}' "${gateway_id}")" != 'nobody' ] \
    || [ "$(docker network inspect --format '{{.Internal}}' "${isolated_network}")" != 'true' ]; then
    echo "ssh-browser-e2e.sh: runtime network isolation contract failed" >&2
    return 1
  fi

  local published_address
  published_address="$("${COMPOSE[@]}" port loopback-gateway 3000)"
  if [ "${published_address}" != "127.0.0.1:${OMXTERM_E2E_BROWSER_PORT}" ]; then
    echo "ssh-browser-e2e.sh: browser gateway is not bound to the selected loopback port" >&2
    return 1
  fi
}

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "ssh-browser-e2e.sh: Docker with Compose is required" >&2
  exit 1
fi
for executable in node npm openssl shasum ssh-keygen; do
  if ! command -v "${executable}" >/dev/null 2>&1; then
    echo "ssh-browser-e2e.sh: required executable not found: ${executable}" >&2
    exit 1
  fi
done

if ! [[ "${E2E_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ssh-browser-e2e.sh: OMXTERM_E2E_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi
RUN_DEADLINE=$((SECONDS + E2E_TIMEOUT_SECONDS))

chmod 0700 "${WORK}"
export OMXTERM_E2E_CLIENT_PRIVATE_KEY="${WORK}/client_key"
export OMXTERM_E2E_CLIENT_PUBLIC_KEY="${WORK}/client_key.pub"
export OMXTERM_E2E_HOST_PRIVATE_KEY="${WORK}/host_key"
export OMXTERM_E2E_PLAYWRIGHT_OUTPUT="${WORK}/playwright-output"
export OMXTERM_E2E_ACCESS_TOKEN
OMXTERM_E2E_ACCESS_TOKEN="$(openssl rand -hex 32)"

ssh-keygen -q -t ed25519 -N '' -C "omxterm-e2e-client-${RUN_ID}" -f "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}"
ssh-keygen -q -t ed25519 -N '' -C "omxterm-e2e-host-${RUN_ID}" -f "${OMXTERM_E2E_HOST_PRIVATE_KEY}"
chmod 0600 "${OMXTERM_E2E_CLIENT_PRIVATE_KEY}" "${OMXTERM_E2E_HOST_PRIVATE_KEY}"
chmod 0644 "${OMXTERM_E2E_CLIENT_PUBLIC_KEY}" "${OMXTERM_E2E_HOST_PRIVATE_KEY}.pub"

export OMXTERM_E2E_HOST_FINGERPRINT
OMXTERM_E2E_HOST_FINGERPRINT="$(ssh-keygen -l -E sha256 -f "${OMXTERM_E2E_HOST_PRIVATE_KEY}.pub" | awk '{print $2}')"

# A run-specific /24 avoids collisions between concurrent harnesses. Compose
# fails closed if the daemon already owns an overlapping range.
OCTET=$((16#$(printf '%s' "${RUN_ID}" | shasum -a 256 | cut -c 1-2) % 200 + 20))
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
')"
export OMXTERM_E2E_ORIGIN="http://127.0.0.1:${OMXTERM_E2E_BROWSER_PORT}"

echo "ssh-browser-e2e.sh: building isolated OpenSSH fixture and OMXTerm"
COMPOSE_STARTED=1
run_before_deadline "${COMPOSE[@]}" up --detach --build --wait >"${WORK}/compose-up.log" 2>&1
status=$?
if [ "${status}" -ne 0 ]; then
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
    exit 124
  fi
  run_before_deadline "${COMPOSE[@]}" logs --no-color >"${WORK}/compose.log" 2>&1 || true
  echo "ssh-browser-e2e.sh: Compose startup failed (diagnostics withheld until secret scan)" >&2
  exit 1
fi
verify_runtime_isolation || exit 1

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
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
    exit 124
  fi
  run_before_deadline "${COMPOSE[@]}" logs --no-color >"${WORK}/compose.log" 2>&1 || true
  echo "ssh-browser-e2e.sh: browser E2E failed (diagnostics withheld until secret scan)" >&2
  exit 1
fi
run_before_deadline "${COMPOSE[@]}" logs --no-color >"${WORK}/compose.log" 2>&1
status=$?
if [ "${status}" -eq 124 ]; then
  echo "ssh-browser-e2e.sh: timed out after ${E2E_TIMEOUT_SECONDS}s" >&2
  exit 124
fi

echo "ssh-browser-e2e.sh: passed; captured output contains no access token or private-key material"
