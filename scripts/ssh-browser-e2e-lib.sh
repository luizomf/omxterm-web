#!/usr/bin/env bash

# Shared deadline-sensitive operations for the disposable SSH browser E2E.

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

capture_before_deadline() {
  local destination="$1"
  shift
  local captured_output
  captured_output="$(run_before_deadline "$@")"
  local status=$?
  if [ "${status}" -ne 0 ]; then return "${status}"; fi
  printf -v "${destination}" '%s' "${captured_output}"
}

capture_compose_logs() {
  local log_file="$1"
  run_before_deadline "${COMPOSE[@]}" logs --no-color >"${log_file}" 2>&1
  local status=$?
  if [ "${status}" -eq 124 ]; then
    echo "ssh-browser-e2e.sh: timed out while capturing Compose logs" >&2
  elif [ "${status}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: Compose log capture failed with status ${status}" >&2
  fi
  return "${status}"
}

scan_path_for_secret_markers() {
  local path="$1"
  local recursive="$2"
  local grep_arguments=(-F -q)
  local pattern status
  if [ "${recursive}" -eq 1 ]; then grep_arguments=(-R -F -q); fi

  for pattern in "${OMXTERM_E2E_ACCESS_TOKEN:-}" 'BEGIN OPENSSH PRIVATE KEY' "${OMXTERM_E2E_PRIVATE_KEY_MARKER:-}"; do
    [ -n "${pattern}" ] || continue
    grep "${grep_arguments[@]}" -- "${pattern}" "${path}"
    status=$?
    if [ "${status}" -eq 0 ]; then return 1; fi
    if [ "${status}" -gt 1 ]; then
      echo "ssh-browser-e2e.sh: captured-output scan failed with status ${status}" >&2
      return 2
    fi
  done
}

scan_captured_output() {
  local log_file status
  for log_file in "${WORK}"/*.log; do
    [ -f "${log_file}" ] || continue
    scan_path_for_secret_markers "${log_file}" 0
    status=$?
    if [ "${status}" -ne 0 ]; then return "${status}"; fi
  done

  if [ -d "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT:-}" ]; then
    scan_path_for_secret_markers "${OMXTERM_E2E_PLAYWRIGHT_OUTPUT}" 1
    status=$?
    if [ "${status}" -ne 0 ]; then return "${status}"; fi
  fi
}

verify_captured_output_and_report_success() {
  local status
  scan_captured_output
  status=$?
  if [ "${status}" -eq 1 ]; then
    echo "ssh-browser-e2e.sh: secret material detected in captured output" >&2
    return 1
  fi
  if [ "${status}" -ne 0 ]; then
    echo "ssh-browser-e2e.sh: captured output could not be verified" >&2
    return "${status}"
  fi

  # shellcheck disable=SC2034 # Read by the parent harness cleanup trap.
  OUTPUT_SCAN_COMPLETED=1
  echo "ssh-browser-e2e.sh: passed; scan found no full access token, OpenSSH private-key header, or sampled private-key marker"
}

verify_runtime_isolation() {
  local broker_id fixture_id gateway_id isolated_network
  local broker_networks fixture_networks gateway_networks
  local broker_ports fixture_ports gateway_user network_internal published_address

  capture_before_deadline broker_id "${COMPOSE[@]}" ps --quiet omxterm-web || return $?
  capture_before_deadline fixture_id "${COMPOSE[@]}" ps --quiet ssh-fixture || return $?
  capture_before_deadline gateway_id "${COMPOSE[@]}" ps --quiet loopback-gateway || return $?
  if [ -z "${broker_id}" ] || [ -z "${fixture_id}" ] || [ -z "${gateway_id}" ]; then
    echo "ssh-browser-e2e.sh: runtime isolation check found a missing container" >&2
    return 1
  fi

  isolated_network="${PROJECT}_isolated"
  capture_before_deadline broker_networks docker inspect --format '{{len .NetworkSettings.Networks}}' "${broker_id}" || return $?
  capture_before_deadline fixture_networks docker inspect --format '{{len .NetworkSettings.Networks}}' "${fixture_id}" || return $?
  capture_before_deadline gateway_networks docker inspect --format '{{len .NetworkSettings.Networks}}' "${gateway_id}" || return $?
  capture_before_deadline broker_ports docker inspect --format '{{json .HostConfig.PortBindings}}' "${broker_id}" || return $?
  capture_before_deadline fixture_ports docker inspect --format '{{json .HostConfig.PortBindings}}' "${fixture_id}" || return $?
  capture_before_deadline gateway_user docker inspect --format '{{.Config.User}}' "${gateway_id}" || return $?
  capture_before_deadline network_internal docker network inspect --format '{{.Internal}}' "${isolated_network}" || return $?

  if [ "${broker_networks}" != '1' ] \
    || [ "${fixture_networks}" != '1' ] \
    || [ "${gateway_networks}" != '2' ] \
    || [ "${broker_ports}" != '{}' ] \
    || [ "${fixture_ports}" != '{}' ] \
    || [ "${gateway_user}" != 'nobody' ] \
    || [ "${network_internal}" != 'true' ]; then
    echo "ssh-browser-e2e.sh: runtime network isolation contract failed" >&2
    return 1
  fi

  capture_before_deadline published_address "${COMPOSE[@]}" port loopback-gateway 3000 || return $?
  if [ "${published_address}" != "127.0.0.1:${OMXTERM_E2E_BROWSER_PORT}" ]; then
    echo "ssh-browser-e2e.sh: browser gateway is not bound to the selected loopback port" >&2
    return 1
  fi
}
