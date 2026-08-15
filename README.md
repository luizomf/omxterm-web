# OMXTerm Web

A browser-based SSH terminal MVP built with TypeScript, React, xterm.js,
Fastify, WebSocket, and `ssh2`.

OMXTerm Web is not a shell running in the browser. xterm.js renders the terminal UI;
the backend brokers a WebSocket connection to a real SSH session on a
user-provided target.

## MVP scope

- Access gate with an environment-configured token.
- Device token bound to the browser session.
- Short-lived, single-use terminal tickets for WebSocket upgrade.
- Exact Origin validation.
- SSH connection from user-provided host, port, username, private key, and
  optional passphrase.
- SSH host-key fingerprint confirmation before opening the session.
- xterm.js terminal UI with resize support.
- Metadata-only audit logs.
- No saved private keys, saved profiles, persistent known_hosts, or raw
  transcripts.

See the PRD:

- `docs/prd-mvp-web-ssh-terminal.md`

## Design direction

Dark, sparse, premium, terminal-first. The palette is defined in:

- `docs/design-tokens.md`

Think: nerd in a tuxedo, not Matrix-green Bootstrap.

## Local development

Use Node.js `22.12+` or the tested Node.js 24 LTS line with npm 10 or newer.

```bash
cp .env.example .env
# Set OMXTERM_ACCESS_TOKEN in .env to a strong value before the first run; the
# placeholder is rejected at boot. Generate one with: openssl rand -base64 32
npm install
./scripts/run
```

Or run the processes separately:

```bash
npm run dev:server
npm run dev:web
```

Open `http://localhost:5173`.

Useful checks:

```bash
npm run format:check
npm run typecheck
npm run test:run
npm run build
npm audit --omit=dev
```

### Disposable browser-to-SSH E2E

The opt-in end-to-end check exercises a real browser, the production-like
OMXTerm Web image, and a repository-configured OpenSSH fixture without using a real
SSH host or user credentials:

```bash
npm run test:e2e:ssh
```

Prerequisites are Docker with Compose, Node.js/npm, OpenSSL, `ssh-keygen`, and
internet access the first time Playwright installs its pinned Chromium build.
Expect the first run to take several minutes while three local images build;
subsequent runs reuse Docker and Playwright caches. This command remains outside
the default fast test suite.

Each invocation creates a unique Compose project, access token, client key,
host key, loopback browser port, and OS temp directory. The browser reaches only
`127.0.0.1` through a non-root TCP gateway; the OMXTerm Web process and SSH fixture
share only an `internal` Docker network with no published SSH port. The broker's
SSH egress allowlist contains only the fixture's run-specific address. The test
calculates the expected fingerprint from the generated host public key
independently, confirms it in the browser, opens a PTY, runs a deterministic
sentinel command, and checks both initially hidden terminal bars can be reopened
independently.

Cleanup traps are installed before credentials or containers are created.
Success, test failure, timeout, and interruption tear down project containers,
networks, volumes, local images, generated environment state, and keys, then
verify no project-scoped Docker resource or temp directory remains. Browser
traces, screenshots, and videos are disabled. Before captured diagnostics are
displayed or success is reported, the harness checks for the complete generated
access token, the OpenSSH private-key header, and its sampled private-key marker;
a detection or scan error withholds diagnostics and fails the run. A ten-minute
deadline terminates a hung build, Docker wait, browser installation, or browser
test together with its child process group, then starts bounded teardown.
Contributors diagnosing a slow local daemon can override it with a positive
`OMXTERM_E2E_TIMEOUT_SECONDS` value. Prerequisite checks and local
credential/subnet preparation happen before any Docker resource exists and are
not included in that runtime deadline. Repository/temp paths, restrictive temp
permissions, generated credential paths, keys, fingerprint, subnet, and
loopback port are validated before startup; preparation failure cleans up any
synthetic credential material. Docker and Compose operations after startup
begins, including isolation inspection, log capture, and teardown, are bounded;
teardown has a separate one-minute aggregate deadline so it can still run after
the main deadline expires.

Troubleshooting:

- If Docker startup fails, verify `docker info` and `docker compose version`.
- If Chromium installation fails, restore network access and run the command
  again; Playwright reuses a successful browser download.
- An address-overlap failure is intentional fail-closed behavior. Retry to get a
  different run-specific isolated subnet; do not weaken the SSH allowlist.
- After an interrupted run, the final `cleanup verified` line confirms the
  disposable project and credentials were removed.

## Usage

Once it is running, see `docs/usage.md` for the operator walkthrough — access
token, SSH form, host-key confirmation, and what the terminal can do.

## Deploy

The defaults target `localhost`. Any deploy reachable over an untrusted network
must run behind HTTPS/WSS, because the auth cookies (`omxterm_session_*`,
`omxterm_device_*`) **are** the authentication and would otherwise travel in
cleartext. OMXTerm Web does not terminate TLS itself; put it behind a reverse proxy
(e.g. Traefik, Caddy, nginx) that does.

**Before exposing OMXTerm Web on a public hostname**, know the difference
between what the broker rate-limits itself (access-gate brute force,
post-auth probe/ticket abuse, concurrent sessions/connections) and what it
does not defend against (botnets, volumetric/distributed DoS, TLS). OMXTerm Web
makes no DDoS-resistance claim — application limits complement edge rate
limiting, firewalling, your provider's DDoS protection, and a WAF where
appropriate; they do not replace them. See
[`docs/public-exposure.md`](./docs/public-exposure.md) for the full model,
`OMXTERM_TRUST_PROXY` failure modes, and an optional edge rate-limit recipe.

Required for a non-loopback deploy:

- `OMXTERM_SECURE_COOKIES=true` — marks the auth cookies `Secure` so they are
  only sent over HTTPS. The server **refuses to boot** when this is `false`
  while `OMXTERM_SERVER_HOST` is non-loopback, to prevent shipping cookies in
  the clear by accident.
- `OMXTERM_TRUST_PROXY` — set to the proxy's IP/CIDR (preferred) or `true` so
  the rate limiter keys on the real client and HTTPS is detected from
  `X-Forwarded-Proto`. Leave it unset on a directly exposed server, where
  `X-Forwarded-*` headers are spoofable.
- `OMXTERM_ALLOWED_ORIGIN` — add the public `https://` origin (comma-separated
  to keep others).
- `OMXTERM_SERVER_HOST` — `0.0.0.0` (or the proxy-facing interface) so the proxy
  can reach it.
- `OMXTERM_SSH_ALLOWED_CIDR` — the egress allowlist for the hosts the broker may
  SSH into (see issue #4).

In production the broker can also serve the built web SPA itself (one origin) by
setting `OMXTERM_WEB_ROOT` to the web build output; the Docker image does this
for you. Locally, leave it unset and Vite serves the web.

Security headers (CSP and friends) are applied via `@fastify/helmet`. See
`.env.example` for every variable and `docs/how-it-works.md` for the security
model.

The tracked `compose.yml` is a portable, safe-by-default baseline: a fresh clone
with a valid local `.env` runs with `docker compose up -d --build`, needs no
pre-created network, and publishes the broker only on `127.0.0.1:3000` so you
place any HTTPS reverse proxy in front of it deliberately. The maintainer's
app-scoped rollout (reverse proxy in its own stack, reached over a shared Docker
network) layers `compose.prod.yml` on top:

```bash
docker compose --project-name omxterm-web -f compose.yml -f compose.prod.yml \
  up -d --build --wait --wait-timeout 120
```

Both paths impose finite broker-container defaults of 512 MiB memory, 256
PIDs/tasks, and 4096 open files. Operators can tune them without source edits
through the non-secret `OMXTERM_BROKER_MEMORY_LIMIT`,
`OMXTERM_BROKER_PIDS_LIMIT`, and `OMXTERM_BROKER_NOFILE_LIMIT` values in `.env`.
The ceilings do not raise the broker's application concurrency caps. Resource
exhaustion can fail work or terminate/restart the process; because all sessions
and tickets are in memory, a restart loses them and OMXTerm Web does not resume
terminal sessions.

For a step-by-step container rollout behind a reverse proxy (Docker, Compose,
Traefik, basic auth), including resource sizing and exhaustion behavior, see
`docs/deploy.md`.

## Architecture notes

- `docs/architecture.md`
- `docs/adr/0001-typescript-node-fastify-vite.md`
- `CONTEXT.md`
