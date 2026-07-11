# Project Rules

Read this before doing anything.

---

## Repository Context

OMXTerm is a TypeScript web terminal project. The MVP is a browser-based SSH terminal: a Vite/React/xterm.js frontend talks to a Node/Fastify/WebSocket backend, which uses SSH to connect to a user-provided target. The product's security boundary is safe brokering: access gate, device token, short-lived single-use terminal tickets, exact Origin validation, SSH host-key fingerprint confirmation, no saved private keys, no raw terminal transcripts, and metadata-only audit logs.

This is a weekend-sized MVP for a video/demo, not a production SaaS. Keep scope small and follow `docs/prd-mvp-web-ssh-terminal.md`. Do not add saved profiles, OAuth, persistent known_hosts, replay/transcripts, Redis/SQLite/Postgres, reconnect/resume, collaboration, WebTransport, Socket.IO, container sandboxing, or Hermes CLI adapter unless the PRD is explicitly updated first.

---

## Workflow

When no other workflow is defined by the user, follow this default flow:

```
new branch -> issue -> code -> PR -> merge (squash and delete)
```

If this directory is not a repository, tell the user it **requires `git` and
`gh`** and help them to configure everything.

### Do not duplicate issues

Before starting new feature work, check open issues and confirm whether the
request already maps to an open issue, was intentionally deferred, or was
already delivered locally but not cleaned up in the tracker. Keep the issue list
accurate as part of the workflow.

1. Pick or create the issue. If no issue template exists, create one.
2. Create a branch for that issue.
3. Work in small **conventional commits**.
4. Open a PR with `closes #N`. If no PR template exists, create one.
5. Merge with **squash merge** (`gh pr merge --squash --delete-branch`). This is
   the repository convention: every PR collapses into a single commit on `main`.
   Do not use merge commits or rebase merges.
6. Delete the branch after merge (squash and delete; `--delete-branch` handles
   this).

### Local agent workflow state

When an implementation/review loop is coordinated through
`scripts/state/workflow.json`, every participating agent must read
[`scripts/state/README.md`](./scripts/state/README.md) and inspect the current
state before acting. Update the state before handing work to another agent.

The state records the active task, PR/SHA, current worker, attempt, next action,
and stop conditions. Treat terminal states (`passed`, `failed`, `blocked`, or
`stopped`) as a hard stop. Reviewers review; correction work must be assigned
through the state instead of being implemented silently by the reviewer.

Runtime state, locks, and temporary files are local and ignored by Git while
the protocol is being validated. Do not commit them.

Since Git and GitHub are the main project context, be explicit, precise, and
concise about every change. Always describe what matters for project
understanding in commits, issues, PRs, and handoffs.

### Commit Style

```text
type(scope): short imperative description

Body (optional)

Co-Authored-By: <agent-name> <noreply@example.com>
```

Body and `Co-Authored-By` are optional, but desired.

---

## Project Coding Rules

These rules are not decorative. Follow them unless there is a clear technical
reason not to. When breaking a rule, keep the code simple and make the reason
obvious.

### Core principles

- Prefer boring, simple, explicit and maintainable code.
- Do not over-engineer.
- Do not hide complexity behind vague names.
- Follow the conventions of the framework, language, and ecosystem.
- Optimize for maintainability, readability, testability, and safe future
  changes.

### Code style

The code style is our main objective. Follow the rules below whenever possible.

- Functions should usually be small and focused.
  - Aim for up to 40 lines.
  - Keep Cyclomatic Complexity as low as possible.
  - Longer functions are acceptable when the flow is simple, linear, and easier
    to read in one place.
  - Split functions when they mix responsibilities, contain repeated blocks, or
    require deep nesting.

- Files should stay focused.
  - Aim to keep files under 500 lines.
  - Larger files are acceptable for generated code, schemas, constants,
    mappings, fixtures, or framework-required structure.
  - Split files by responsibility, not just by line count.

- Each function should do one clear thing.
- Each module should own one clear responsibility.
- Prefer clear domain names over generic names.

Avoid vague names such as (unless for libs and framework conventions):

- `data`
- `handler`
- `manager`
- `processor`
- `service`
- `utils`
- `helper`
- `thing`
- `item`

Use names that describe the domain, behavior, or returned value.

Bad:

```ts
function handle(data: any) {} // handle what? which data? what type is the data?
```

Better:

```ts
function createUserSession(credentials: LoginCredentials) {} // The same function, way easier to read, find and understand
```

- Prefer searchable names where you can easily use commands to find what you
  need.
- Generic names like `request`, `response`, `payload`, `config`, `logger`, or
  `client` are allowed when the context makes them obvious (and they are
  searchable).
- Prefer early returns over deeply nested conditionals.
- Prefer shallow nesting. Reconsider the design when nesting goes beyond two or
  three levels — usually a guard clause, an early return, or a small extracted
  function fixes it.
- Keep control flow obvious.
- Avoid clever code where other developers might have a hard time understanding
  it.
- Avoid hidden side effects.
- Prefer immutable data.
- Keep domain and business logic decoupled from infrastructure (databases, file
  systems, external binaries, network calls, system clocks). Inject these as
  dependencies at the boundary instead of importing them directly inside domain
  code.
- Do not hardcode magic numbers, magic strings, secrets, passwords, tokens and
  other values known to be tied to the environment.

### Types

- Use explicit types at public boundaries.
- Do not use `any` or similar types unless there is no safer option.
- When `any` is unavoidable, isolate it and explain why. Avoid contaminating the
  rest of the code with `any` types.
- Avoid untyped functions.
- Prefer domain-specific types over loose types.
- Validate external input at the boundary.
- Do not trust API input, CLI input, environment variables, database rows, or
  user-controlled data without validation.
- Use type checkers, linters and tests to ensure code quality and avoid
  regressions.

### Duplication

- Do not duplicate business rules, validation logic or any preexisting code.
- Extract shared logic only when the abstraction has a clear name and a stable
  purpose.
- Avoid premature "reusable" helpers.
- Avoid premature optimization.

### Errors and exceptions

- Error messages must be useful.
- Include the offending value when safe.
- Include the expected shape, format, or allowed values.
- Do not swallow errors silently.
- Do not replace specific errors with vague generic messages.
- Preserve the original error when wrapping exceptions.

Bad:

```ts
throw new Error('Invalid input'); // now nobody knows what happened
```

Better:

```ts
throw new UserRoleError(
  `Invalid user role "${role}". Expected one of: admin, editor, viewer.`,
);
```

### Comments

- Keep existing comments for agent context. They help the agent remember **WHY**
  that code exists.
- When doing something unusual, add **WHY** you did that in comment. That will
  help you in future rounds.
- When commenting, do not add **WHAT** the code does; prefer the **WHY**
  instead.
- Remove comments when they don't carry intent, history, context, are wrong or
  obsolete.

Bad:

```ts
// ❌ Increment counter (obvious)
counter++;
```

Better:

```ts
// ✅ GitHub API may return duplicated events during pagination, so we dedupe by id. (not obvious)
seenEventIds.add(event.id);
```

- Use comments for non-obvious decisions, upstream constraints, workarounds,
  performance tradeoffs, and security concerns.
- Reference issue numbers, PRs, commit SHAs, or external bugs when a line exists
  because of a specific bug or constraint.
- Public functions should have docstrings/comments when their purpose, usage, or
  constraints are not obvious.
- Public APIs should include intent and at least one usage example when useful.

### Documentation

- Keep docs in sync with behavior, in the same PR. Update docs when a change
  alters: the security model or request flow, a public endpoint/API, config or
  env knobs, or how to run/deploy.
- Do not document internal refactors that change no observable behavior.
- Write in the right place; do not create new doc dumping grounds:
  - `docs/how-it-works.md` — security model and request/data flows.
  - `README.md` — setup, run, deploy, env vars.
  - `docs/architecture.md` — high-level structure.
  - `docs/adr/` — one file per significant decision.
  - `CONTEXT.md` — domain language.
- Docs are contributor-facing and in English (the project is open-source), not a
  personal video script.

### Tests

- New behavior needs tests.
- Bug fixes need regression tests.
- Business rules need tests.
- Validation rules need tests.
- Public functions and public APIs should be tested through observable behavior.
- Private helper functions do not always need direct tests if they are covered
  through public behavior.
- Avoid tests that only mirror implementation details.

**Test logic, inputs, outputs, and all paths — not implementation details.**

Avoid asserting on values that change often during maintenance: versions,
timestamps, model names, prompt text, generated documentation, internal call
shapes, log strings, and similar volatile values. If a refactor that preserves
behavior breaks a test, the test was probably testing the wrong thing.

Tests should be F.I.R.S.T:

- Fast
- Independent
- Repeatable
- Self-validating
- Timely

Additional testing rules:

- Mock external I/O.
- Do not call real APIs in unit tests.
- Do not depend on real databases, real filesystems, real network, or real time
  unless the test is explicitly an integration/e2e test.
- Prefer named fake classes or fixtures over anonymous inline stubs when the
  fake has behavior.
- Test names should describe behavior, not implementation.

Bad ❌:

```ts
test('handleSubmit works', () => {});
```

Better ✅:

```ts
test('creates a user session when credentials are valid', () => {});
```

### Dependencies

- Prefer dependency injection through parameters, constructors, or small factory
  functions.
- Avoid hidden dependencies through global state.
- Avoid importing concrete infrastructure directly into domain/business logic.
- Wrap third-party libraries when:
  - they touch business logic;
  - they are hard to test;
  - they may be replaced;
  - they spread complex types through the project;
  - they require project-specific defaults or error handling.
- Do not create wrappers for trivial library calls unless they improve clarity,
  testing, or isolation.
- Keep wrappers thin and owned by this project.

### Structure

- Follow the framework's conventions first.
- Do not fight the framework without a strong reason.
- Prefer predictable paths over personal architecture experiments.
- Keep modules small and focused.
- Avoid god files.
- Avoid generic dumping grounds like:

```txt
utils/
helpers/
common/
misc/
```

Unless the content is genuinely small, stable, and well named.

Prefer structure by responsibility/domain.

Examples:

```txt
src/users/create-user.ts
src/users/user-repository.ts
src/auth/create-session.ts
src/billing/calculate-invoice-total.ts
```

Instead of:

```txt
src/utils/user-utils.ts
src/services/manager.ts
src/helpers/index.ts
```

### Formatting

- Use the default formatter for the language/ecosystem.
- Do not manually debate formatting.
- Do not reformat unrelated files.
- Do not mix formatting-only changes with behavior changes unless explicitly
  requested.

Examples:

```sh
prettier
black
ruff format
gofmt
cargo fmt
rubocop -A
```

### Logging and observability

- Logs for debugging and observability should be structured.
- Prefer JSON or JSONL logs in services, workers, APIs, and production systems.
- CLI output intended for humans should be plain text and readable.
- Do not leak secrets, tokens, passwords, cookies, authorization headers,
  private keys, or personal data in logs.
- Log meaningful events, not noise.
- Include useful context such as ids, operation names, durations, and failure
  reasons.
- Do not use logs as a replacement for proper error handling.

### Refactoring

- Refactor only with a clear goal.
- Keep refactors small and reviewable.
- Preserve behavior unless the task explicitly asks for behavior changes.
- Preserve public APIs unless the change is intentional.
- Preserve existing comments unless wrong or obsolete.
- Update tests when behavior changes.
- Add regression tests before or with bug fixes.

### AI / agent rules

When an AI assistant or coding agent works on this project:

- Read the relevant files before changing anything.
- Understand the current structure before proposing a new one.
- Make the smallest safe change that solves the task.
- Do not invent architecture.
- Do not rename files, functions, or public APIs unless necessary.
- Do not silently ignore failing tests.
- Do not claim something works without running or explaining the relevant check.
- If a command cannot be run, say so clearly.
- Prefer editing existing code over creating parallel implementations.
- Prefer project conventions over personal preferences.
- Stop and explain when the requested change conflicts with these rules.

### Before finishing a task

Verify at least:

- The code is formatted.
- The code type-checks, when applicable.
- Relevant tests pass, when available.
- New behavior has tests, when practical.
- Docs updated when behavior/security-model/API/config/deploy changed (or N/A).
- Errors include useful context.
- No unrelated files were changed.
- No secrets or sensitive data were added.
- The final response explains what changed and what was verified.

## Communication

- Before writing code, make sure you understand what the owner wants. If the
  request is ambiguous, ask a brief clarifying question first. Even when chat is
  casual and informal.
- Explain blockers and tradeoffs plainly.
- When the owner references a tool, flag, or concept, consider whether it
  belongs to the current project or to an external tool before searching or
  editing the codebase.

---

## Security / Safety Rules

Always apply these safety checks.

- Check whether `.gitignore` is correct when adding files, fixtures, generated
  output, caches, logs, or local-only artifacts.
- **NEVER COMMIT `.env` OR ANY SECRETS.**
- Never hardcode secrets or any private information.
- Never log secrets or any private information.
- Never force-push `main`.
- No destructive git operations without explicit user confirmation.
- Validate all external input.
- Escape, sanitize, or encode user-controlled output when needed.
- Treat filesystem paths, URLs, shell arguments, uploaded files, and serialized
  data as unsafe by default.

---
