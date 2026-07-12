# Deploying OMXTerm

This is the runbook for putting OMXTerm behind a reverse proxy on a server. It
walks one concrete example — a single container reached at `omxterm.example.com`
through a reverse proxy that terminates TLS — but the steps are proxy-agnostic;
only the routing snippet is specific to the proxy you pick.

For the env knobs themselves and why each exists, see the
[README Deploy section](../README.md#deploy) and
[`how-it-works.md`](./how-it-works.md). This document is the _how to roll it
out_, not the security model.

OMXTerm ships two Compose paths:

- **Portable baseline** (`compose.yml`, the default) — publishes only to
  loopback so a reverse proxy on the same host can forward to it. No pre-created
  network, no fixed container address, no specific proxy product. This is what a
  fresh clone runs.
- **Production override** (`compose.prod.yml`, opt-in) — the maintainer's
  app-scoped rollout, where the reverse proxy runs in its own stack and reaches
  the broker over a shared, stably-named Docker network. Layered explicitly on
  top of the baseline.

Pick the path that matches where your proxy runs; both serve the same image.

---

## Topology

OMXTerm ships as **one container**. The broker (Fastify) serves both the API/
WebSocket and the built web SPA, so everything is one origin — the browser's
relative `/api` calls and the same-origin `wss://` just work, with no path
splitting in the proxy.

```text
Browser ──HTTPS/WSS──> Reverse proxy (edge, TLS) ──HTTP──> OMXTerm broker :3000
                                                            ├─ /            SPA (apps/web/dist)
                                                            ├─ /api/*       broker API
                                                            └─ /terminal/ws WebSocket
```

How the proxy reaches the broker depends on where the proxy runs:

- **Reverse proxy on the host** (portable baseline): forward to
  `http://127.0.0.1:3000`, the loopback port `compose.yml` publishes.
- **Reverse proxy in its own stack** (production override): attach it to the
  shared `omxterm-edge` network and forward to `http://omxterm:3000`.

The broker serves the SPA only when `OMXTERM_WEB_ROOT` is set (the image sets it
to `/app/apps/web/dist`). Left unset — as in local dev — Vite serves the web.

### Example environment

- Host: any Linux server you control. Optionally reach your SSH targets over a
  private network or VPN so the broker only dials hosts you intend to.
- A reverse proxy (Traefik, Caddy, nginx, …) as the edge, terminating TLS (e.g.
  via Let's Encrypt). This runbook uses **Traefik v3** with the file provider as
  one worked example; any proxy works.
- Convention used below: clone the repo somewhere stable such as `/opt/omxterm`.
  Adjust the paths to wherever you keep the checkout.

---

## Prerequisites

- **DNS**: `omxterm.example.com` resolves to the edge host (A/AAAA record).
- A reverse proxy in front of the container, terminating TLS.
- Docker + Compose on the host; the repo cloned at `/opt/omxterm`.

---

## 1. Get the code

The [`scripts/deploy`](../scripts/deploy) helper syncs the code safely: it
refuses to run on a dirty checkout, fetches, and **fast-forwards** `main` — it
never `reset --hard`s or creates merge commits, so it can't discard local work.
To sync by hand, keep it non-destructive:

```bash
cd /opt/omxterm
git status --short            # must be empty; commit or stash your own work first
git fetch origin
git merge --ff-only origin/main   # fast-forward only; fails instead of rewriting
```

Never use `git reset --hard` or `git add . && git reset` here: on a server
checkout that silently throws away uncommitted and untracked files.

## 2. Write the production `.env`

`.env` is git-ignored; it never ships in the image. Create it next to
`compose.yml` with the production values:

```bash
cd /opt/omxterm
cat > .env <<'ENV'
OMXTERM_ACCESS_TOKEN=__REPLACE_WITH_A_STRONG_TOKEN__
OMXTERM_ALLOWED_ORIGIN=https://omxterm.example.com
OMXTERM_SECURE_COOKIES=true
OMXTERM_SSH_ALLOWED_CIDR=10.0.0.0/24
# OMXTERM_TRUST_PROXY — set once you know how the proxy reaches the broker (step 3).
ENV
```

- `OMXTERM_ACCESS_TOKEN` — generate one: `openssl rand -base64 32`.
- `OMXTERM_SECURE_COOKIES=true` — the auth cookies are the authentication, so
  they must be `Secure` on any HTTPS deploy. The broker also **refuses to boot**
  if this is false while binding to a non-loopback host (the image binds
  `0.0.0.0`), so you cannot ship cookies in the clear by accident.
- `OMXTERM_SSH_ALLOWED_CIDR` — the egress allowlist (default-deny SSRF guard).
  Set it to the range(s) of hosts the broker is allowed to SSH into — for
  example your private network or VPN subnet — so it cannot be aimed at loopback,
  cloud metadata, or the public internet. `10.0.0.0/24` above is a placeholder;
  use your own.
- `OMXTERM_TRUST_PROXY` — left for step 3 because its correct value depends on
  the topology. Leaving it unset is a valid boot state (the broker starts fine),
  so there is no placeholder to crash on — you set it and re-run `up`.
- `OMXTERM_WEB_ROOT`, `OMXTERM_SERVER_HOST`, `OMXTERM_SERVER_PORT` are baked into
  the image; don't set them here. In particular, do **not** set
  `OMXTERM_SERVER_HOST` to a loopback value — the container must keep binding
  `0.0.0.0` so Docker's published port and any in-network proxy can reach it.

## 3. Start the broker

Choose the path that matches where your reverse proxy runs.

### 3a. Portable baseline — proxy on the same host

```bash
cd /opt/omxterm
docker compose up -d --build
docker compose logs -f omxterm   # expect: "OMXTerm server listening on http://0.0.0.0:3000"
```

`compose.yml` publishes the broker on `127.0.0.1:3000` only, so no other machine
can reach it directly — your reverse proxy (on the host) forwards to
`http://127.0.0.1:3000`. Note what loopback does and does not buy you: it blocks
**remote** clients, but any process or user already on the host can still connect
to the port. On a single-admin host where everything local is as trusted as the
proxy itself, it is reasonable to set:

```bash
# Add to .env, then `docker compose up -d` again to apply.
OMXTERM_TRUST_PROXY=true
```

`OMXTERM_TRUST_PROXY` makes `request.ip` the real client (rate limiting) and lets
HTTPS be detected from `X-Forwarded-Proto`. With `true`, any local process that
can reach the port could also spoof `X-Forwarded-*` headers, so on a shared or
multi-tenant host be strict instead: set it to the Docker network's subnet, which
covers the host-side bridge address the proxy connects from:

```bash
docker network inspect omxterm_default -f '{{(index .IPAM.Config 0).Subnet}}'
```

### 3b. Production override — proxy in its own stack

Layer `compose.prod.yml` explicitly to put the broker on the shared
`omxterm-edge` network (Compose creates it on `up`; nothing is pre-created):

```bash
cd /opt/omxterm
docker compose -f compose.yml -f compose.prod.yml up -d --build
docker compose -f compose.yml -f compose.prod.yml logs -f omxterm
```

Read the subnet Compose assigned to `omxterm-edge` and set `OMXTERM_TRUST_PROXY`
to it, then re-run `up` so the change takes effect:

```bash
docker network inspect omxterm-edge -f '{{(index .IPAM.Config 0).Subnet}}'
# Put the printed subnet in .env as OMXTERM_TRUST_PROXY=<subnet>, then:
docker compose -f compose.yml -f compose.prod.yml up -d
```

A reverse proxy running in its own stack is not on `omxterm-edge` yet — attach it
once so it can resolve the broker by name:

```bash
# Run once, and again only if you recreate the proxy container.
docker network connect omxterm-edge <your-reverse-proxy-container>
```

The proxy then reaches the broker as `http://omxterm:3000`. A proxy defined in
this same Compose project is already on the network and needs no connect step.

## 4. Add basic-auth credentials (optional)

Basic auth is an extra barrier in front of OMXTerm's own access gate, useful
while the deploy is still a private preview. Point your proxy at a dedicated
bcrypt users file so OMXTerm's credentials stay separate from anything else the
proxy serves:

```bash
# -n prints to stdout; omitting -b makes htpasswd PROMPT for the password, so it
# never lands in argv or shell history.
htpasswd -nB <user> | sudo tee -a /etc/omxterm/auth/omxterm-usersfile
```

(`htpasswd` is in `apache2-utils`. Do not pass the password with
`-b '<password>'`: that exposes it to shell history and process listings.)

Before you route a public hostname to it in step 5, read
[`docs/public-exposure.md`](./public-exposure.md): what OMXTerm's own rate
limits and concurrency caps do and don't protect against, `OMXTERM_TRUST_PROXY`
pitfalls, and an optional edge rate-limit recipe for whichever proxy you use.

## 5. Route it in the reverse proxy (Traefik example)

With Traefik's file provider, add these entries to your dynamic configuration
(merge into the existing `http.routers`, `http.services`, and `http.middlewares`
maps — don't duplicate the top-level keys). The router and middleware are the
same for both topologies from step 3; only the service URL differs:

> ⚠️ If this config file is shared with other routes, a YAML typo is hot-reloaded
> and can break them too. Back it up first and re-read it after saving.

```yaml
http:
  routers:
    omxterm:
      rule: 'Host(`omxterm.example.com`)'
      entryPoints:
        - websecure
      tls:
        certResolver: le
      middlewares:
        - omxterm-auth
      service: omxterm

  middlewares:
    omxterm-auth:
      basicAuth:
        usersFile: /auth/omxterm-usersfile
        realm: omxterm
```

Then add the `http.services` entry that matches the topology you started in
step 3 — copy the one block, not both:

**3a. Portable baseline — proxy on the host:**

```yaml
http:
  services:
    omxterm:
      loadBalancer:
        servers:
          - url: 'http://127.0.0.1:3000'
```

**3b. Production override — proxy in its own stack, attached to `omxterm-edge`:**

```yaml
http:
  services:
    omxterm:
      loadBalancer:
        servers:
          - url: 'http://omxterm:3000'
```

The file provider applies the change on save (`watch=true`) — no proxy restart.
Watch the proxy logs for parse errors after saving.

> Do **not** reuse an unrelated strict security-headers middleware. OMXTerm sets
> its own CSP and headers via `@fastify/helmet`; a `default-src 'none'` CSP from
> another site would break the app.

## 6. Verify

To rehearse the whole portable path first — on any machine, without touching a
real deployment — run the opt-in integration check. It builds and boots the
baseline in an isolated Compose project on an ephemeral loopback port, waits for
`/health`, and tears containers, networks, and the built image down:

```bash
npm run test:compose:integration
```

Then verify the live deploy itself:

```bash
# TLS + basic auth challenge
curl -sI https://omxterm.example.com | head -n 1   # 401 (basic auth)

# Pass only the username; curl PROMPTS for the password, keeping it out of argv
# and shell history.
curl -sI -u <user> https://omxterm.example.com | head -n 1   # 200
```

If your proxy fronts other routes, confirm the OMXTerm rollout did not disturb
them — the proxy container and the other routes should be unchanged.

Then in a browser: clear the basic-auth prompt → the OMXTerm access gate → enter
the access token → fill the SSH form for an allowed host → confirm the host-key
fingerprint → use the terminal. The full walkthrough is in
[`usage.md`](./usage.md).

If the SSH step fails to reach a host inside `OMXTERM_SSH_ALLOWED_CIDR`, confirm
the container can route to that network:

```bash
docker compose exec omxterm sh -lc 'getent hosts 10.0.0.2 || true'
```

---

## Updating

Run the deploy helper. It fast-forwards `main` and rebuilds **only** the
OMXTerm service, leaving the reverse proxy and any other routes running. It
applies the production override by default, so an update keeps the broker on
`omxterm-edge` for a separate-stack proxy:

```bash
/opt/omxterm/scripts/deploy
```

It stops before any Docker action when the checkout is dirty or `main` has
diverged from its upstream, so it never discards local work or rewrites history.
To deploy the plain portable baseline instead, clear the override:

```bash
OMXTERM_COMPOSE_OVERRIDE= /opt/omxterm/scripts/deploy
```

To roll out by hand instead (app service only; don't touch the proxy):

```bash
cd /opt/omxterm
git fetch origin && git merge --ff-only origin/main
docker compose up -d --build omxterm                                  # portable baseline
# or, for the production edge topology:
docker compose -f compose.yml -f compose.prod.yml up -d --build omxterm
```

The stores are in-memory, so a rebuild drops active sessions and pending tickets
— expected (the MVP keeps no persistence).

## Rollback

Roll back the app service only; the edge stays up throughout.

```bash
cd /opt/omxterm
git checkout <previous-good-sha>       # detached HEAD, non-destructive
docker compose up -d --build omxterm   # add -f compose.prod.yml for the edge topology
# If a proxy config edit caused it, restore the backup you made in step 5.
```
