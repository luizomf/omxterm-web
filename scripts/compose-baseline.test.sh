#!/usr/bin/env bash

# Regression guard for the portable, safe-by-default Compose baseline (issue #96).
#
# The tracked compose.yml must stay portable: a fresh clone with only a local
# .env resolves without a pre-created external network or a fixed container
# address, and it publishes ONLY to loopback so the broker is never exposed on
# every interface by accident. The maintainer's app-scoped production rollout
# layers compose.prod.yml on top to reach the broker over a shared, stably-named
# Docker network at the address allowlisted by the host SSH firewall. This
# asserts that neither the portable path nor the production path silently drifts.
#
# Everything runs through `docker compose config` only: it resolves and validates
# the descriptor without building images or starting containers, so it is safe to
# run anywhere and never touches a real deployment.
#
# Skips (does not fail) when the docker CLI is unavailable, so the gate stays
# green in docker-less environments.
#
# Run: bash scripts/compose-baseline.test.sh

set -uo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
ASSERT="${REPO_ROOT}/scripts/assert-compose-baseline.mjs"

pass=0
fail=0

fail_test() {
  echo "  FAIL: $1"
  fail=$((fail + 1))
}

pass_test() {
  echo "  ok: $1"
  pass=$((pass + 1))
}

if ! command -v docker >/dev/null 2>&1; then
  echo "compose-baseline.test.sh: docker not found, skipping"
  exit 0
fi

# Resolve configs in a throwaway project dir with .env copied straight from
# .env.example — the exact starting point a fresh clone runs with (README's
# `cp .env.example .env`). In particular .env.example ships
# OMXTERM_SERVER_HOST=127.0.0.1 (the right default for local `npm run dev`),
# so resolving against it, rather than an empty file, is what actually catches
# that value leaking into the container and shadowing the Dockerfile's
# OMXTERM_SERVER_HOST=0.0.0.0 bind.
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cp "${REPO_ROOT}/compose.yml" "${WORK}/compose.yml"
cp "${REPO_ROOT}/compose.prod.yml" "${WORK}/compose.prod.yml"
cp "${REPO_ROOT}/.env.example" "${WORK}/.env"

# Resolve the merged config for the given -f list, then assert the named contract
# against it. Reports the compose error verbatim if resolution itself fails.
check_config() {
  local label="$1" mode="$2"
  shift 2
  local config_json
  if ! config_json="$(docker compose "$@" config --format json 2>"${WORK}/err")"; then
    fail_test "docker compose config failed for ${label}:"
    cat "${WORK}/err"
    return
  fi
  if printf '%s' "${config_json}" | node "${ASSERT}" "${mode}"; then
    pass_test "${label}"
  else
    fail=$((fail + 1))
  fi
}

echo "portable baseline (compose.yml alone)"
check_config \
  "fresh-clone config resolves against .env.example; publishes only to loopback; pins the container to OMXTERM_SERVER_HOST=0.0.0.0 despite .env.example's 127.0.0.1; restart unless-stopped; no external network, pinned address, or global container_name" \
  baseline \
  -f "${WORK}/compose.yml"

echo "production override (compose.yml + compose.prod.yml)"
check_config \
  "override merges, joins the external shared network at 10.210.0.10, and restores the production restart: always policy" \
  prod \
  -f "${WORK}/compose.yml" -f "${WORK}/compose.prod.yml"

echo
if [ "${fail}" -eq 0 ]; then
  echo "compose-baseline.test.sh: ${pass} passed, 0 failed"
else
  echo "compose-baseline.test.sh: ${pass} passed, ${fail} failed"
fi
[ "${fail}" -eq 0 ]
