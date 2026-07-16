#!/usr/bin/env bash

# Regression guard for Docker build-context hygiene (issue #143).
#
# The probe mirrors the runtime image's broad `COPY . .` in a disposable
# scratch image. It adds synthetic log sentinels only inside a temporary copy
# of the checkout, then proves Docker excludes them while retaining the source,
# manifests, web assets, and documented environment example needed to build.
#
# Run: bash scripts/docker-build-context.test.sh

set -euo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker-build-context.test.sh: docker not found, skipping"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker-build-context.test.sh: docker daemon unreachable, skipping"
  exit 0
fi

WORK="$(mktemp -d)"
CONTEXT="${WORK}/context"
PROBE_DOCKERFILE="${WORK}/Dockerfile.context-probe"
ARCHIVE="${WORK}/context.tar"
IMAGE="omxterm-context-probe:$(basename "${WORK}" | tr '[:upper:]' '[:lower:]' | tr -dc 'a-z0-9')"
CONTAINER_ID=""

cleanup() {
  if [ -n "${CONTAINER_ID}" ]; then
    docker rm --force "${CONTAINER_ID}" >/dev/null 2>&1 || true
  fi
  docker image rm --force "${IMAGE}" >/dev/null 2>&1 || true
  # mktemp must remain the only source of this recursively removed path.
  case "${WORK}" in
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
      rm -rf "${WORK}"
      ;;
    *)
      echo "  WARN: refusing to remove unexpected temp path ${WORK}" >&2
      ;;
  esac
}
trap cleanup EXIT

mkdir -p "${CONTEXT}"
git -C "${REPO_ROOT}" ls-files --cached --others --exclude-standard -z |
  tar --null -C "${REPO_ROOT}" -T - -cf - | tar -C "${CONTEXT}" -xf -

# These markers are deliberately harmless and never touch the real checkout.
mkdir -p "${CONTEXT}/logs" "${CONTEXT}/apps/server/logs"
printf '%s\n' 'synthetic-root-audit-sentinel' >"${CONTEXT}/logs/audit.jsonl"
printf '%s\n' 'synthetic-nested-audit-sentinel' >"${CONTEXT}/apps/server/logs/audit.jsonl"
printf '%s\n' 'synthetic-jsonl-sentinel' >"${CONTEXT}/runtime-audit.jsonl"
printf '%s\n' 'synthetic-log-sentinel' >"${CONTEXT}/apps/server/runtime.log"

cat >"${PROBE_DOCKERFILE}" <<'DOCKERFILE'
FROM scratch
COPY . /context
DOCKERFILE

echo "building disposable broad-COPY context probe"
if ! docker build --quiet --file "${PROBE_DOCKERFILE}" --tag "${IMAGE}" "${CONTEXT}" >/dev/null; then
  echo "  FAIL: Docker could not build the context probe"
  exit 1
fi

CONTAINER_ID="$(docker create "${IMAGE}" /context-probe)"
docker export --output "${ARCHIVE}" "${CONTAINER_ID}"

fail=0

assert_absent() {
  local path="$1"
  if tar -tf "${ARCHIVE}" "${path}" >/dev/null 2>&1; then
    echo "  FAIL: excluded runtime artifact entered the image: ${path}"
    fail=$((fail + 1))
  else
    echo "  ok: excluded ${path}"
  fi
}

assert_present() {
  local path="$1"
  if tar -tf "${ARCHIVE}" "${path}" >/dev/null 2>&1; then
    echo "  ok: retained ${path}"
  else
    echo "  FAIL: build-required file is missing: ${path}"
    fail=$((fail + 1))
  fi
}

assert_absent context/logs/audit.jsonl
assert_absent context/apps/server/logs/audit.jsonl
assert_absent context/runtime-audit.jsonl
assert_absent context/apps/server/runtime.log

assert_present context/package.json
assert_present context/package-lock.json
assert_present context/apps/server/package.json
assert_present context/apps/server/src/server.ts
assert_present context/apps/web/public/favicon.svg
assert_present context/apps/web/public/fonts/JetBrainsMonoNerdFontMono-Regular.woff2
assert_present context/.env.example

if [ "${fail}" -ne 0 ]; then
  echo "docker-build-context.test.sh: ${fail} failed"
  exit 1
fi

echo "docker-build-context.test.sh: runtime logs excluded; build inputs retained"
