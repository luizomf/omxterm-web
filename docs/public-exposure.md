# Exposing OMXTerm publicly

OMXTerm's own request handling is safe to put behind a public hostname: it
validates the access token, rate-limits abuse, and caps concurrency without
help from anything in front of it. That is a different claim from "safe to
put on the public internet with no edge protection." This document is about
that gap — what the broker already does, what it deliberately does not do,
and what to add at the edge before you point a real domain at it.

This guide is proxy-agnostic. It uses Traefik for the one worked example,
matching [`docs/deploy.md`](./deploy.md), but the same ideas apply to nginx,
Caddy, a cloud load balancer, or a CDN in front of any of them.

---

## What OMXTerm protects against, on its own

These controls run inside the broker itself, regardless of what proxy (if
any) sits in front of it. See [`how-it-works.md`](./how-it-works.md) for the
full request flow; this is the abuse-control summary:

- **Access gate token**, timing-safe compared, is the single front door
  (`POST /api/access`).
- **Failed-login rate limit**: 10 failed attempts per 60-second window, keyed
  per client IP. A successful login resets the budget for that client. Over
  the limit returns `429` with `Retry-After`
  (`apps/server/src/server.ts`, `ACCESS_GATE_MAX_FAILURES` /
  `ACCESS_GATE_WINDOW_MS`).
- **Post-auth per-session and per-client rate limits**: once a browser has a
  valid session, host-key probes and terminal-ticket issuance are each capped
  at 30 per minute for both the session and `request.ip`. A new login cannot
  reset the client budget. Over the limit returns `429` with `Retry-After` and
  an audit event (`host_key_rejected` / `ticket_rejected`).
- **Concurrency caps**: 5 active SSH sessions per browser session, and 50
  active WebSocket connections globally. Exceeding either returns `409`
  before the single-use ticket is consumed, with a `ws_upgrade_rejected`
  audit event (`too_many_active_sessions` / `too_many_ws_connections`).
- **WebSocket heartbeat**: the broker sends a protocol-level ping every 30
  seconds and terminates a connection that misses the next pong, so a dead or
  half-open peer cannot retain a global slot indefinitely.
- **Inbound flood guard**: once a terminal WebSocket is open, an
  authenticated client is still bounded — 512 messages/second, 2 MB/second,
  and at most 1 MB of input queued against a backpressured SSH channel. A
  sustained flood closes the socket with WebSocket close code `1008` and a
  `terminal_flood` audit event. Normal typing, paste, resize, and Ctrl-C are
  unaffected.
- **Exact Origin allowlist** (`OMXTERM_ALLOWED_ORIGIN`) on state-changing
  authenticated HTTP calls and on the WebSocket upgrade. The read-only
  `/api/me` boot probe permits a missing Origin but rejects an explicitly bad
  one.

All of this is real protection against a misbehaving or malicious
**browser client** that has (or is trying to get) a session. It is not
protection against everything that can reach a public port.

## What these controls do not protect against

Be precise about the boundary, because it is easy to over-read "rate
limited" as "DoS-resistant":

- **Scale beyond one client.** The failed-login limiter is keyed per client
  IP. A botnet with thousands of source IPs can each get 10 free guesses,
  which adds up to a real credential-stuffing campaign against the access
  token even though each individual IP is capped.
- **Volumetric or distributed denial of service.** Nothing in the broker
  defends against a flood of traffic large enough to saturate the network
  link, exhaust connection tables at the OS/proxy level, or overwhelm TLS
  handshakes before a request ever reaches OMXTerm's own rate limiters.
  **OMXTerm makes no DDoS-resistance claim, full stop.**
- **TLS.** OMXTerm does not terminate TLS. Without a reverse proxy doing
  HTTPS/WSS in front of it, the auth cookies (which _are_ the authentication)
  travel in cleartext. See the README "Deploy" section and
  `assertSafeCookieDeployment` in `apps/server/src/deploy-safety.ts`, which
  refuses to boot with `OMXTERM_SECURE_COOKIES=false` on a non-loopback bind.
- **Non-browser clients in general.** See the Origin section below — Origin
  checks are a browser-only mechanism.

If you are putting OMXTerm on a hostname reachable from the open internet,
treat the in-app limits as the **last** line of defense, not the only one.

## Why public deploys need HTTPS and edge rate limiting

Two things are true at once:

1. OMXTerm's application-level limits are real and effective against an
   individual abusive client.
2. They were sized and scoped for a single-user/small-team MVP broker, not
   for standing alone against internet-scale abuse.

Application limits **complement** edge protection; they do not **replace**
it. Before exposing a real domain, put in front of OMXTerm whichever of these
your environment already gives you:

- A reverse proxy or load balancer terminating **TLS** (required — see
  above).
- **Edge rate limiting or connection limiting**, so abusive traffic is
  shaped before it reaches the broker's own limiters (see the recipes
  below).
- Your **hosting/CDN provider's DDoS protection**, if you have one — this is
  the layer actually designed to absorb volumetric and distributed attacks,
  which is out of scope for both OMXTerm and a single reverse-proxy rate
  limit rule.
- A **WAF**, where your threat model calls for one (e.g. the deploy is
  reachable from an untrusted network segment, or you want protocol-level
  filtering ahead of the broker).

None of this is bundled with OMXTerm. It is deliberately left to whatever
edge you already operate, because the right answer depends on your
infrastructure (bare server vs. managed load balancer vs. CDN) far more than
on anything the broker itself could decide.

## Real client IP handling: `OMXTERM_TRUST_PROXY`

Rate limiting only works if `request.ip` is the real client. Behind a
reverse proxy, that means trusting `X-Forwarded-For` — but only from a proxy
you actually control, because that header is trivially spoofable by anyone
who can reach the broker directly.

`OMXTERM_TRUST_PROXY` (`apps/server/src/deploy-safety.ts`, `parseTrustProxy`)
controls this. It defaults to `false` (unset), and accepts `true`, a hop
count, or — preferred — a trusted proxy IP/CIDR allowlist. It affects both
rate-limiting (`request.ip`) and HTTPS detection (`X-Forwarded-Proto`).

Both misconfigurations are real failure modes, in opposite directions:

- **Left unset behind a real proxy.** Every request arrives from the proxy's
  own IP, so `request.ip` is the same address for every client. The
  failed-login limiter (and the post-auth limiters) now key on one shared
  bucket: one abusive client can burn the whole budget and lock out every
  other client behind that proxy, and per-client limiting stops meaning
  anything.
- **Trusted too broadly** (`true`, or a hop count) when untrusted parties
  can reach the broker's port directly — e.g. it is also exposed on a LAN or
  a Docker network anyone can join. `X-Forwarded-For` is just a request
  header; anyone who can reach the port can set it to whatever they want,
  including a different fake IP on every request. With trust turned on but
  no actual proxy enforcing the header, an attacker rotates IPs at will and
  the per-client rate limits stop limiting anything.

The safe pattern is: only turn on `OMXTERM_TRUST_PROXY`, and only trust the
exact address(es) the real proxy connects from (its Docker network subnet,
or its host IP), never a blanket `true` on a shared or multi-tenant host. See
[`docs/deploy.md`](./deploy.md) for the concrete subnet-discovery commands
for both Compose topologies.

## Origin validation is a browser boundary, not bot authentication

`OMXTERM_ALLOWED_ORIGIN` is an exact-match allowlist enforced on every
state-changing authenticated HTTP call and on the WebSocket upgrade. The
read-only `/api/me` boot probe permits a missing Origin because same-origin GET
requests commonly omit it, but still rejects an explicitly bad Origin. This is
real, load-bearing protection against **cross-site browser attacks**: another
website cannot open a hidden request or WebSocket to your OMXTerm broker using
a logged-in visitor's cookies, because browsers attach the real page Origin
and cannot be told to lie about it.

It is not authentication against a script, curl, or a bot. Nothing stops a
non-browser client from sending any Origin header it likes — Origin is a
browser-enforced convention, not a proof of identity. Do not treat "Origin
checks passed" as "this request came from a real user." The access token,
rate limits, and edge controls in this document are what actually gate
non-browser traffic; Origin only closes the cross-site-browser hole.

## Basic Auth as an optional private-preview layer

[`docs/deploy.md`](./deploy.md) documents adding HTTP Basic Auth at the
reverse proxy, in front of OMXTerm's own access gate. This is **optional**,
useful while a deploy is still a private preview and you want a coarse
extra barrier before anyone reaches the access-token prompt at all. It is
not a substitute for the access gate, and it is not required for a public
deploy — treat it as one more layer you can add cheaply if you want it,
not a documented requirement.

## Logging hygiene: this extends to the edge too

OMXTerm's own audit log is metadata-only: no private keys, passphrases, raw
tickets, cookies, or terminal transcripts ever reach it (see
[`how-it-works.md`](./how-it-works.md#what-the-audit-log-records)). That
discipline does not automatically extend to anything you put in front of
the broker.

Reverse proxy and edge access logs commonly capture full request URLs,
query strings, and sometimes headers or bodies by default. Terminal
tickets travel as a URL query parameter on the WebSocket upgrade
(`GET /terminal/ws?ticket=...`), and the access token and cookies are sent as
request bodies/headers. If your proxy's access log records the full request
line, headers, or body, it can capture exactly the secrets OMXTerm's own
audit log deliberately omits. Configure proxy/edge/WAF logging the same way:
no request bodies, no `Authorization`/cookie headers, and no full query
strings on the ticket-bearing WebSocket path.

## Optional edge recipe: Traefik v3 router-scoped rate limit

One optional recipe among many, not something OMXTerm depends on or ships.
It rate-limits requests to the OMXTerm router only, so it cannot affect any
other route your Traefik instance serves. Add it to the same dynamic
configuration file used in [`docs/deploy.md`](./deploy.md) step 5, scoping
the new middleware to the existing `omxterm` router:

```yaml
http:
  middlewares:
    omxterm-ratelimit:
      rateLimit:
        average: 20 # sustained requests/second allowed
        burst: 40 # short burst allowance above average
        period: 1s

  routers:
    omxterm:
      rule: 'Host(`omxterm.example.com`)'
      entryPoints:
        - websecure
      tls:
        certResolver: le
      middlewares:
        - omxterm-auth
        - omxterm-ratelimit
      service: omxterm
```

If you are not using the optional private-preview BasicAuth, remove
`omxterm-auth` from the router's middleware list; keep `omxterm-ratelimit`.

Tune `average`/`burst` to your expected traffic; the values above are a
starting point, not a recommendation. This complements, and does not
replace, OMXTerm's own per-client limiters and any DDoS protection your
hosting provider offers.

If you use a different proxy:

- **nginx**: `limit_req_zone` + `limit_req` on the OMXTerm `location` block
  achieves the same router-scoped effect.
- **Caddy**: a rate-limit plugin (e.g. `caddy-ratelimit`) scoped to the
  OMXTerm site block is the equivalent.

Neither is spelled out here in full — the Traefik example above is the one
worked recipe; the mechanism (edge-level, router/route-scoped, tunable
rate) is what matters, not the specific proxy.
