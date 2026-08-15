#!/usr/bin/env bash

# Regression guard for the dependency audit boundary (issue #182).
#
# The runtime image runs an unpruned npm ci and starts the broker through tsx,
# which is currently classified as a development dependency. The fake npm below
# models a reportable advisory that disappears only when dev dependencies are
# omitted, then verifies that the maintainer audit command preserves npm's
# failure and that CI and README use that same command.
#
# Run: bash scripts/dependency-audit.test.sh

set -uo pipefail

REPO_ROOT="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
REAL_NPM="$(command -v npm)"
WORK="$(mktemp -d)"
FAKE_BIN="${WORK}/bin"
AUDIT_ARGUMENT_LOG="${WORK}/audit-arguments.log"
AUDIT_OUTPUT_LOG="${WORK}/audit-output.log"

cleanup() {
  case "${WORK}" in
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
      rm -rf "${WORK}"
      ;;
    *)
      echo "dependency-audit.test.sh: refusing to remove unexpected temp directory" >&2
      exit 1
      ;;
  esac
}
trap cleanup EXIT

mkdir -p "${FAKE_BIN}"
cat >"${FAKE_BIN}/npm" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >"${AUDIT_ARGUMENT_LOG}"

if [ "$#" -eq 1 ] && [ "$1" = "audit" ]; then
  echo "synthetic reportable advisory in a dev-classified runtime dependency" >&2
  exit 42
fi

if [ "$#" -eq 2 ] && [ "$1" = "audit" ] && [ "$2" = "--omit=dev" ]; then
  exit 0
fi

echo "unexpected npm arguments: $*" >&2
exit 64
EOF
chmod +x "${FAKE_BIN}/npm"

PATH="${FAKE_BIN}:${PATH}" \
  AUDIT_ARGUMENT_LOG="${AUDIT_ARGUMENT_LOG}" \
  "${REAL_NPM}" run audit:dependencies --silent >"${AUDIT_OUTPUT_LOG}" 2>&1
status=$?

if [ "${status}" -ne 42 ]; then
  echo "dependency-audit.test.sh: expected the reportable advisory status 42, got ${status}" >&2
  cat "${AUDIT_OUTPUT_LOG}" >&2
  exit 1
fi
if [ "$(cat "${AUDIT_ARGUMENT_LOG}" 2>/dev/null)" != "audit" ]; then
  echo "dependency-audit.test.sh: audit command did not cover the complete lockfile" >&2
  exit 1
fi
if ! grep -E -q '^[[:space:]]*run:[[:space:]]+npm run audit:dependencies[[:space:]]*$' "${REPO_ROOT}/.github/workflows/ci.yml"; then
  echo "dependency-audit.test.sh: CI does not use the complete-lockfile audit command" >&2
  exit 1
fi
if ! grep -F -x -q 'npm run audit:dependencies' "${REPO_ROOT}/README.md"; then
  echo "dependency-audit.test.sh: README does not document the CI audit command" >&2
  exit 1
fi

echo "dependency-audit.test.sh: dev classification cannot escape the shared lockfile audit gate"
