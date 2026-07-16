#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_SCRIPT="${SCRIPT_DIR}/ssh-browser-e2e.sh"
TEST_ROOT="$(mktemp -d)"
REAL_CHMOD="$(command -v chmod)"
REAL_MKTEMP="$(command -v mktemp)"
REAL_REALPATH="$(command -v realpath)"

cleanup_test() {
  case "${TEST_ROOT}" in
    /tmp/*|/private/tmp/*|/var/folders/*/T/*|/private/var/folders/*/T/*)
      rm -rf "${TEST_ROOT}"
      ;;
    *)
      echo "ssh-browser-e2e-preparation.test.sh: refusing to remove unexpected temp directory" >&2
      exit 1
      ;;
  esac
}
trap cleanup_test EXIT

write_common_fakes() {
  local fake_bin="$1"

  cat >"${fake_bin}/realpath" <<'EOF'
#!/usr/bin/env bash
echo realpath >>"${PREP_LOG}"
if [ "${PREP_FAILURE}" = 'realpath' ]; then exit 19; fi
exec "${REAL_REALPATH}" "$@"
EOF
  cat >"${fake_bin}/mktemp" <<'EOF'
#!/usr/bin/env bash
echo mktemp >>"${PREP_LOG}"
if [ "${PREP_FAILURE}" = 'mktemp' ]; then exit 20; fi
created="$("${REAL_MKTEMP}" "$@")" || exit $?
if [ "${PREP_FAILURE}" = 'mode-verification' ]; then "${REAL_CHMOD}" 0755 "${created}"; fi
echo "${created}" >"${CREATED_WORK_LOG}"
printf '%s\n' "${created}"
EOF
  cat >"${fake_bin}/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"${PREP_LOG}"
case "$*" in
  info|'compose version') exit 0 ;;
  *' ps --all --quiet --filter '*|*' network ls --quiet --filter '*|*' volume ls --quiet --filter '*) exit 0 ;;
  *) exit 31 ;;
esac
EOF
  cat >"${fake_bin}/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"${fake_bin}/openssl" <<'EOF'
#!/usr/bin/env bash
if [ "${PREP_FAILURE}" = 'token' ]; then exit 21; fi
printf 'synthetic-access-token\n'
EOF
  cat >"${fake_bin}/ssh-keygen" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = '-l' ]; then
  if [ "${PREP_FAILURE}" = 'fingerprint' ]; then exit 24; fi
  echo '256 SHA256:synthetic-fingerprint synthetic (ED25519)'
  exit 0
fi
key_path=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-f' ]; then key_path="$2"; break; fi
  shift
done
[ -n "${key_path}" ] || exit 25
printf '%s\n%s\n%s\n' '-----BEGIN OPENSSH PRIVATE KEY-----' 'synthetic-marker-line' '-----END OPENSSH PRIVATE KEY-----' >"${key_path}"
printf 'ssh-ed25519 synthetic-public-key\n' >"${key_path}.pub"
if [ "${PREP_FAILURE}" = 'client-key' ] && [[ "${key_path}" = */client_key ]]; then exit 22; fi
if [ "${PREP_FAILURE}" = 'host-key' ] && [[ "${key_path}" = */host_key ]]; then exit 23; fi
EOF
  cat >"${fake_bin}/node" <<'EOF'
#!/usr/bin/env bash
node_call=1
if [ -f "${NODE_CALL_LOG}" ]; then node_call=$(( $(cat "${NODE_CALL_LOG}") + 1 )); fi
printf '%s\n' "${node_call}" >"${NODE_CALL_LOG}"
if [ "${PREP_FAILURE}" = 'node-subnet' ] && [ "${node_call}" -eq 1 ]; then exit 26; fi
if [ "${PREP_FAILURE}" = 'node-port' ] && [ "${node_call}" -eq 2 ]; then exit 27; fi
if [ "${node_call}" -eq 1 ]; then echo 42; else echo 32123; fi
EOF
  cat >"${fake_bin}/chmod" <<'EOF'
#!/usr/bin/env bash
if [ "${PREP_FAILURE}" = 'chmod' ]; then exit 28; fi
if [ "${PREP_FAILURE}" = 'mode-verification' ] && [ "$1" = '0700' ]; then exit 0; fi
exec "${REAL_CHMOD}" "$@"
EOF
  "${REAL_CHMOD}" +x "${fake_bin}"/*
}

run_preparation_failure() {
  local failure="$1"
  local case_root="${TEST_ROOT}/${failure}"
  local fake_bin="${case_root}/bin"
  local temp_root="${case_root}/tmp"
  local output="${case_root}/output.log"
  mkdir -p "${fake_bin}" "${temp_root}"
  write_common_fakes "${fake_bin}"

  PREP_FAILURE="${failure}" \
    PREP_LOG="${case_root}/preparation.log" \
    CREATED_WORK_LOG="${case_root}/created-work.log" \
    NODE_CALL_LOG="${case_root}/node-call.log" \
    REAL_CHMOD="${REAL_CHMOD}" \
    REAL_MKTEMP="${REAL_MKTEMP}" \
    REAL_REALPATH="${REAL_REALPATH}" \
    TMPDIR="${temp_root}" \
    PATH="${fake_bin}:${PATH}" \
    bash "${E2E_SCRIPT}" >"${output}" 2>&1
  local status=$?

  if [ "${status}" -eq 0 ]; then
    echo "ssh-browser-e2e-preparation.test.sh: ${failure} unexpectedly succeeded" >&2
    exit 1
  fi
  if [ -f "${case_root}/created-work.log" ]; then
    local created_work
    created_work="$(cat "${case_root}/created-work.log")"
    if [ -e "${created_work}" ]; then
      echo "ssh-browser-e2e-preparation.test.sh: ${failure} left its temp credentials directory" >&2
      exit 1
    fi
  fi
  if find "${case_root}" -type f \( -name client_key -o -name host_key -o -name '*.pub' \) -print -quit | grep -q .; then
    echo "ssh-browser-e2e-preparation.test.sh: ${failure} left synthetic credential material" >&2
    exit 1
  fi
  if grep -q 'docker .* up ' "${case_root}/preparation.log" 2>/dev/null; then
    echo "ssh-browser-e2e-preparation.test.sh: ${failure} continued into container startup" >&2
    exit 1
  fi
}

for failure in realpath mktemp chmod mode-verification token client-key host-key fingerprint node-subnet node-port; do
  run_preparation_failure "${failure}"
done

if [ "$(sed -n '1p' "${TEST_ROOT}/mktemp/preparation.log")" != 'realpath' ] \
  || [ "$(sed -n '2p' "${TEST_ROOT}/mktemp/preparation.log")" != 'realpath' ] \
  || [ "$(sed -n '3p' "${TEST_ROOT}/mktemp/preparation.log")" != 'mktemp' ]; then
  echo "ssh-browser-e2e-preparation.test.sh: repository/temp realpath validation did not precede mktemp" >&2
  exit 1
fi

echo "ssh-browser-e2e-preparation.test.sh: preparation failures stop before startup and remove synthetic credentials"
