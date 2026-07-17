#!/usr/bin/env bash

# Regression suite for scripts/deploy (issue #75).
#
# It exercises the deploy guards against a REAL git in throwaway sandboxes, with
# a fake `docker` shimmed onto PATH. No real rollout, Docker, or Traefik is ever
# touched, so this is safe to run anywhere — never point it at production.
#
# Run: bash scripts/deploy.test.sh

set -uo pipefail

SCRIPTS_DIR="$(realpath "$(dirname "${BASH_SOURCE[0]}")")"
DEPLOY="${SCRIPTS_DIR}/deploy"
DEPLOY_DOC="${SCRIPTS_DIR}/../docs/deploy.md"

# Deterministic identity so `git commit` works in the temp repos.
export GIT_AUTHOR_NAME="deploy-test"
export GIT_AUTHOR_EMAIL="deploy-test@example.com"
export GIT_COMMITTER_NAME="deploy-test"
export GIT_COMMITTER_EMAIL="deploy-test@example.com"

pass=0
fail=0
sandboxes=()

fail_test() {
  echo "  FAIL: $1"
  fail=$((fail + 1))
}

pass_test() {
  echo "  ok: $1"
  pass=$((pass + 1))
}

cleanup() {
  for dir in "${sandboxes[@]}"; do
    rm -rf "${dir}"
  done
}
trap cleanup EXIT

# Build an isolated sandbox: a bare "remote", a local checkout on main tracking
# it, a fake `docker` that only records its argv, and empty log files.
setup_sandbox() {
  SANDBOX="$(mktemp -d)"
  sandboxes+=("${SANDBOX}")
  REMOTE="${SANDBOX}/remote.git"
  APP="${SANDBOX}/omxterm-web"
  FAKEBIN="${SANDBOX}/bin"
  DOCKER_LOG="${SANDBOX}/docker.log"
  OUT_LOG="${SANDBOX}/out.log"

  mkdir -p "${FAKEBIN}"
  cat >"${FAKEBIN}/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${DOCKER_LOG}"
EOF
  chmod +x "${FAKEBIN}/docker"
  : >"${DOCKER_LOG}"

  git init -q --bare "${REMOTE}"
  git init -q "${APP}"
  (
    cd "${APP}"
    git symbolic-ref HEAD refs/heads/main
    echo v1 >app.txt
    git add app.txt
    git commit -qm init
    git remote add origin "${REMOTE}"
    git push -q -u origin main
  )
}

# Push a new commit to the remote so the local checkout is behind by one.
advance_remote() {
  local work="${SANDBOX}/upstream-work"
  git clone -q "${REMOTE}" "${work}"
  (
    cd "${work}"
    echo v2 >>app.txt
    git add app.txt
    git commit -qm "remote change"
    git push -q origin main
  )
  rm -rf "${work}"
}

run_deploy() {
  PATH="${FAKEBIN}:${PATH}" OMXTERM_DIR="${APP}" bash "${DEPLOY}" >"${OUT_LOG}" 2>&1
}

docker_ran() { [ -s "${DOCKER_LOG}" ]; }
head_sha() { git -C "${APP}" rev-parse HEAD; }

test_clean_uptodate_deploys_app_only() {
  echo "clean + up-to-date deploys only the omxterm service"
  setup_sandbox

  if ! run_deploy; then
    fail_test "expected exit 0 on a clean, up-to-date checkout"
    return
  fi
  docker_ran || fail_test "expected docker compose to run"
  grep -q -- "--project-name omxterm" "${DOCKER_LOG}" ||
    fail_test "expected the existing omxterm Compose project to be preserved"
  grep -q "omxterm" "${DOCKER_LOG}" || fail_test "expected the omxterm service to be recreated"
  if grep -qiE "traefik|nginx|caddy" "${DOCKER_LOG}"; then
    fail_test "must not touch the reverse-proxy edge stack"
  fi
  if grep -q "down" "${DOCKER_LOG}"; then
    fail_test "must not run 'compose down' on any stack"
  fi
  pass_test "app recreated, edge untouched, nothing stopped"
}

test_applies_production_override() {
  echo "app-scoped deploy applies the production edge override on top of the baseline"
  setup_sandbox

  if ! run_deploy; then
    fail_test "expected exit 0 on a clean, up-to-date checkout"
    return
  fi
  grep -q -- "-f compose.yml" "${DOCKER_LOG}" || fail_test "expected the portable baseline compose.yml to be applied"
  grep -q -- "-f compose.prod.yml" "${DOCKER_LOG}" ||
    fail_test "expected the production edge override compose.prod.yml to be applied"
  grep -q "omxterm" "${DOCKER_LOG}" || fail_test "expected the omxterm service to be recreated"
  pass_test "baseline + production override applied, app-scoped"
}

test_behind_remote_fast_forwards() {
  echo "clean + behind remote fast-forwards, then deploys"
  setup_sandbox
  advance_remote
  local before after
  before="$(head_sha)"

  if ! run_deploy; then
    fail_test "expected exit 0 when a fast-forward is possible"
    return
  fi
  after="$(head_sha)"
  [ "${before}" != "${after}" ] || fail_test "expected HEAD to fast-forward"
  docker_ran || fail_test "expected docker compose to run after fast-forward"
  pass_test "fast-forwarded and deployed"
}

test_diverged_branch_fails_without_touching_anything() {
  echo "diverged branch fails without merging, rewriting, or deploying"
  setup_sandbox
  advance_remote
  # Local commit that the remote does not have -> divergence, no fast-forward.
  (
    cd "${APP}"
    echo local-only >>app.txt
    git add app.txt
    git commit -qm "local change"
  )
  local before after
  before="$(head_sha)"

  if run_deploy; then
    fail_test "expected non-zero exit on a diverged branch"
  fi
  after="$(head_sha)"
  [ "${before}" = "${after}" ] || fail_test "must not merge or rewrite a diverged branch"
  docker_ran && fail_test "must not run docker after refusing to deploy"
  pass_test "refused, HEAD preserved, no docker"
}

test_dirty_tracked_file_stops_before_docker() {
  echo "dirty tracked file stops before docker, byte-for-byte preserved"
  setup_sandbox
  printf 'operator-wip' >"${APP}/app.txt"

  if run_deploy; then
    fail_test "expected non-zero exit on a dirty tracked file"
  fi
  docker_ran && fail_test "must not run docker with a dirty checkout"
  [ "$(cat "${APP}/app.txt")" = "operator-wip" ] || fail_test "tracked file was not preserved byte-for-byte"
  pass_test "refused, tracked edit preserved, no docker"
}

test_untracked_file_stops_before_docker() {
  echo "untracked file stops before docker and is never staged/removed"
  setup_sandbox
  printf 'secret-scratch' >"${APP}/untracked.txt"

  if run_deploy; then
    fail_test "expected non-zero exit on an untracked file"
  fi
  docker_ran && fail_test "must not run docker with untracked files present"
  [ -f "${APP}/untracked.txt" ] || fail_test "untracked file was removed"
  [ "$(cat "${APP}/untracked.txt")" = "secret-scratch" ] || fail_test "untracked file was mutated"
  pass_test "refused, untracked file untouched, no docker"
}

test_wrong_branch_fails() {
  echo "a checkout not on the deploy branch fails safely"
  setup_sandbox
  git -C "${APP}" checkout -q -b feature

  if run_deploy; then
    fail_test "expected non-zero exit when not on the deploy branch"
  fi
  docker_ran && fail_test "must not deploy from an unexpected branch"
  pass_test "refused off-branch deploy"
}

test_unexpected_upstream_fails() {
  echo "the deploy branch tracking an unexpected upstream fails safely"
  setup_sandbox
  git -C "${APP}" branch unintended
  git -C "${APP}" push -q origin unintended
  git -C "${APP}" branch --set-upstream-to=origin/unintended main >/dev/null

  if run_deploy; then
    fail_test "expected non-zero exit when main does not track origin/main"
  fi
  docker_ran && fail_test "must not deploy from an unexpected upstream"
  pass_test "refused unexpected upstream"
}

# Regression for issue #85: unrelated tooling may already export generic
# PROJECTS_DIR/CODE_DIR. The deploy must ignore them and resolve the checkout
# only from the OMXTerm-namespaced env. Here OMXTERM_DIR is left unset so
# resolution goes through the default path derived from OMXTERM_CODE_DIR; the
# generic vars point at bogus dirs that would break resolution if still read.
test_ignores_generic_project_dirs() {
  echo "ignores generic PROJECTS_DIR/CODE_DIR, resolves via OMXTerm-namespaced env"
  setup_sandbox

  if ! PATH="${FAKEBIN}:${PATH}" \
       PROJECTS_DIR="${SANDBOX}/inherited-projects" \
       CODE_DIR="${SANDBOX}/inherited-code" \
       OMXTERM_CODE_DIR="${SANDBOX}" \
       bash "${DEPLOY}" >"${OUT_LOG}" 2>&1; then
    fail_test "expected exit 0 resolving via OMXTERM_CODE_DIR while generic vars are set"
    return
  fi
  docker_ran || fail_test "expected docker compose to run against the namespaced checkout"
  grep -q -- "--project-name omxterm" "${DOCKER_LOG}" ||
    fail_test "expected the existing omxterm Compose project to be preserved"
  grep -q "omxterm" "${DOCKER_LOG}" || fail_test "expected the omxterm service to be recreated"
  pass_test "resolved via OMXTERM_CODE_DIR, generic PROJECTS_DIR/CODE_DIR ignored"
}

test_docs_keep_portable_compose_project_isolation() {
  echo "portable docs derive the Compose project; maintainer rollout pins the existing stack"
  local portable_docs updating_docs
  portable_docs="$(sed '/^## Updating$/,$d' "${DEPLOY_DOC}")"
  updating_docs="$(sed -n '/^## Updating$/,$p' "${DEPLOY_DOC}")"

  if grep -F -q -- '--project-name omxterm' <<<"${portable_docs}"; then
    fail_test "fresh-clone documentation must not adopt the maintainer Compose project"
    return
  fi
  if ! grep -F -q -- 'docker compose up -d --build' <<<"${portable_docs}"; then
    fail_test "portable baseline command must use Compose directory-derived project semantics"
    return
  fi
  if ! grep -F -q -- '--project-name omxterm' <<<"${updating_docs}"; then
    fail_test "maintainer migration/rollout must preserve the existing omxterm Compose project"
    return
  fi
  pass_test "fresh clones remain isolated; existing maintainer rollout remains continuous"
}

test_clean_uptodate_deploys_app_only
test_applies_production_override
test_behind_remote_fast_forwards
test_diverged_branch_fails_without_touching_anything
test_dirty_tracked_file_stops_before_docker
test_untracked_file_stops_before_docker
test_wrong_branch_fails
test_unexpected_upstream_fails
test_ignores_generic_project_dirs
test_docs_keep_portable_compose_project_isolation

echo
echo "deploy.test.sh: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
