# AGENTS.md

Repository map and engineering contract for humans and coding agents working on
OMXTerm Web.

## Authority and scope

- This file applies repository-wide. A nested `AGENTS.md` may refine it for its
  subtree; the closest applicable file wins.
- Evaluate work in this order: the originating specification and acceptance
  criteria, documented architecture and security decisions, then these
  engineering rules. Surface conflicts instead of silently choosing one source.
- Read the relevant canonical sources before changing behavior:
  `docs/prd-mvp-web-ssh-terminal.md` for product behavior and MVP scope,
  `CONTEXT.md` for domain language, `docs/adr/` for durable architecture
  decisions, `docs/how-it-works.md` for security and request flows,
  `docs/architecture.md` for component boundaries, `docs/design-tokens.md` for
  UI direction, and `README.md` plus `.env.example` for setup and configuration.
- Do not change this contract during unrelated work.

## Project map

- **Purpose and non-goals:** OMXTerm Web is a small, security-conscious browser
  SSH terminal MVP for a video/demo, not a production SaaS. Do not add saved
  profiles, OAuth, persistent `known_hosts`, replay/transcripts, durable or
  shared stores, reconnect/resume, collaboration, WebTransport, Socket.IO,
  container sandboxing, or a Hermes CLI adapter unless the PRD is intentionally
  revised in the same change.
- **Architecture:** `apps/web` is the React/xterm.js UI and WebSocket transport;
  `apps/server` is the Fastify/WebSocket broker and `ssh2` client; `packages/core`
  contains genuinely shared protocol, store, lifecycle, SSH, audit, and terminal
  contracts. Only the broker speaks SSH. The terminal emulator remains
  transport-agnostic and unaware of credentials, access/device tokens, tickets,
  host-key confirmation, and product flow.
- **Trust boundaries:** the browser, HTTP/WebSocket inputs, deployment proxy,
  DNS, and user-selected SSH target are untrusted. The broker establishes and
  cleans up the bridge; the SSH target controls shell privileges and command
  authorization. OMXTerm Web does not sandbox remote commands.
- **Supported environment:** Node.js `^22.12.0 || ^24.0.0`, npm 10 or newer,
  TypeScript workspaces, and the pinned `ssh2` 1.17.0 adaptation applied by the
  install lifecycle. Bun, Deno, edge runtimes, and container-per-session
  orchestration are outside the MVP.
- **Generated artifacts:** build output is written to ignored `dist/` paths by
  `npm run build`. Dependencies, coverage, Vite caches, and TypeScript build
  metadata are also ignored; do not commit them.

## Canonical commands

Run commands from the repository root.

```text
Bootstrap:              npm ci
Run:                    ./scripts/run
Server dev:             npm run dev:server
Web dev:                npm run dev:web
Focused test:           npm run test:run --workspace @omxterm/server -- src/config.test.ts
Test:                   npm run test:run
SSH browser E2E:         npm run test:e2e:ssh
Lint / smells:          npm run lint
Type-check:             npm run typecheck
Complexity policy:      npm run test:lint-config
Format check:           npm run format:check
Format write:           N/A; no repository formatter is configured
Docs check:             N/A; no separate documentation checker is configured
Dependency audit:       npm run audit:dependencies
ssh2 adaptation check:  npm run verify:ssh2-adaptation
Build:                  npm run build
```

Substitute the focused-test workspace and path as needed. `format:check` checks
only the Git diff. The opt-in SSH E2E requires Docker Compose, OpenSSL,
`ssh-keygen`, Node.js/npm, and first-run network access for pinned Chromium.

## Mechanical quality gates

- CI installs locked dependencies, verifies the pinned `ssh2` adaptation, checks
  changed whitespace, audits the complete dependency graph, lints, type-checks,
  runs the default tests, and builds.
- Lint is type-aware across all TypeScript and TSX in the three workspaces,
  fails on warnings, and enforces independently measured cyclomatic and
  cognitive-complexity ceilings. Do not weaken a passing gate or broadly
  suppress failures.
- Every behavior change needs caller-visible coverage. Every bug fix needs a
  regression test that would fail without the fix. Cover success, rejection,
  boundary, cleanup, and error paths; mock external I/O outside explicit
  integration/E2E tests.
- Treat tests as evidence of the governing contract, not authority to redefine
  it. Resolve disagreements with specifications, decisions, and intent-bearing
  comments before changing behavior or tests.
- Keep affected governing docs, schemas, examples, and non-obvious comments in
  sync with behavior. Never claim an unrun check passed; explain any applicable
  check that could not run.

## Working agreement

- Before editing, inspect the current issue, worktree, applicable instructions,
  canonical docs, relevant implementation, tests, and Git history. Preserve
  unrelated user changes and determine why non-obvious code exists before
  removing it.
- Use GitHub Issues through `gh`. The canonical category labels are `bug` and
  `enhancement`; the canonical workflow labels are `needs-triage`, `needs-info`,
  `ready-for-agent`, `ready-for-human`, and `wontfix`.
- Follow this delivery flow: issue -> dedicated branch -> implementation and
  tests -> conventional commit(s) -> PR containing `closes #N` -> wait for all
  applicable CI -> `gh pr merge --squash --delete-branch`. Never commit directly
  to `main`, merge with another strategy, force-push `main`, or run destructive
  Git operations without explicit owner authorization.
- Do not report a Ticket delivered until its PR is merged, its issue is closed,
  and the final durable state on `main` has been verified.
- Prefer small, explicit, cohesive changes with flat control flow and focused
  responsibilities. Keep domain rules separate from network, filesystem,
  process, and clock I/O; inject those dependencies at testable boundaries.
- Use explicit types and runtime validation at public boundaries. Avoid `any`;
  isolate and explain unavoidable external constraints. Preserve error context
  and original causes, and never swallow errors silently.
- Run focused checks while developing and every applicable canonical gate before
  handoff. Inspect the exact final diff for unrelated changes, secrets, useful
  errors, test coverage, and synchronized documentation.

## Project-specific constraints

- Require the access gate, browser-bound device token, and short-lived,
  single-use terminal ticket. Validate exact allowed Origins at HTTP and
  WebSocket boundaries, and reject unauthorized upgrades before accepting the
  connection.
- Require explicit SSH host-key fingerprint confirmation for every session.
  Preserve SSH egress CIDR allowlisting, address-family checks, and canonical
  resolved-address pinning; do not weaken SSRF or DNS-rebinding defenses.
- Keep WebSocket compression disabled and protocol/input/output, rate,
  concurrency, backlog, and lifecycle limits bounded. Destroy the SSH channel
  and session when the browser connection closes.
- Never persist or log private keys, passphrases, raw tickets, auth cookies,
  Authorization headers, raw terminal input/output, or transcripts. Emit only
  safe normalized errors and metadata-only audit events. Test fixtures,
  snapshots, traces, and diagnostics must not expose auth material or terminal
  content.
- Access sessions, device tokens, terminal tickets, and limits are intentionally
  process-local and disposable. A restart invalidates them; do not imply
  persistence, multi-instance sharing, or session resume.
- Use HTTPS/WSS, secure cookies, exact public Origins, trusted proxy settings,
  edge protection, and explicit SSH egress policy outside loopback development.
  Do not weaken a security boundary to make a demo or test pass.
- The UI is dark, sparse, premium, and terminal-first. Follow
  `docs/design-tokens.md`; avoid generic dashboard chrome and Matrix-green
  branding.
- Code, documentation, comments, commits, issues, and PRs are written in English.
  Comments preserve rationale and constraints, not a narration of the code.
