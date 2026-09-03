#!/usr/bin/env bash

set -euo pipefail

SCRIPTS_DIR="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"
ROOT_DIR="$(dirname "${SCRIPTS_DIR}")"
WORK="$(mktemp -d)"
HARNESS="${WORK}/repository"
RECORDS="${WORK}/records"
launcher_pid=""

cleanup() {
  if [ -n "${launcher_pid}" ] && kill -0 "${launcher_pid}" 2>/dev/null; then
    kill "${launcher_pid}" 2>/dev/null || true
    wait "${launcher_pid}" 2>/dev/null || true
  fi

  case "${WORK}" in
    /tmp/tmp.*|/private/tmp/tmp.*|/var/folders/*/T/tmp.*|/private/var/folders/*/T/tmp.*)
      rm -rf "${WORK}"
      ;;
    *)
      echo "run.test.sh: refusing to remove unexpected temp directory" >&2
      exit 1
      ;;
  esac
}
trap cleanup EXIT

wait_for_file() {
  local path=$1

  for _ in {1..200}; do
    if [ -f "${path}" ]; then
      return 0
    fi
    sleep 0.05
  done

  echo "run.test.sh: timed out waiting for ${path}" >&2
  if [ -f "${RECORDS}/launcher.out" ]; then
    cat "${RECORDS}/launcher.out" >&2
  fi
  return 1
}

mkdir -p "${HARNESS}/scripts" "${HARNESS}/bin" "${RECORDS}"
cp "${SCRIPTS_DIR}/run" "${SCRIPTS_DIR}/parse-dotenv.mjs" "${HARNESS}/scripts/"
ln -s "${ROOT_DIR}/node_modules" "${HARNESS}/node_modules"

cat >"${HARNESS}/.env" <<'EOF'
DOTENV_PLAIN=ordinary
DOTENV_SPACED="value with spaces # kept"
DOTENV_MULTILINE="line one
line two"
DOTENV_COMMAND_SUBSTITUTION=$(touch command-substitution-ran)
DOTENV_BACKTICKS="`touch backticks-ran`"
DOTENV_SHELL_SYNTAX=shell-value; touch shell-syntax-ran
DOTENV_FUNCTION_SYNTAX=() { touch function-syntax-ran; }
EOF

cat >"${HARNESS}/bin/npm" <<'EOF'
#!/usr/bin/env bash

set -euo pipefail

target=${2:?}
shift 2
name=${target#dev:}

{
  printf '%s\0' \
    "${DOTENV_PLAIN-}" \
    "${DOTENV_SPACED-}" \
    "${DOTENV_MULTILINE-}" \
    "${DOTENV_COMMAND_SUBSTITUTION-}" \
    "${DOTENV_BACKTICKS-}" \
    "${DOTENV_SHELL_SYNTAX-}" \
    "${DOTENV_FUNCTION_SYNTAX-}" \
    "${@}"
} >"${RUN_TEST_RECORD_DIR}/${name}.record"

echo "$$" >"${RUN_TEST_RECORD_DIR}/${name}.pid"
touch "${RUN_TEST_RECORD_DIR}/${name}.ready"

if [ "${target}" = "dev:server" ]; then
  while [ ! -f "${RUN_TEST_RECORD_DIR}/release-server" ]; do
    sleep 0.05
  done
  exit 23
fi

trap 'touch "${RUN_TEST_RECORD_DIR}/web-terminated"; exit 0' TERM INT
while true; do
  sleep 1
done
EOF
chmod +x "${HARNESS}/bin/npm"

for target in server web; do
  {
    printf '%s\0' \
      "ordinary" \
      "value with spaces # kept" \
      $'line one\nline two' \
      '$(touch command-substitution-ran)' \
      '`touch backticks-ran`' \
      'shell-value; touch shell-syntax-ran' \
      '() { touch function-syntax-ran; }' \
      "--" \
      "--host" \
      "127.0.0.1" \
      "argument with spaces"
  } >"${RECORDS}/${target}.expected"
done

(
  cd "${HARNESS}"
  PATH="${HARNESS}/bin:${PATH}" RUN_TEST_RECORD_DIR="${RECORDS}" \
    bash "${HARNESS}/scripts/run" -- --host 127.0.0.1 "argument with spaces"
) >"${RECORDS}/launcher.out" 2>&1 &
launcher_pid=$!

wait_for_file "${RECORDS}/server.ready"
wait_for_file "${RECORDS}/web.ready"

cmp "${RECORDS}/server.expected" "${RECORDS}/server.record"
cmp "${RECORDS}/web.expected" "${RECORDS}/web.record"

for side_effect in \
  command-substitution-ran \
  backticks-ran \
  shell-syntax-ran \
  function-syntax-ran; do
  if [ -e "${HARNESS}/${side_effect}" ]; then
    echo "run.test.sh: dotenv content created unexpected side effect ${side_effect}" >&2
    exit 1
  fi
done

touch "${RECORDS}/release-server"
set +e
wait "${launcher_pid}"
status=$?
set -e
launcher_pid=""

if [ "${status}" -ne 23 ]; then
  echo "run.test.sh: expected launcher status 23, got ${status}" >&2
  exit 1
fi

wait_for_file "${RECORDS}/web-terminated"

for target in server web; do
  child_pid="$(cat "${RECORDS}/${target}.pid")"
  if kill -0 "${child_pid}" 2>/dev/null; then
    echo "run.test.sh: ${target} process ${child_pid} is still running" >&2
    exit 1
  fi
done

echo "run.test.sh: dotenv values stayed literal and reached both supervised processes"
