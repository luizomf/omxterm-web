# Webhook-driven PR workflow

Runtime coordination is external to the checkout and keyed by pull request:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/omxterm-agent/pr/<pr-number>.json
```

The repository contains the protocol, CLI, durable Claude runner, guardian, and tests. Runtime state, prompts, logs, locks, and credentials remain outside Git.

## Ownership

```text
GitHub event → webhook → Hermes/Brien → review
                                      ├─ pass → merge → next issue/end
                                      └─ fail → Claude → push → synchronize → new Brien
```

- GitHub events wake Hermes; chat does not start the normal loop.
- Brien is the orchestrator and reviewer. It may dispatch Claude, take over when Claude is proven unavailable, or directly repair a verified workflow defect that prevents the loop from advancing. Direct repair still requires proof that no Claude runner is active, tight workflow-only scope, regression coverage, and full repository verification.
- Claude only implements, tests, commits, and pushes. It never reviews, merges, advances the queue, or starts Brien.
- A push emits `pull_request.synchronize`; that event starts a fresh review session.
- The guardian wakes Brien when the expected GitHub event or runner completion never arrives.

## State

Each state records:

- PR, issue, repository, and current remote SHA;
- phase, informational code-revision count, worker, expected event, and next action;
- lease owner/deadline;
- durable runner id, status, base SHA, and timestamps;
- next issue or explicit queue end;
- wakeup deadline and history.

Exactly one of `nextIssue` or `queue.end` must be set. Missing both is invalid; the loop may not silently forget what follows.

Code revisions count reviewed implementations for observability. They never cap or stop the loop. Authentication, quota, startup, process, push, and webhook delivery failures are recovery events and do not consume another code revision. Only a concrete external condition that prevents OMXTerm code progress may set `blocked`.

## Commands

Commands require `--pr`; tests may override the path with `OMXTERM_AGENT_STATE_PATH`.

```bash
# Create a workflow before opening the PR.
node scripts/state/workflow.mjs start \
  --task "Fix issue #104" --issue 104 --pr 105 \
  --worker webhook --next "Review PR #105." --sha abc123 \
  --next-issue 106

# Persist an accepted GitHub event before Hermes starts.
node scripts/state/workflow.mjs ingest \
  --pr 105 --sha def456 --action synchronize \
  --deadline-at 2026-07-11T20:00:00.000Z

# Idempotently claim the current SHA.
node scripts/state/workflow.mjs claim-review \
  --pr 105 --sha def456 --worker brien \
  --next "Review SHA def456." \
  --deadline-at 2026-07-11T20:00:00.000Z

# Inspect from any session.
node scripts/state/workflow.mjs show --pr 105

# Conclude a verified review.
node scripts/state/workflow.mjs pass \
  --pr 105 --sha def456 --reason "Full review passed."

# Close canonical state after GitHub confirms the merge.
# --merge-sha must be the full 40-character lowercase hex commit SHA GitHub reports for the merge.
node scripts/state/workflow.mjs complete \
  --pr 105 --merge-sha fedcba0123456789fedcba0123456789fedcba01

# Recover state written by the old bounded-attempt protocol.
node scripts/state/workflow.mjs resume \
  --pr 105 --reason "Continue review/correction loop." \
  --deadline-at 2026-07-11T20:30:00.000Z
```

`claim-review` returns an outcome instead of failing for expected concurrency:

- `ignored_duplicate`: same SHA already under review;
- `ignored_worker_active`: correction still owns the same SHA;
- `ignored_terminal`: workflow already finished;
- `ignored_runner_stop_pending`: a newer SHA superseded the recorded runner, but its
  systemd unit is not yet confirmed inactive. Run `confirm-runner-stop` first.

These are no-op outcomes, never blockers.

A newer SHA (via `ingest`, or discovered directly by Brien during `claim-review`) marks
a `starting`/`running` runner `abandoned` immediately, but that only updates JSON — the
systemd unit it names may still be executing Claude. The runner's `stopConfirmed` field
stays `false` until proven otherwise, and `claim-review` refuses every further claim for
that PR while it is `false`. Nothing else can clear it:

```bash
# After confirming via `systemctl --user is-active <runner-id>` (never a raw PID) that
# the unit is inactive, failed, or no longer exists.
node scripts/state/workflow.mjs confirm-runner-stop \
  --pr 105 --runner-id omxterm-pr-105-a1 --unit-status inactive \
  --reason "systemctl --user is-active reported inactive."
```

`--unit-status` only accepts `inactive`, `failed`, or `not-found`; any other value is
rejected so this command cannot be satisfied by an active or activating unit.

## Claude runner

Brien writes a complete prompt outside Git and launches:

```bash
node scripts/state/start-claude.mjs \
  --pr 105 --sha def456 \
  --runner-id omxterm-pr-105-a1 \
  --prompt-file ~/.local/state/omxterm-agent/prompts/omxterm-pr-105-a1.md \
  --deadline-at 2026-07-11T20:30:00.000Z \
  --reason "Verified review blockers." \
  --workdir "$PWD"
```

The runner uses:

```text
claude --dangerously-skip-permissions --model sonnet --effort high --no-session-persistence -p
```

Prompt content is supplied on stdin. A transient user systemd unit keeps Claude alive after the Hermes session ends. `${XDG_STATE_HOME:-$HOME/.local/state}/omxterm-agent/claude.lock` prevents concurrent Claude runners globally.

Brien must confirm either the systemd unit is active or the runner already recorded a terminal result. It then ends the session. It must never start a second model while the first runner may still be alive.

`claude-runner.mjs` claims `running` before it executes Claude. If a newer SHA or a takeover already retired that runner id (`succeeded`, `failed`, or `abandoned`), `runner` returns the no-op outcome `ignored_superseded_runner` instead of reviving it, and `claude-runner.mjs` refuses to execute Claude at all.

## Recovery

On `workflow_wakeup`, Brien reconciles evidence in this order:

1. Fetch PR state and remote SHA with `gh`.
2. Read workflow state.
3. Inspect the recorded systemd unit and runner log; never trust PID alone.
4. If runner is alive, renew the deadline and stop.
5. If SHA changed, treat the webhook as missed and review the remote SHA. If a runner was
   superseded (`stopConfirmed: false`), `claim-review` refuses every claim for this PR
   until `systemctl --user stop <runner-id>` is issued and its unit is confirmed inactive
   with `workflow.mjs confirm-runner-stop`.
6. If Claude died, inspect worktree, commit, push state, and log.
7. Recover partial work or take over with `workflow.mjs takeover` only after proving Claude stopped.
8. If everything already completed, do nothing.

Runner startup/auth/quota failure causes Brien takeover. A code rejection causes another Claude correction without an arbitrary retry ceiling. A stale SHA aborts publication; the new SHA wins.

The guardian runs periodically and emits no message when nothing is overdue. It records the wakeup atomically, then sends a signed local `workflow_wakeup` event through the same Hermes route.

State locks record hostname and PID. A dead owner on the same host is removed
automatically; a live or remote-host owner is preserved because guessing would
reintroduce the race this protocol exists to prevent.

## GitHub visibility

GitHub Check Runs require GitHub App authentication, which this installation
does not use. After every meaningful transition, publish a commit status plus
one updated sticky PR comment:

```bash
node scripts/state/publish-state.mjs --pr 105
```

Everyone can inspect it with:

```bash
gh pr checks 105
gh pr view 105 --json state,headRefOid,statusCheckRollup,comments
```

The `agent-workflow` commit status shows the phase in `gh pr checks`; the sticky
comment exposes attempts, worker, runner, expected event, and next action. Its
response marker prevents comment-trigger loops. GitHub is the shared
projection. External state and its lock remain the coordination authority.

## Terminal states

- `passed`: reviewed SHA is valid; merge and continue to `nextIssue`, or finish explicit queue end.
- `completed`: GitHub confirmed the merge; this PR has no pending workflow action.
- `failed`: legacy/recoverable failure state; use `resume` after correcting its cause.
- `blocked`: real external impossibility or corrupt state, not normal concurrency.
- `stopped`: explicit operator stop.

Duplicate deliveries, duplicate claims, stale events, and active workers are not `blocked`.
