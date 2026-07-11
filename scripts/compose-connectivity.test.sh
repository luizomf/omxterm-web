#!/usr/bin/env bash

# Regression guard for the reverse-proxy connectivity seam (PR #100).
#
# docs/deploy.md tells operators that a separately-running reverse proxy reaches
# the broker as `omxterm:3000` after attaching to a shared, stably-named network.
# That only holds while compose.yml keeps the broker on such a network instead of
# silently falling back to the project-default one (whose name is unstable and
# which an outside proxy is not on). This asserts the merged Compose config still
# exposes that seam, so the documented connectivity path cannot quietly become
# impossible.
#
# Skips (does not fail) when the docker CLI is unavailable, so the gate stays
# green in docker-less environments.
#
# Run: bash scripts/compose-connectivity.test.sh

set -uo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"

if ! command -v docker >/dev/null 2>&1; then
  echo "compose-connectivity.test.sh: docker not found, skipping"
  exit 0
fi

# Resolve the config in a throwaway project dir with an empty .env so the check
# never depends on a real local .env (compose.yml's `env_file: .env` must exist).
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
cp "${REPO_ROOT}/compose.yml" "${WORK}/compose.yml"
: >"${WORK}/.env"

if ! config_json="$(docker compose -f "${WORK}/compose.yml" config --format json 2>"${WORK}/err")"; then
  echo "  FAIL: docker compose config failed:"
  cat "${WORK}/err"
  echo
  echo "compose-connectivity.test.sh: 0 passed, 1 failed"
  exit 1
fi

printf '%s' "${config_json}" | node -e '
  const cfg = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const broker = cfg.services && cfg.services.omxterm;
  if (!broker) {
    console.error("  FAIL: no omxterm service in the compose config");
    process.exit(1);
  }
  const attached = Object.keys(broker.networks || {});
  if (attached.length === 0) {
    console.error("  FAIL: omxterm is on no explicit network; a separate reverse proxy could not reach omxterm:3000");
    process.exit(1);
  }
  for (const key of attached) {
    const resolvedName = ((cfg.networks || {})[key] || {}).name;
    const isStableShared =
      key !== "default" &&
      typeof resolvedName === "string" &&
      resolvedName.length > 0 &&
      !resolvedName.endsWith("_default");
    if (!isStableShared) {
      console.error(
        `  FAIL: omxterm network "${key}" has no stable shared name a proxy can attach to ` +
        `(resolved: ${resolvedName || "<project default>"})`,
      );
      process.exit(1);
    }
  }
  console.log("  ok: omxterm exposes a stably-named shared network for the reverse proxy");
'
status=$?

echo
if [ "${status}" -eq 0 ]; then
  echo "compose-connectivity.test.sh: 1 passed, 0 failed"
else
  echo "compose-connectivity.test.sh: 0 passed, 1 failed"
fi
exit "${status}"
