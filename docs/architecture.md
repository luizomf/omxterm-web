# OMXTerm Web MVP architecture

OMXTerm Web is a browser SSH terminal, not a local sandbox terminal. Three
components talk to each other, and only the broker ever speaks SSH.

For a didactic, end-to-end walkthrough of the security flow (access gate →
device token → ticket → host-key → WebSocket → SSH/PTY), see
[`how-it-works.md`](./how-it-works.md), which also carries a step-by-step
sequence diagram of the request/response flow.

## Component map

```text
        BROWSER                      OMXTERM WEB BROKER                    SSH TARGET
   Vite / React / xterm.js          Node · Fastify · ws                      sshd
 ┌─────────────────────┐        ┌────────────────────────────┐        ┌──────────────┐
 │  access gate        │        │  POST /api/access          │        │              │
 │  SSH form           │ ─HTTP─►│  POST /api/ssh/host-key    │ ─SSH──►│  host key    │
 │  host-key screen    │        │  POST /api/terminal-ticket │        │              │
 │  terminal UI        │ ◄─WSS─►│  GET  /terminal/ws         │ ◄─────►│  PTY shell   │
 │                     │        │  ssh2 client (pinned IP)   │        │              │
 │  cookies: session,  │        │                            │        │  privileges  │
 │  device (HttpOnly)  │        │  in-memory: sessions,      │        │  decided     │
 │                     │        │  tickets, limits, audit    │        │  here        │
 └─────────────────────┘        └────────────────────────────┘        └──────────────┘

   1 token login → 2 probe host-key (SHA256 fp) → 3 issue ticket (60s, single-use)
   → 4 WSS upgrade + ticket → 5 ssh2 PTY ↔ shell.   Disconnect destroys the SSH session.
```

## Important boundaries

- The browser never speaks raw SSH directly.
- The backend validates access/session/device/origin/ticket before opening the
  terminal WebSocket.
- The private key/passphrase are not persisted by the MVP.
- SSH host key trust is explicit per session; persistent `known_hosts` is out of
  MVP scope.
- Remote privileges are controlled by the SSH target, not by OMXTerm Web.
