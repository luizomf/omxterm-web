<!--
Workflow (see AGENTS.md): issue → branch → PR (closes #N) → squash merge.
Keep commits conventional: type(scope): description.
-->

## Context

<!-- Why this change exists. Link the issue it closes. -->

Closes #

## Changes

<!-- The key changes, as bullets. -->

-

## How to verify

<!-- Steps a reviewer can follow, or the checks you ran. -->

## Checklist

- [ ] Commits are conventional (`type(scope): description`)
- [ ] Code is formatted (`npx --no-install prettier --check .`)
- [ ] Type-checks pass (`npm run typecheck`)
- [ ] Relevant tests pass (`npm run test:run`)
- [ ] New behavior has tests (when practical)
- [ ] No unrelated files changed; no secrets added
- [ ] Security-sensitive change (Origin / auth / ticket / SSH)? Ran `security-review`
