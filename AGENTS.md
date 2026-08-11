# Project Rules

Read this before changing the repository.

## Product and scope

OMXTerm Web is a TypeScript browser SSH terminal. A Vite/React/xterm.js frontend
communicates with a Node/Fastify/WebSocket broker, which connects to a
user-provided SSH target through `ssh2`.

This is a small, security-conscious MVP for a video/demo, not a production SaaS.
Follow `docs/prd-mvp-web-ssh-terminal.md`. Do not add saved profiles, OAuth,
persistent `known_hosts`, replay/transcripts, Redis/SQLite/Postgres,
reconnect/resume, collaboration, WebTransport, Socket.IO, container sandboxing,
or a Hermes CLI adapter unless the PRD is intentionally updated in the same
change.

The UI direction is dark, sparse, premium, and terminal-first. Follow
`docs/design-tokens.md`; avoid generic dashboard chrome and Matrix-green
branding.

## Sources of truth

Evaluate planning, implementation, and review in this order:

1. The originating PRD/specification and its acceptance criteria.
2. Repository architecture, security boundaries, and documented decisions.
3. The engineering rules in this file.

A clean implementation does not pass if it misses the specification. A merged
issue or implementation also does not silently rewrite product intent. When an
intentional decision changes behavior, update the PRD and affected docs in the
same issue/PR.

Security rules remain mandatory when a specification is silent. Surface a
conflict instead of weakening a boundary or inventing behavior.

Read the relevant source before changing behavior:

- `docs/prd-mvp-web-ssh-terminal.md` — product requirements and MVP scope.
- `CONTEXT.md` — canonical domain language.
- `docs/adr/` — durable architecture decisions.
- `docs/how-it-works.md` — security model and request/data flows.
- `docs/architecture.md` — component boundaries.
- `README.md` and `.env.example` — setup, commands, and configuration.

## Repository map

- `apps/web` — React UI, xterm.js integration, and WebSocket transport adapter.
- `apps/server` — Fastify APIs, WebSocket authorization, SSH brokering, limits,
  and audit events.
- `packages/core` — shared protocol, stores, lifecycle, SSH, audit, and terminal
  domain contracts.
- `tests` and `scripts` — integration fixtures and bounded operational checks.

Keep browser terminal rendering decoupled from SSH credentials, access tokens,
device tokens, tickets, host-key confirmation, and product-specific flow. Keep
shared contracts in `packages/core` only when both applications genuinely share
them.

## Security invariants

Preserve these boundaries unless the PRD and security documentation are
explicitly revised:

- Require the access gate, browser-bound device token, and a short-lived,
  single-use terminal ticket.
- Validate exact allowed Origins at HTTP and WebSocket boundaries.
- Reject unauthorized WebSocket upgrades before accepting the connection.
- Require explicit SSH host-key fingerprint confirmation for each session.
- Preserve SSH egress allowlisting and resolved-address pinning.
- Disable WebSocket compression and enforce bounded protocol/input payloads.
- Validate external input at runtime; TypeScript types are not boundary
  validation.
- Never persist or log private keys, passphrases, raw tickets, auth cookies,
  Authorization headers, or raw terminal input/output.
- Emit metadata-only audit events and safe normalized errors.
- Destroy the SSH channel/session when the browser connection closes.
- Use HTTPS/WSS and secure deployment settings outside loopback development.

Do not weaken a security check merely to make a test or demo pass.

## Workflow

For repository changes, use this default flow unless the owner explicitly asks
for another one:

```text
issue -> branch -> implementation and tests -> conventional commits -> PR
      -> squash merge -> delete branch
```

1. Check open issues before starting so work is not duplicated or revived after
   being intentionally deferred.
2. Pick or create the issue, then create a dedicated branch. Do not commit
   directly to `main`.
3. Make the smallest complete change that satisfies the issue. Keep commits
   focused and use conventional commit messages.
4. Open a PR whose body includes `closes #N`.
5. Review the exact PR diff and run the applicable quality gates.
6. Merge only with `gh pr merge --squash --delete-branch`. Do not use merge
   commits or rebase merges.
7. Never force-push `main`. Do not run destructive Git operations without the
   owner's explicit authorization.

Commit format:

```text
type(scope): short imperative description

Optional body explaining intent or constraints.

Co-Authored-By: <agent-name> <noreply@example.com>
```

The body and `Co-Authored-By` line are optional but useful when they add real
context.

Repository agent operations are documented separately:

- Issue tracker: `docs/agents/issue-tracker.md`.
- Triage labels: `docs/agents/triage-labels.md`.
- Domain documentation: `docs/agents/domain.md`.

## Engineering principles

Write code that is easy to understand, test, and safely change:

- Prefer simple, explicit, readable code over clever or premature abstractions.
- Prefer flat control flow, guard clauses, and focused responsibilities over
  deep nesting and large conditional trees.
- Keep modules cohesive. Split a file or function when it mixes
  responsibilities, hides repeated branches, or becomes difficult to explain;
  do not split code only to satisfy an arbitrary line count.
- Avoid high cyclomatic complexity and god modules. Choose clear domain names
  over generic dumping grounds such as `utils`, `helpers`, or `manager`.
- Use explicit types at public boundaries. Avoid `any`; when unavoidable,
  isolate it and explain the external constraint.
- Keep domain rules separate from network, filesystem, process, and clock I/O.
  Inject those dependencies at testable boundaries.
- Preserve useful error context and the original cause. Never swallow errors
  silently.
- Comment non-obvious reasons, security constraints, and upstream workarounds;
  do not narrate obvious code.
- Prefer a practical, maintainable solution over pattern purity. If the design
  is hard to explain, simplify it before adding another layer.

Mechanically enforceable rules belong in formatter, linter, typechecker, and
test configuration rather than repeated prose. Do not suppress a tool failure
without fixing the cause or documenting a narrow, necessary exception.

## Testing rules

Tests are regression protection, not an implementation target:

- Every behavior change needs coverage. Every bug fix needs a regression test
  that would fail without the fix.
- Assert stable, observable behavior and public contracts.
- Avoid assertions on versions, timestamps, generated IDs, copy text, CSS
  classes, log prose, internal call shapes, mock call counts, or other volatile
  values unless they are the behavior being specified.
- Do not weaken, delete, or rewrite a valid test merely to make an implementation
  pass. Reconcile the implementation with the intended behavior first.
- Cover success, rejection, boundary, cleanup, and error paths—not only the
  happy path.
- Mock external I/O in unit tests. Do not use real SSH targets, network services,
  filesystems, or wall-clock time unless the test is explicitly integration or
  E2E.
- Test public behavior through public boundaries. Private helpers normally do
  not need direct tests when their behavior is already covered.
- Never expose credentials, terminal content, or auth material in fixtures,
  snapshots, traces, or failure output.

Security and lifecycle rules deserve direct regression coverage: authorization,
device binding, ticket expiry and single use, Origin checks, host-key trust,
protocol validation, backpressure/limits, and disconnect cleanup.

## Quality gates

Use the repository's root npm scripts:

```bash
npm run format:check
npm run typecheck
npm run test:run
npm run build
```

Run focused tests while developing and all applicable gates before finishing.
Use `npm run test:e2e:ssh` when a change materially affects the browser-to-SSH
flow, Docker fixture, or deployment path and its prerequisites are available.
Explain clearly when an applicable check cannot run.

`format:check` currently validates the Git diff; the repository does not yet
provide a root lint script. Do not claim lint passed or invent `npm run lint`.
When adding mechanically enforceable style or complexity rules, configure a
real root lint command and CI gate in the same change.

## Documentation and completion

Keep documentation synchronized in the same PR when changing the security
model, request flow, public API, configuration, environment variables, setup, or
deployment. Use the existing documentation locations rather than creating a
new dumping ground. Code artifacts and contributor documentation are in
English.

Before finishing:

- Review the diff for unrelated changes.
- Run formatting/diff checks, typechecking, relevant tests, and build as
  applicable.
- Confirm new behavior and regressions have meaningful tests.
- Confirm errors remain useful and no secret or private information was added.
- Update affected docs, or state why documentation is not applicable.
- Report exactly what changed and which checks ran; never claim unrun checks
  passed.

Ask for clarification when ambiguity materially changes behavior, security,
scope, or authorization. Otherwise, state a reasonable assumption and proceed.
