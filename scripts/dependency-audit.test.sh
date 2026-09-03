#!/usr/bin/env bash

# Regression guard for the dependency audit boundary (issue #182).
#
# The runtime image runs the unpruned repository bootstrap and starts the broker
# through tsx, which is currently classified as a development dependency. The
# fake npm below models a reportable advisory that disappears when any omit-able
# dependency class is not explicitly included. It verifies the shared audit
# command cannot be narrowed by environment-level npm omit settings, preserves
# npm's failure, and is used by CI and README.
#
# Run: bash scripts/dependency-audit.test.sh

set -euo pipefail

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

if [ "${1:-}" != "audit" ]; then
  echo "unexpected npm arguments: $*" >&2
  exit 64
fi

for required_include in \
  "--include=dev" \
  "--include=optional" \
  "--include=peer"; do
  found=false
  for argument in "$@"; do
    if [ "${argument}" = "${required_include}" ]; then
      found=true
      break
    fi
  done
  if [ "${found}" != "true" ]; then
    # Model npm omitting the dependency class, which hides the advisory.
    exit 0
  fi
done

echo "synthetic reportable advisory in an omit-able runtime dependency" >&2
exit 42
EOF
chmod +x "${FAKE_BIN}/npm"

if PATH="${FAKE_BIN}:${PATH}" \
  AUDIT_ARGUMENT_LOG="${AUDIT_ARGUMENT_LOG}" \
  NODE_ENV=production \
  npm_config_omit=dev \
  "${REAL_NPM}" run audit:dependencies --silent >"${AUDIT_OUTPUT_LOG}" 2>&1; then
  status=0
else
  status=$?
fi

if [ "${status}" -ne 42 ]; then
  echo "dependency-audit.test.sh: expected the reportable advisory status 42, got ${status}" >&2
  cat "${AUDIT_OUTPUT_LOG}" >&2
  exit 1
fi
expected_arguments="audit --include=dev --include=optional --include=peer"
if [ "$(cat "${AUDIT_ARGUMENT_LOG}" 2>/dev/null)" != "${expected_arguments}" ]; then
  echo "dependency-audit.test.sh: audit command did not explicitly include every omit-able dependency class" >&2
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

echo "dependency-audit.test.sh: npm omit settings cannot narrow the shared lockfile audit gate"
