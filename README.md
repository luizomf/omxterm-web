# OMXTerm

A browser-based SSH terminal MVP built with TypeScript, React, xterm.js, Fastify, WebSocket, and `ssh2`.

OMXTerm is not a shell running in the browser. xterm.js renders the terminal UI; the backend brokers a WebSocket connection to a real SSH session on a user-provided target.

## MVP scope

- Access gate with an environment-configured token.
- Device token bound to the browser session.
- Short-lived, single-use terminal tickets for WebSocket upgrade.
- Exact Origin validation.
- SSH connection from user-provided host, port, username, private key, and optional passphrase.
- SSH host-key fingerprint confirmation before opening the session.
- xterm.js terminal UI with resize support.
- Metadata-only audit logs.
- No saved private keys, saved profiles, persistent known_hosts, or raw transcripts.

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

## Architecture notes

- `docs/adr/0001-typescript-node-fastify-vite.md`
- `CONTEXT.md`

