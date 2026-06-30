# PRD: OMXTerm MVP — Browser SSH Terminal

## Problem Statement

Developers sometimes need a browser-accessible terminal for a VPS or SSH target,
especially for demos, remote work, dashboards, and agent-control surfaces. A
naive browser terminal is easy to make dangerous: it can become an
unauthenticated SSH proxy, leak private keys, silently skip SSH host
verification, or log terminal secrets.

The MVP needs to prove a real terminal session in the browser without pretending
to be a production SaaS. It must be small enough to implement quickly, visually
polished, and structured so future product directions can replace pieces without
rewriting the terminal emulator.

## Solution

Build OMXTerm as a TypeScript full-stack web app that brokers a browser terminal
to a user-provided SSH target.

The user passes an access gate, enters SSH connection inputs, confirms the SSH
host key fingerprint for the current session, and opens an interactive terminal
rendered with xterm.js. The backend connects to the SSH target, allocates a
remote PTY, and bridges terminal input/output over WebSocket using a small
explicit protocol.

The MVP deliberately does not save SSH credentials, known_hosts entries,
connection profiles, terminal transcripts, or user accounts. It uses
process-local in-memory stores behind interfaces so Redis, SQLite, Postgres,
OAuth, saved profiles, or persistent host-key pinning can be added later.

The UI should feel like a premium developer tool: dark, sparse, terminal-first,
with the project's cyan/teal terminal palette. No Matrix-green branding, no fake
dashboards, no gratuitous metrics.

## User Stories

1. As a user, I want to see a real terminal running in the browser, so that it
   is clearly a real shell and not a fake textarea.
2. As a developer, I want to connect to an SSH target from the browser, so that
   I can use a terminal without opening a desktop terminal app.
3. As a developer, I want to provide host, port, username, private key, and
   optional passphrase, so that I can connect to my own server.
4. As a developer, I want to paste a private key or load it from a local file,
   so that entering credentials is not unnecessarily painful.
5. As a security-conscious user, I want private keys to be used only for the
   connection attempt/session, so that the app does not become a credential
   vault in disguise.
6. As a security-conscious user, I want the app not to log private keys,
   passphrases, tickets, cookies, Authorization headers, or terminal
   transcripts, so that sensitive data is not accidentally retained.
7. As a product owner, I want a simple access gate before the SSH form, so that
   a public URL does not become an open SSH proxy.
8. As a product owner, I want a device token bound to the browser session, so
   that terminal ticket issuance and WebSocket upgrade are tied to the same
   browser that passed the access gate.
9. As a security-conscious user, I want the SSH host key fingerprint shown
   before the terminal opens, so that the MVP does not silently auto-accept host
   identity.
10. As a security-conscious user, I want to explicitly trust the host key for
    this session only, so that the MVP is honest without pretending to maintain
    persistent known_hosts.
11. As a developer, I want the terminal to resize correctly, so that full-screen
    tools like vim, top, less, htop, tmux, and nano behave properly.
12. As a developer, I want terminal input to go to the SSH session and terminal
    output to render through xterm.js, so that normal shell interaction works.
13. As a developer, I want visible connection states, so that I can tell whether
    the terminal is disconnected, connecting, waiting for host-key trust,
    connected, closing, or errored.
14. As a developer, I want an explicit disconnect/end-session control, so that I
    can intentionally close the SSH session.
15. As a product owner, I want destroy-on-disconnect behavior in the MVP, so
    that dropped sockets do not leave surprise SSH sessions running.
16. As a product owner, I want short-lived single-use WebSocket tickets, so that
    WebSocket upgrade is not authorized by cookie alone.
17. As a security-conscious reviewer, I want exact Origin validation on
    WebSocket upgrade, so that Cross-Site WebSocket Hijacking is addressed.
18. As a security-conscious reviewer, I want `permessage-deflate` disabled and
    payload limits enforced, so that the terminal transport avoids unnecessary
    compression and memory risk.
19. As a product owner, I want metadata audit events, so that the demo can show
    security-relevant lifecycle without storing raw terminal content.
20. As a developer, I want the terminal emulator component decoupled from
    SSH/product flow, so that the same UI can later drive Hermes CLI, local PTY,
    container exec, or another backend.
21. As a future maintainer, I want access/session/ticket stores behind
    interfaces, so that in-memory MVP storage can be replaced without changing
    app behavior.
22. As a future maintainer, I want the terminal protocol codec behind an
    interface, so that JSON can later evolve into binary framing without
    rewriting broker logic.
23. As a product owner, I want a minimal premium UI, so that the product looks
    credible without wasting time on fake SaaS chrome.
24. As a user, I want safe example commands, so that I can prove a real SSH
    terminal without showing secrets or relying on root access.
25. As a developer, I want regression tests for the main security/lifecycle
    rules, so that later changes do not quietly break tickets, device binding,
    cleanup, protocol validation, or terminal component boundaries.

## Implementation Decisions

- Use TypeScript across the project.
- Use a small monorepo shape with separate web app, server app, and shared core
  package.
- Use Vite + React for the browser UI.
- Use Node.js + Fastify + `ws` for the server HTTP and WebSocket layer.
- Use `ssh2` for SSH client behavior and remote PTY allocation.
- Use xterm.js and FitAddon for the browser terminal emulator.
- Pin xterm.js-related packages rather than floating major/minor versions during
  the MVP.
- Do not use Socket.IO; the terminal transport needs a small explicit protocol
  over standard WebSocket.
- Do not use xterm.js AttachAddon in the MVP final implementation; it bypasses
  the app's auth, resize, audit, and lifecycle protocol.
- Use JSON messages for the MVP protocol because they are easier to test and
  debug. Keep protocol encoding behind a codec port so binary framing can
  replace it later.
- MVP client messages are input, resize, and ping.
- MVP server messages are ready, output, error, exit, and pong.
- Validate all incoming protocol messages at runtime; TypeScript types alone are
  not a boundary.
- Enforce resize bounds; resize is control data, never shell input.
- Use a reusable terminal emulator component that knows xterm.js, theme,
  fit/resize behavior, status UI, input/output, and lifecycle hooks.
- The terminal emulator component must not know about SSH credentials, access
  tokens, device tokens, terminal tickets, host-key confirmation, or
  product-specific flows.
- Use a terminal transport adapter interface on the frontend. The MVP adapter
  speaks OMXTerm WebSocket protocol.
- Use an access token configured by environment variable as the MVP access gate.
- After a valid access gate, create secure HttpOnly SameSite cookies for an
  access session and a random device token.
- The device token is a random per-browser secret, not fingerprinting.
- Use short-lived single-use terminal tickets before WebSocket upgrade.
- Bind terminal tickets to access session hash, device token hash, Origin,
  scope, and expiry.
- Store access sessions, device tokens, and terminal tickets in process memory
  for the MVP.
- Keep store behavior behind ports so Redis, SQLite, or Postgres can replace
  in-memory storage later.
- Reject WebSocket upgrades before `handleUpgrade` when
  Origin/session/device/ticket validation fails.
- Validate exact Origin on access, SSH API calls, and WebSocket upgrade.
- Disable WebSocket `permessage-deflate` explicitly.
- Set small incoming payload limits appropriate for terminal control/input, not
  the large `ws` default.
- Use WSS/HTTPS in public deployment. Local development may use HTTP/WS only for
  local testing.
- Use destroy-on-disconnect in the MVP: when WebSocket closes, close SSH
  channel/session and emit audit metadata.
- Do not implement reconnect/resume in the MVP. A short grace period may be a
  future feature, but it needs explicit session identity, authorization recheck,
  and output replay/buffer decisions.
- Do not persist private keys, passphrases, SSH connection profiles, terminal
  transcripts, or known_hosts entries in the MVP.
- Show SSH host key fingerprint and require explicit user confirmation before
  continuing the SSH session.
- Host key trust is session-only in the MVP. Persistent known_hosts/TOFU is out
  of scope but should be called out honestly in the docs.
- Audit metadata only: access gate result, ticket issued, WebSocket upgrade
  rejected/accepted, host key fingerprint presented/accepted, session started,
  resize, session ended, byte counts where practical, and normalized failure
  reasons.
- Do not log raw terminal input/output by default.
- Redact or avoid logging values named or shaped like token, ticket, key,
  password, passphrase, cookie, authorization, private key, or secret.
- Product responsibility ends at safe brokering and credential handling.
  Permissions on the SSH target are defined by that target's SSH server, user,
  sudo policy, and operating system.
- The MVP does not promise to prevent a user from connecting as root; it must
  explain that remote privileges are the user's responsibility.
- UI direction: dark premium terminal-first product, using the OMXTerm palette
  with cyan/teal primary accent, blue/purple support, and green reserved for
  ANSI or semantic success only.
- Initial UI flow: access gate, connection gate, host-key confirmation, focused
  terminal view.
- After connection, the terminal should occupy most of the UI with a minimal
  top/status bar.
- Example commands: `whoami`, `hostname`, `pwd`, `uname -a`, `date`, `ls`,
  `echo "$SSH_CONNECTION"`, and an ANSI color printf to prove terminal
  rendering.

## Testing Decisions

Good tests in this project should assert security and lifecycle behavior, not
fragile implementation details. Tests should avoid exact copy assertions, CSS
class assertions, generated IDs, timestamps, log message prose, and internal
call shapes unless those details are part of a public contract.

Regression tests should use fakes for time, SSH connector, terminal transport,
audit logger, and stores. Unit tests must not connect to real SSH servers or
depend on real network services.

Modules to test:

- Access gate/session behavior:
  - valid access token creates a session;
  - invalid access token rejects;
  - expired/missing session rejects protected actions.
- Device token behavior:
  - device token is generated and validated through hash comparison;
  - mismatch rejects terminal ticket issuance and WebSocket upgrade.
- Terminal ticket behavior:
  - ticket has TTL;
  - ticket is single-use;
  - expired ticket fails;
  - reused ticket fails;
  - session/device/origin mismatch fails;
  - raw ticket is not returned or logged after issuance beyond the one response.
- WebSocket upgrade authorization:
  - missing ticket rejects before connection handling;
  - wrong Origin rejects;
  - invalid session/device rejects;
  - valid grant reaches the WebSocket connection handler.
- Protocol codec:
  - valid input/resize/ping messages parse;
  - malformed JSON rejects safely;
  - unknown message type rejects safely;
  - resize bounds are enforced;
  - oversized payload path is covered at the server boundary.
- Terminal broker:
  - connector is not created before authorization succeeds;
  - input forwards to connector;
  - connector output forwards to transport;
  - resize forwards after validation;
  - close/error cleans up connector;
  - SSH errors become safe client errors and audit metadata.
- SSH connector seam:
  - host key fingerprint event is emitted before session opens;
  - user confirmation allows session continuation;
  - rejection/close aborts cleanly;
  - private key/passphrase are not logged by connector-owned errors.
- Terminal emulator component:
  - renders with a fake transport adapter;
  - sends input via the adapter when xterm emits data;
  - sends resize via the adapter when layout changes;
  - shows major states by accessible state/role rather than brittle copy;
  - has no dependency on SSH/auth/ticket modules.

Testing tools:

- Vitest for core/server/frontend logic.
- React Testing Library for minimal terminal component behavior where practical.
- Playwright smoke test is optional/stretch after the happy path works.

Verification before declaring the MVP done:

- TypeScript check passes.
- Unit/regression tests pass.
- Build passes.
- Manual smoke with a real SSH target succeeds.
- Manual negative checks cover bad access token, bad Origin or simulated upgrade
  rejection, reused ticket, and host-key confirmation path.
- Manual audit review confirms no private key, passphrase, raw ticket, cookie,
  Authorization header, or terminal transcript is logged.

## Out of Scope

- Production SaaS hardening.
- Multi-user account system.
- OAuth.
- Saved SSH profiles.
- Persistent private-key storage.
- Persistent known_hosts / TOFU / host-key pinning.
- Redis, SQLite, Postgres, or shared session storage.
- Multi-instance deployment or sticky-session/load-balancer support.
- Resume/reconnect grace period.
- Output replay, asciicast, transcript recording, or full audit dashboard.
- Collaboration, observers, shared sessions, or multi-tab attach semantics.
- WebTransport.
- Socket.IO.
- Binary terminal protocol framing.
- Sophisticated ACK-based backpressure.
- SSH agent integration.
- ProxyJump, port forwarding, SFTP, tunnels, or command policy.
- Container sandboxing or local PTY execution.
- Hermes CLI terminal adapter.
- Publishing the terminal emulator as an npm package.
- Admin panel.
- Public anonymous terminal access.
- A claim that OMXTerm controls privileges on the SSH target.

## Further Notes

The documentation should be explicit about the MVP security boundary:

- The app brokers a terminal to a user-provided SSH target.
- The app does not decide whether the remote user is root; SSH target
  configuration decides that.
- The MVP does not save private keys.
- The MVP does not keep persistent known_hosts yet; it shows a fingerprint and
  asks for session-only trust.
- The MVP uses in-memory sessions/tickets and is single-process.
- A production version would add persistent host-key pinning, stronger
  account/auth model, durable/shared store, and more mature
  lifecycle/backpressure handling.
