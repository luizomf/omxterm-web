#!/usr/bin/env bash

# Opt-in integration check for the portable Compose baseline (issue #108).
#
# The descriptor guard (compose-baseline.test.sh) only validates the *resolved*
# config; it cannot catch a baseline that resolves fine but fails to build,
# start, or serve. This script proves the documented fresh-clone path end to
# end: build the image, start the broker, hit /health, tear everything down.
#
# It is deliberately NOT part of `npm run test:scripts` — building the image
# takes minutes and needs a Docker daemon. Run it explicitly:
#
#     npm run test:compose:integration
#
# Isolation guarantees (never touches a real deployment on the same host):
#   - Fresh-clone copy: tracked + untracked-unignored files into a temp dir, so
#     the local .env, node_modules, or a live checkout state never leak in.
#   - Unique Compose project name, so containers/networks/images are scoped to
#     this run and cannot collide with any existing OMXTerm project.
#   - A test-harness port override (`ports: !override 127.0.0.1:0:3000`) asks
#     the kernel for a free ephemeral loopback port, so a broker already
#     listening on 3000 (dev server or real deploy) is never disturbed.
#   - Trap-based teardown removes containers, networks, volumes, and the image
#     built for this run (`down --rmi local`), plus the temp dir.
#
# Skips (does not fail) when the docker CLI or daemon is unavailable, so it is
# CI-safe to invoke unconditionally.
#
# Run: bash scripts/compose-baseline.integration.test.sh

set -uo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
HEALTH_TIMEOUT_SECONDS="${OMXTERM_IT_HEALTH_TIMEOUT:-90}"

if ! command -v docker >/dev/null 2>&1; then
  echo "compose-baseline.integration.test.sh: docker not found, skipping"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "compose-baseline.integration.test.sh: docker daemon unreachable, skipping"
  exit 0
fi

WORK="$(mktemp -d)"
PROJECT="omxterm-it-$(basename "${WORK}" | tr 'A-Z' 'a-z' | tr -dc 'a-z0-9' | tail -c 8)"
COMPOSE=(docker compose -p "${PROJECT}" -f "${WORK}/compose.yml" -f "${WORK}/compose.override.yml")

cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans --rmi local >/dev/null 2>&1
  rm -rf "${WORK}"
}
trap cleanup EXIT

echo "fresh-clone copy -> ${WORK} (project ${PROJECT})"
# Tracked + untracked-unignored files are exactly what a fresh clone plus the
# work in progress would contain; .env and node_modules stay behind.
git -C "${REPO_ROOT}" ls-files --cached --others --exclude-standard -z |
  tar --null -C "${REPO_ROOT}" -T - -cf - | tar -C "${WORK}" -xf -

# Start from .env.example, then apply the two values docs/deploy.md step 2
# requires for the Docker path (Compose env_file: last occurrence wins):
#   - OMXTERM_ACCESS_TOKEN: the shipped `change-me` is refused at boot as a
#     known weak value, so generate a throwaway strong token.
#   - OMXTERM_SECURE_COOKIES=true: the image binds 0.0.0.0, and the broker
#     refuses to boot with insecure cookies on a non-loopback bind.
TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')"
cp "${WORK}/.env.example" "${WORK}/.env"
printf '\nOMXTERM_ACCESS_TOKEN=%s\nOMXTERM_SECURE_COOKIES=true\n' "${TOKEN}" >> "${WORK}/.env"

# Test-harness override only: publish on an ephemeral loopback port so this run
# never competes with a broker already on 127.0.0.1:3000. `!override` replaces
# the baseline's port list instead of merging with it.
cat > "${WORK}/compose.override.yml" <<'YAML'
services:
  omxterm:
    ports: !override
      - "127.0.0.1:0:3000"
YAML

echo "build + start"
if ! "${COMPOSE[@]}" up -d --build >"${WORK}/up.log" 2>&1; then
  echo "  FAIL: docker compose up failed:"
  tail -n 40 "${WORK}/up.log"
  exit 1
fi

# `docker compose port` prints e.g. 127.0.0.1:49154 for the ephemeral mapping.
ADDRESS="$("${COMPOSE[@]}" port omxterm 3000)"
if [ -z "${ADDRESS}" ]; then
  echo "  FAIL: no published port for omxterm:3000"
  "${COMPOSE[@]}" ps
  exit 1
fi
echo "broker published on ${ADDRESS}"

echo "waiting for /health (up to ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until body="$(node -e '
  fetch(`http://${process.argv[1]}/health`)
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`status ${res.status}`))))
    .then((text) => { console.log(text); })
    .catch(() => process.exit(1));
' "${ADDRESS}")"; do
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "  FAIL: /health not reachable within ${HEALTH_TIMEOUT_SECONDS}s; broker logs:"
    "${COMPOSE[@]}" logs --tail 40 omxterm
    exit 1
  fi
  sleep 2
done

case "${body}" in
  *'"ok":true'*) echo "  ok: /health responded ${body}" ;;
  *)
    echo "  FAIL: /health responded unexpected body: ${body}"
    exit 1
    ;;
esac

echo "teardown"
if ! "${COMPOSE[@]}" down --volumes --remove-orphans --rmi local >"${WORK}/down.log" 2>&1; then
  echo "  FAIL: docker compose down failed:"
  tail -n 20 "${WORK}/down.log"
  exit 1
fi

echo "compose-baseline.integration.test.sh: build/start/health/teardown passed"
