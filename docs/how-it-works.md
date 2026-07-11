# How OMXTerm works (the security flow)

OMXTerm is a **browser SSH terminal**: you open a web page, type into it, and
the keystrokes end up in a real shell on a server you chose. The hard part is
not drawing a terminal — it is doing that _without_ turning a public URL into an
open SSH proxy.

This document walks the whole path end to end, from "open the page" to "type
`whoami` in a remote shell". It is meant to be read top to bottom and is
detailed enough to onboard a new contributor. Every claim here matches the code;
file references point at the exact place each rule lives.

---

## The 30-second version

A naive browser terminal is dangerous: it can become an unauthenticated SSH
proxy, leak the private key, skip host-key verification, or log secrets. OMXTerm
defends each of those with one specific mechanism:

| Risk                                  | Defense                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone reaching the URL gets a shell  | **Access gate** token, rate-limited, timing-safe compare                                                                                                 |
| A cookie alone authorizes the socket  | **Single-use, 60s terminal ticket** bound to session + device + Origin                                                                                   |
| Another site opens the socket for you | **Exact Origin check** on every SSH call and on the WebSocket upgrade                                                                                    |
| The broker is aimed at internal hosts | **SSH egress allowlist** (opt-in CIDRs) checked before any dial, then the validated IP is **pinned** into the connection — blocks SSRF and DNS rebinding |
| You connect to an impostor server     | **Host-key fingerprint** shown first, then re-verified at connect time                                                                                   |
| One session exhausts the broker       | **Post-auth limits** — per-session rate caps on probes/tickets and per-session/global connection caps (429/409)                                          |
| The app becomes a credential vault    | Private key **never persisted** — held in memory only until the ticket is consumed                                                                       |
| Secrets leak into logs                | **Metadata-only audit** — no keys, no tickets, no terminal transcript                                                                                    |

The boundary OMXTerm promises is **safe brokering**. It does _not_ decide
whether your remote user is root — that is the SSH target's job (see
[What OMXTerm does not do](#what-omxterm-does-not-do)).

---

## End-to-end at a glance

Three actors: the **browser** (Vite/React/xterm.js), the **broker** (Node,
Fastify, and the `ws` library), and the **SSH target** (the server you own). The
broker is the only one that ever speaks SSH; the browser never does.

```text
Browser                          Broker (Fastify + ws)                 SSH target
  |                                    |                                    |
  | 1. POST /api/access {token} ------>| check token, rate-limit            |
  |    set cookies: session+device <---| create session + device token      |
  |                                    |                                    |
  | 2. POST /api/ssh/host-key -------->| Origin + auth check                |
  |                                    |---- probe host key (no login) ---->|
  |    fingerprint  <------------------|<--- server host key ---------------|
  |  (user eyeballs SHA256:... fingerprint and accepts)                     |
  |                                    |                                    |
  | 3. POST /api/terminal-ticket ----->| Origin + auth check                |
  |    (host, user, key, fingerprint)  | issue ticket (single-use, 60s)     |
  |    ticket  <-----------------------| key kept in memory inside the grant|
  |                                    |                                    |
  | 4. WS /terminal/ws?ticket=... ---->| BEFORE upgrade: Origin, cookies,   |
  |                                    | consume ticket (single-use)        |
  |                                    |---- ssh connect + verify key ----->|
  |    {type:ready}  <-----------------|<--- PTY shell allocated ---------->|
  |                                    |                                    |
  | 5. {input}/{resize}/{ping} <=====> | bridge stdin/stdout <===========> | shell
  |    {output}/{exit}/{pong}          | (destroy-on-disconnect)            |
```

Five steps, three short-lived secrets minted by the broker (access session,
device token, terminal ticket), and exactly one moment where the private key
crosses the wire (step 3) — after which it lives only in memory until step 4
consumes it.

---

## Step by step

### 0. Configuration (before anything runs)

The broker refuses to start with a weak gate. `loadConfig`
([`apps/server/src/config.ts`](../apps/server/src/config.ts)) reads:

- `OMXTERM_ACCESS_TOKEN` — **required**. `validateAccessToken` rejects known
  weak values (`change-me`, `password`, …) and anything shorter than 24
  characters. A default placeholder cannot be shipped by accident.
- `OMXTERM_ALLOWED_ORIGIN` — the browser origin(s) allowed to talk to the
  broker, comma-separated for more than one (e.g. localhost + a LAN IP).
  `parseAllowedOrigins` matches each entry exactly and rejects wildcards or
  malformed origins at boot. Default `http://localhost:5173`.
- `OMXTERM_SERVER_HOST` — bind address. Default `127.0.0.1` (loopback only; the
  broker is not on the LAN unless you opt in).
- `OMXTERM_SSH_ALLOWED_CIDR` — optional SSH egress allowlist (SSRF guard).
  Comma-separated IPv4/IPv6 CIDRs (a bare address is a single host) that the
  broker may connect to. `parseSshEgressAllowlist` validates entries at boot and
  rejects both the wildcard and an allow-all `/0` range. Unset means
  unrestricted (single-user/localhost); once set it is default-deny, so
  loopback, link-local (`169.254.169.254` metadata), and the public internet are
  blocked unless listed. Set it before using the broker as a jump host on a
  shared network.
- `OMXTERM_SECURE_COOKIES` — `true` sets the `Secure` flag on cookies (for
  HTTPS/WSS deployments).
- `OMXTERM_TRUST_PROXY` — trust a reverse proxy in front of the broker so
  `request.ip` is the real client (rate limiting) and HTTPS is detected from
  `X-Forwarded-Proto`. Accepts `true`/`false`, a hop count, or a trusted proxy
  IP/CIDR allowlist; leave it unset on a directly exposed server, where
  `X-Forwarded-*` headers are spoofable.
- `OMXTERM_AUDIT_LOG` — optional path for the JSONL audit log. When set, the
  broker creates the parent directory and proves the path is writable **once at
  startup**, failing fast with a useful boot error if it cannot. When unset,
  audit events go to stdout. After boot, a sink write that fails (e.g. the disk
  fills) is contained — it is reported once to stderr and never escapes a
  request/upgrade/WebSocket/SSH handler. The stdout sink additionally drops
  events while it is under backpressure (rather than buffering without bound),
  reporting the onset once; see the audit-log section below.
- `OMXTERM_WEB_ROOT` — optional path to the built web SPA. When set, the broker
  serves the SPA itself (single origin); unset in dev, where Vite serves it.

### 1. Access gate — `POST /api/access`

This is the only front door. The browser posts `{ accessToken }`.

The server, in order
([`apps/server/src/server.ts`](../apps/server/src/server.ts)):

1. **Checks Origin first.** The same exact `OMXTERM_ALLOWED_ORIGIN` allowlist
   used by the SSH calls and WebSocket upgrade is enforced here too. Bad or
   missing Origin → HTTP 403 and no cookies, so a cross-site request cannot mint
   an authenticated browser session.
2. **Rate-limits by client IP.** `InMemoryAccessRateLimiter` allows 10
   failed attempts per 60-second window
   ([`packages/core/src/stores.ts`](../packages/core/src/stores.ts)). The token
   is the single gate in front of an SSH proxy, so it has to resist brute force
   — a timing-safe compare blocks timing leaks, not guessing. Over the limit →
   HTTP 429 with `Retry-After`.
3. **Compares the token in constant time.** `safeEqualText` uses
   `timingSafeEqual`, so a wrong token takes the same time whether the first
   byte or the last byte is wrong. Wrong token → records a failure and
   returns 401.
4. **On success**, resets the limiter and mints two secrets:
   - an **access session** (`InMemoryAccessSessionStore`) — random opaque token,
     stored server-side as a SHA-256 hash, 12-hour TTL;
   - a **device token** (`InMemoryDeviceTokenStore`) — a second random
     per-browser secret bound to that session, also stored hashed, 12-hour TTL.

Both raw values, plus the session id, are written as three cookies
([`apps/server/src/cookies.ts`](../apps/server/src/cookies.ts)):
`omxterm_session_id`, `omxterm_session_token`, `omxterm_device_token` — all
`HttpOnly` (JavaScript cannot read them), `SameSite=Strict` (a foreign site
cannot make the browser send them), and `Secure` when configured.

> **Why two tokens?** The session says "this browser passed the gate." The
> device token is what later binds ticket issuance and the WebSocket upgrade to
> the _same_ browser. Only their **hashes** live on the server, so a leaked
> store dump cannot be replayed as a cookie.

`GET /api/me` is a cheap read that just reports whether the current cookies
still validate — the UI uses it to skip the gate on reload.

### 2. Host-key confirmation — `POST /api/ssh/host-key`

Before trusting a server, you should look at its fingerprint. The browser sends
`{ host, port }`; the server first runs the **Origin check** (`isOriginAllowed`
— an exact match against the `OMXTERM_ALLOWED_ORIGIN` allowlist) and the cookie
auth check. An authenticated probe is then **rate-limited per session**
(`InMemoryFixedWindowRateLimiter`, 30 probes/minute); over the cap returns `429`
with `Retry-After` and a `host_key_rejected` audit event, so one session can't
drive unbounded outbound handshakes. It then runs the **SSH egress check**
(`checkSshEgress` — resolves the host and rejects with `403` plus an
`ssh_egress_blocked` audit event when an allowlist is configured and the target
falls outside it), and only then probes the target. When the target is allowed,
the broker **pins the validated IP** (`sshDialHost`) and dials that address
rather than the hostname, so `ssh2` never re-resolves and a DNS rebind between
the check and the dial cannot redirect the connection (#26). The hostname is
kept for audit only; in unrestricted mode nothing is resolved, so the dial falls
back to the hostname (localhost demo).

`probeSshHostKey` ([`apps/server/src/ssh.ts`](../apps/server/src/ssh.ts)) opens
an ssh2 connection with a throwaway username, grabs the host key inside
`hostVerifier`, computes a `SHA256:<base64>` fingerprint, and **returns `false`
so it never authenticates** — it just reads the key and hangs up. The
fingerprint comes back to the browser, which shows it to the user.

The user eyeballs it (against what they know the server's key to be) and
accepts. There is no persistent `known_hosts` in the MVP: trust is **per session
only**, and the UI is honest about that.

### 3. Terminal ticket — `POST /api/terminal-ticket`

Now the browser sends the full connection profile: `host`, `port`, `username`,
`privateKey`, optional `passphrase`, and the `acceptedHostFingerprint` from
step 2. This is the **only** request that carries the private key.

After the same Origin + auth checks, the same **per-session rate limit** (30
tickets/minute — over the cap returns `429` with `Retry-After` and a
`ticket_rejected` audit event), and the same **SSH egress check** (so a ticket
is never issued for a target outside the allowlist — the validated IP is pinned
into the stored profile so the WebSocket connect dials exactly what was checked,
#26), `InMemoryTerminalTicketStore.issue` mints a **terminal ticket**
([`packages/core/src/stores.ts`](../packages/core/src/stores.ts)):

- random opaque value, stored as a SHA-256 hash;
- **60-second TTL** and **single-use**;
- bound to the **session id**, the **device-token hash**, and the **Origin**;
- it carries the connection profile (including the key) **in memory inside the
  grant**.

The browser receives `{ ticket, wsUrl: '/terminal/ws', expiresInSeconds: 60 }`.
Once it has the ticket the browser **drops the private key and passphrase from
its own React state** ([`apps/web/src/ui/App.tsx`](../apps/web/src/ui/App.tsx))
— they are no longer needed for the socket, so they don't linger in memory for
the whole terminal session.

> **Why a ticket instead of just the cookie?** Cookies are sent automatically by
> the browser, which is exactly what makes Cross-Site WebSocket Hijacking
> possible. A ticket is a deliberate, one-shot capability: short-lived, used
> exactly once, and tied to the session/device/Origin that requested it.

### 4. WebSocket upgrade — `GET /terminal/ws?ticket=...`

The browser opens the socket. Crucially, all authorization happens in the
`upgrade` handler **before** `wss.handleUpgrade` runs — a failed check destroys
the raw socket without ever creating a WebSocket
([`apps/server/src/server.ts`](../apps/server/src/server.ts)):

1. **Exact Origin** must be in the `OMXTERM_ALLOWED_ORIGIN` allowlist, else 403.
2. **Path** must be `/terminal/ws`.
3. **Cookies** (session + device) must validate, and a `ticket` query param must
   be present, else 401.
4. **Capacity caps** (`InMemoryConcurrencyLimiter`). A global limit on live
   WebSocket connections and a per-session limit on concurrent SSH sessions are
   acquired _before_ the ticket is consumed (so a capacity rejection doesn't
   burn the single-use ticket), else `409` plus a `ws_upgrade_rejected` audit
   event (reason `too_many_ws_connections` or `too_many_active_sessions`). Both
   slots are released when the socket closes.
5. **Consume the ticket.** `consume` rejects a ticket that is missing, expired,
   or already used, and then checks that the session id, Origin, and
   device-token hash match what the ticket was issued for. On success it stamps
   `usedAt` and **deletes the ticket immediately** — a replay finds nothing.

Only then does the upgrade complete and a `connection` open, carrying the grant
(with its in-memory profile) into the terminal bridge.

The WebSocket server itself is locked down: `perMessageDeflate` disabled and
`maxPayload` capped at 64 KB, because this is a terminal control channel, not a
file pipe.

### 5. The SSH bridge and the remote PTY

With the grant in hand, `SshTerminalSession.connect`
([`apps/server/src/ssh.ts`](../apps/server/src/ssh.ts)) finally dials the SSH
target — the **pinned IP** from the egress check, not the hostname (#26) — with
the profile's key (and passphrase, if any). Two things matter here:

- **The fingerprint is re-verified for real.** `hostVerifier` recomputes the
  fingerprint of the key the server actually presents and compares it to the
  `acceptedHostFingerprint` the user approved in step 2. The connection only
  proceeds if they match — the earlier "accept" was a promise, this is the
  enforcement.
- **A remote PTY is allocated** via `shell` (`xterm-256color`, initial 120×34),
  so full-screen tools like `vim`, `htop`, and `tmux` behave.

After `SshTerminalSession.connect` resolves, the bridge no longer needs the raw
secret in the WebSocket grant. The server immediately clears
`profile.privateKey` and the optional `profile.passphrase` from that grant, so a
successful terminal session does not keep those string references alive until the
socket closes. Like any JavaScript string scrub, this removes references and
shortens the GC window; it does not overwrite already-allocated V8 heap bytes.

From here the broker bridges the small JSON terminal protocol
([`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts)):

- **Client → server:** `input` (keystrokes), `resize` (cols/rows — control data,
  bounds-checked, never fed to the shell as input), `ping`.
- **Server → client:** `ready`, `output`, `error`, `exit`, `pong`.

`resize` is validated against a shared contract, `TERMINAL_SIZE_BOUNDS`
(`20–512` cols × `5–256` rows). That range covers realistic large layouts — a
2560×2160 CSS viewport fits ~304×128 cells at the shipped font — with headroom
for 4K panels and zoom, while still rejecting absurd dimensions (#80). The
frontend imports the same bounds and clamps its fitted grid through
`clampTerminalSize` before resizing xterm and sending, so the rendered grid and
the PTY never diverge. A rejected `resize` comes back as a scoped `error`
(`resize_out_of_bounds`); the client surfaces it but keeps the session
`connected` rather than failing the whole transport, since the PTY simply holds
its last valid size.

The broker also **bounds the inbound side** so an authenticated client cannot
outrun the SSH target or the audit sink (#77). The 64 KB `maxPayload` only limits
one frame; on top of it, each connection carries a fixed-window byte/message
budget, a strictly bounded input queue that honors SSH write backpressure (it
stops feeding stdin when `channel.write()` pushes back and resumes on `drain`),
and coalesces bursty `resize` events into at most one PTY resize + audit write
per event-loop turn — so a resize flood can't amplify into synchronous disk
writes. A sustained flood — message rate, byte rate, or a backlog against a
stalled channel — is closed with a `terminal_flood` audit event. Normal typing,
paste within the payload limit, resize, and Ctrl-C are untouched
([`apps/server/src/terminal-inbound-guard.ts`](../apps/server/src/terminal-inbound-guard.ts)).

Output is UTF-8 decoded per stream so a multi-byte character split across two
PTY chunks is reassembled instead of rendering as `�`
([`apps/server/src/terminal-output-decoder.ts`](../apps/server/src/terminal-output-decoder.ts),
fix for #11).

When the socket closes, the SSH channel and client are torn down and a
`session_ended` audit event (with byte counts) is written. This is
**destroy-on-disconnect**: a dropped tab does not leave an orphan SSH session
running. There is no reconnect/resume in the MVP.

---

## The four secrets, and where they live

| Secret               | Created at    | Stored as                         | Lives until                 | Travels in                  |
| -------------------- | ------------- | --------------------------------- | --------------------------- | --------------------------- |
| Access session token | step 1        | SHA-256 hash, server memory       | 12h TTL                     | `HttpOnly` cookie           |
| Device token         | step 1        | SHA-256 hash, server memory       | 12h TTL                     | `HttpOnly` cookie           |
| Terminal ticket      | step 3        | SHA-256 hash, server memory       | 60s / single use            | URL query param, once       |
| Private key          | typed by user | in memory inside the ticket grant | until SSH connect succeeds  | request body, once (step 3) |

The private key and optional passphrase are never written to disk, never logged,
and are cleared from the consumed grant once the SSH bridge is ready.

---

## What the audit log records

Audit is **metadata only** — security-relevant lifecycle, never terminal
content. The broker writes JSONL events
([`apps/server/src/audit-logger.ts`](../apps/server/src/audit-logger.ts)) such
as: `access_granted` / `access_rejected` (with a normalized reason like
`rate_limited` or `invalid_access_token`), `host_key_presented`,
`host_key_rejected` and `ticket_rejected` (post-auth rate limits, reason
`rate_limited`), `ssh_egress_blocked` (with the blocked host/port and reason),
`ticket_issued`, `ws_upgrade_rejected` (with reason, including
`too_many_ws_connections` and `too_many_active_sessions` for the capacity caps),
`ticket_consumed`, `session_started`, `resize`, `terminal_flood` (a
per-connection inbound flood was closed, with a normalized reason like
`inbound_message_rate`, `inbound_byte_rate`, or `inbound_backlog`), and
`session_ended` (with byte counts).

Notably absent: private keys, passphrases, raw tickets, cookies, and any
keystroke or terminal output.

**Metadata-only does not mean safe to publish.** The events intentionally
contain infrastructure metadata — target host and port, `Origin`, session IDs,
timestamps, and byte counts — that can reveal who connects where, when, and how
much. Treat the audit log as sensitive operational data: protect it like any
server log and review it before sharing outside the operators, rather than
assuming it is automatically public-safe.

The sink is deliberately simple for the MVP, and its two backends stay bounded
in different ways — neither keeps an in-memory queue that can grow without limit.
The **file sink** (`OMXTERM_AUDIT_LOG`) appends **synchronously**, so the OS
write buffer paces the writer (natural backpressure) and there is nothing to
accumulate. **stdout** (the default) is an **asynchronous** stream, so it has no
such natural bound: when its buffer fills, `write()` returns `false` and further
writes would keep buffering unboundedly. The stdout sink therefore switches to
**dropping audit events while congested** and resumes on the next `drain`. The
onset of a drop streak is reported once to stderr (never through the sink
itself), so lost lines are visible and never silently pretended successful. The
inbound guard above already caps terminal-event frequency, but not every audit
call site (e.g. access rejections), so this drop policy is what keeps stdout from
being amplified into unbounded memory. A durable or async audit pipeline and full
log rotation are out of scope.

---

## What OMXTerm does not do

Being honest about the boundary is part of the point:

- It does **not** decide your remote privileges. If you connect as root, that is
  your SSH target's configuration, not OMXTerm's doing.
- It does **not** keep a persistent `known_hosts` — host-key trust is per
  session.
- It does **not** save private keys, passphrases, connection profiles, or
  terminal transcripts.
- It is **single-process and in-memory** (no Redis/SQLite/Postgres), so sessions
  and tickets do not survive a restart and do not span instances.
- It does **not** reconnect or resume a dropped session.

These are deliberate MVP scope choices, documented in
[`docs/prd-mvp-web-ssh-terminal.md`](./prd-mvp-web-ssh-terminal.md). A
production version would add persistent host-key pinning, a durable shared
store, a stronger account model, and mature backpressure/lifecycle handling.

---

## Source map

| Concern                                        | File                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| HTTP routes, WS upgrade, bridge                | [`apps/server/src/server.ts`](../apps/server/src/server.ts)         |
| Sessions, device tokens, tickets, rate limiter | [`packages/core/src/stores.ts`](../packages/core/src/stores.ts)     |
| Host-key probe + SSH session + `hostVerifier`  | [`apps/server/src/ssh.ts`](../apps/server/src/ssh.ts)               |
| Cookie names and flags                         | [`apps/server/src/cookies.ts`](../apps/server/src/cookies.ts)       |
| Config and access-token validation             | [`apps/server/src/config.ts`](../apps/server/src/config.ts)         |
| Terminal protocol codec                        | [`packages/core/src/protocol.ts`](../packages/core/src/protocol.ts) |
| Browser API client                             | [`apps/web/src/api.ts`](../apps/web/src/api.ts)                     |

For the architecture overview and the visual diagram, see
[`architecture.md`](./architecture.md).
