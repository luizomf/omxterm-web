# Local agent workflow state

`scripts/state/workflow.json` is the shared coordination record for automated
implementation and PR-review loops. It is intentionally local and ignored by
Git until the protocol proves stable.

Every agent participating in a loop must read the state before acting and update
it before handing work to another agent. Conversation memory and PR comments are
context, not workflow state.

## What the state answers

- What task and PR are active?
- Which SHA is being reviewed?
- Who is working now?
- Which attempt is running?
- Who acts next, and what must they do?
- Has the loop passed, failed, blocked, or been explicitly stopped?

## Lifecycle

```text
implementing → awaiting_review → reviewing → passed
                                      ↓
                                    fixing
                                      ↓
                              awaiting_review
```

`failed`, `blocked`, and `stopped` are also terminal. A failed review uses
`retry`; it increments the attempt before assigning Claude. When the next
attempt would exceed `maxAttempts`, the CLI writes `failed`, assigns the next
action to a human, and does not start another correction.

## Commands

Run from the repository root:

```bash
# Start one task
node scripts/state/workflow.mjs start \
  --task "Fix issue #102" \
  --issue 102 \
  --worker claude \
  --next "Implement, test, push, and open a PR." \
  --max-attempts 3

# Inspect before acting
node scripts/state/workflow.mjs show

# Claude opened or updated the PR
node scripts/state/workflow.mjs transition \
  --status awaiting_review \
  --worker webhook \
  --next "Review PR #103." \
  --pr 103 \
  --sha abc123

# Webhook claimed the review
node scripts/state/workflow.mjs transition \
  --status reviewing \
  --worker brien \
  --next "Publish one final review." \
  --sha abc123

# Review failed: reserve the next attempt before starting Claude
node scripts/state/workflow.mjs retry \
  --worker claude \
  --reason "Compose broker is unreachable." \
  --next "Fix verified blockers on PR #103."

# Explicit stop
node scripts/state/workflow.mjs stop \
  --reason "Luiz requested a pause." \
  --next "Wait for Luiz."
```

Use `transition --status passed|failed|blocked` from `reviewing` for a final
review outcome. Include `--reason` for terminal transitions.

## Coordination rules

1. Read state before doing work.
2. Refuse work for an obsolete SHA or terminal state.
3. Update state before launching the next worker.
4. One worker owns a PR at a time.
5. Reviewer reviews; it does not implement. A failed review uses `retry` to
   assign Claude.
6. Stop on review pass, exhausted attempts, blocker, or explicit stop.
7. Do not commit `workflow.json`, lock files, or temporary files.

Writes use a local lock and atomic rename. A lock error means another agent may
be changing the state; do not delete the lock blindly while that agent is alive.
