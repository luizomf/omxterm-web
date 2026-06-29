# OMXTerm

A browser-based SSH terminal MVP built with TypeScript, React, xterm.js,
Fastify, WebSocket, and `ssh2`.

OMXTerm is not a shell running in the browser. xterm.js renders the terminal UI;
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

```bash
cp .env.example .env
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
npm run typecheck
npm run test:run
npm run build
```

## Usage

Once it is running, see `docs/usage.md` for the operator walkthrough — access
token, SSH form, host-key confirmation, and what the terminal can do.

## Deploy

The defaults target `localhost`. Any deploy reachable over an untrusted network
must run behind HTTPS/WSS, because the auth cookies (`omxterm_session_*`,
`omxterm_device_*`) **are** the authentication and would otherwise travel in
cleartext. OMXTerm does not terminate TLS itself; put it behind a reverse proxy
(e.g. Traefik, Caddy, nginx) that does.

Required for a non-loopback deploy:

- `OMXTERM_SECURE_COOKIES=true` — marks the auth cookies `Secure` so they are
  only sent over HTTPS. The server **refuses to boot** when this is `false` while
  `OMXTERM_SERVER_HOST` is non-loopback, to prevent shipping cookies in the
  clear by accident.
- `OMXTERM_TRUST_PROXY` — set to the proxy's IP/CIDR (preferred) or `true` so the
  rate limiter keys on the real client and HTTPS is detected from
  `X-Forwarded-Proto`. Leave it unset on a directly exposed server, where
  `X-Forwarded-*` headers are spoofable.
- `OMXTERM_ALLOWED_ORIGIN` — add the public `https://` origin (comma-separated to
  keep others).
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

For a step-by-step container rollout behind a reverse proxy (Docker, compose,
Traefik, basic auth), see `docs/deploy.md`.

## Architecture notes

- `docs/architecture.md`
- `docs/adr/0001-typescript-node-fastify-vite.md`
- `CONTEXT.md`
