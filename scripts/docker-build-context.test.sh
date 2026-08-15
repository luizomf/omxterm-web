#!/usr/bin/env bash

# Regression guard for Docker build-context hygiene (issues #143 and #176).
#
# The probe mirrors the runtime image's broad `COPY . .` in a disposable
# scratch image. It adds harmless synthetic sentinels only inside a temporary
# copy of the checkout, then proves Docker excludes runtime logs and local
# secret-bearing artifacts while retaining safe examples and required build
# inputs.
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
EXCLUDED_SECRET_ARTIFACTS=(
  ".env"
  ".env.local"
  "apps/server/.env"
  "apps/web/.env.production"
  ".claude/sentinel.txt"
  "apps/server/.claude/sentinel.txt"
  ".hermes/sentinel.txt"
  "apps/web/nested/.hermes/sentinel.txt"
  ".ssh/sentinel.txt"
  "packages/core/fixtures/.ssh/sentinel.txt"
  "id_rsa"
  "examples/nested/id_rsa"
  "id_dsa"
  "apps/server/fixtures/id_dsa"
  "id_ecdsa"
  "apps/web/fixtures/id_ecdsa"
  "id_ed25519"
  "packages/core/fixtures/id_ed25519"
  "synthetic.pem"
  "examples/nested/synthetic.pem"
  "synthetic.key"
  "apps/server/fixtures/synthetic.key"
  "synthetic.ppk"
  "apps/web/fixtures/synthetic.ppk"
  "synthetic.p12"
  "packages/core/fixtures/synthetic.p12"
  "synthetic.pfx"
  "examples/nested/synthetic.pfx"
  "synthetic.jks"
  "apps/server/fixtures/synthetic.jks"
  "synthetic.keystore"
  "apps/web/fixtures/synthetic.keystore"
)

EXCLUDED_RUNTIME_LOGS=(
  "logs/audit.jsonl"
  "apps/server/logs/audit.jsonl"
  "apps/server/Logs/runtime.txt"
  "runtime-audit.jsonl"
  "runtime-uppercase.JSONL"
  "runtime-events.ndjson"
  "runtime-uppercase.NDJSON"
  "apps/server/runtime.log"
  "apps/server/runtime.LOG"
  "runtime.log.1"
  "runtime.log.1.gz"
  "runtime.log-20260715.gz"
  "runtime.jsonl.1"
  "runtime.JSONL-20260715.GZ"
  "runtime.ndjson.1.gz"
  "runtime.NDJSON-20260715.GZ"
  "apps/server/runtime.LOG.1.GZ"
)

RETAINED_SYNTHETIC_ARTIFACTS=(
  "examples/nested/.env.example"
  "examples/public/synthetic.crt"
  "examples/public/synthetic.cer"
  "examples/public/id_ed25519.pub"
)

for artifact in \
  "${EXCLUDED_SECRET_ARTIFACTS[@]}" \
  "${EXCLUDED_RUNTIME_LOGS[@]}" \
  "${RETAINED_SYNTHETIC_ARTIFACTS[@]}"; do
  mkdir -p "$(dirname "${CONTEXT}/${artifact}")"
  printf '%s\n' 'harmless-build-context-sentinel' >"${CONTEXT}/${artifact}"
done

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
    echo "  FAIL: excluded artifact entered the image: ${path}"
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
    echo "  FAIL: retained artifact is missing: ${path}"
    fail=$((fail + 1))
  fi
}

for artifact in "${EXCLUDED_SECRET_ARTIFACTS[@]}" "${EXCLUDED_RUNTIME_LOGS[@]}"; do
  assert_absent "context/${artifact}"
done
for artifact in "${RETAINED_SYNTHETIC_ARTIFACTS[@]}"; do
  assert_present "context/${artifact}"
done

assert_present context/package.json
assert_present context/package-lock.json
assert_present context/apps/server/package.json
assert_present context/apps/web/package.json
assert_present context/packages/core/package.json
assert_present context/apps/server/src/main.ts
assert_present context/apps/server/src/server.ts
assert_present context/apps/web/index.html
assert_present context/apps/web/src/main.tsx
assert_present context/apps/web/public/favicon.svg
assert_present context/apps/web/public/fonts/JetBrainsMonoNerdFontMono-Regular.woff2
assert_present context/packages/core/src/protocol.ts
assert_present context/tsconfig.base.json
assert_present context/apps/server/tsconfig.json
assert_present context/apps/web/tsconfig.json
assert_present context/apps/web/vite.config.ts
assert_present context/packages/core/tsconfig.json
assert_present context/.env.example

if [ "${fail}" -ne 0 ]; then
  echo "docker-build-context.test.sh: ${fail} failed"
  exit 1
fi

echo "docker-build-context.test.sh: local secrets and runtime logs excluded; safe examples and build inputs retained"
