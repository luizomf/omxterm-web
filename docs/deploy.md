# Deploying OMXTerm

This is the runbook for putting OMXTerm behind a reverse proxy on a server. It
walks one concrete example — a single container at `omxterm.example.com`, behind
a reverse proxy that terminates TLS — but the steps are proxy-agnostic; only the
routing snippet is specific to the proxy you pick.

For the env knobs themselves and why each exists, see the
[README Deploy section](../README.md#deploy) and
[`how-it-works.md`](./how-it-works.md). This document is the _how to roll it
out_, not the security model.

> The tracked `compose.yml` puts the broker on a neutral, stably-named
> `omxterm-edge` network so a separately-running reverse proxy can attach to it
> (step 3). The full portable, safe-by-default baseline (loopback-bound
> publishing, a proxy-agnostic topology) is tracked in #96, and a
> safe-public-exposure guide in #98. Until those land, keep any deployment-
> specific address or edge wiring in a local Compose override rather than in the
> tracked descriptor.

---

## Topology

OMXTerm ships as **one container**. The broker (Fastify) serves both the API/
WebSocket and the built web SPA, so everything is one origin — the browser's
relative `/api` calls and the same-origin `wss://` just work, with no path
splitting in the proxy.

```text
Browser ──HTTPS/WSS──> Reverse proxy (edge, TLS) ──HTTP──> omxterm:3000
                                                             ├─ /            SPA (apps/web/dist)
                                                             ├─ /api/*       broker API
                                                             └─ /terminal/ws WebSocket
```

The broker serves the SPA only when `OMXTERM_WEB_ROOT` is set (the image sets it
to `/app/apps/web/dist`). Left unset — as in local dev — Vite serves the web.

### Example environment

- Host: any Linux server you control. Optionally reach your SSH targets over a
  private network or VPN so the broker only dials hosts you intend to.
- A reverse proxy (Traefik, Caddy, or nginx) runs as the edge, terminates TLS
  (e.g. via Let's Encrypt), and forwards to the container over the shared
  `omxterm-edge` network. If the proxy runs in its own stack, attach it to that
  network so it resolves the broker as `omxterm:3000` (step 3). This runbook uses
  **Traefik v3** with the file provider as one worked example; any proxy works.
- Convention used below: clone the repo somewhere stable such as
  `/opt/omxterm`. Adjust the paths to wherever you keep the checkout.

If your edge is different (Caddy, nginx, Traefik via Docker labels), only steps
4–5 change: route the host to `omxterm:3000`, terminate TLS, and optionally add
basic auth.

---

## Prerequisites

- **DNS**: `omxterm.example.com` resolves to the edge host (A/AAAA record).
- A reverse proxy in front of the container, terminating TLS.
- Docker + compose on the host; the repo cloned at `/opt/omxterm`.

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
OMXTERM_TRUST_PROXY=__DOCKER_NETWORK_SUBNET__
OMXTERM_SSH_ALLOWED_CIDR=10.0.0.0/24
ENV
```

- `OMXTERM_ACCESS_TOKEN` — generate one: `openssl rand -base64 32`.
- `OMXTERM_TRUST_PROXY` — the subnet of the network the proxy reaches the broker
  over (`omxterm-edge`), so `request.ip` is the real client and HTTPS is detected
  from `X-Forwarded-Proto`. Prefer the subnet over a blanket `true`. Read it after
  `docker compose up` (step 3) has created the network:

  ```bash
  docker network inspect omxterm-edge -f '{{(index .IPAM.Config 0).Subnet}}'
  ```

- `OMXTERM_SSH_ALLOWED_CIDR` — the egress allowlist (default-deny SSRF guard).
  Set it to the range(s) of hosts the broker is allowed to SSH into — for
  example your private network or VPN subnet — so it cannot be aimed at loopback,
  cloud metadata, or the public internet. `10.0.0.0/24` above is a placeholder;
  use your own.
- `OMXTERM_WEB_ROOT`, `OMXTERM_SERVER_HOST`, `OMXTERM_SERVER_PORT` are baked
  into the image; don't set them here unless you need to override.

> The broker **refuses to boot** if `OMXTERM_SECURE_COOKIES` is false while the
> bind is non-loopback — that's the guard against shipping auth cookies in the
> clear.

## 3. Build and start

```bash
cd /opt/omxterm
docker compose up -d --build
docker compose logs -f omxterm   # expect: "OMXTerm server listening on http://0.0.0.0:3000"
```

`docker compose up` creates the `omxterm-edge` network (a stable name, so the
attach command below is reliable) and joins the broker to it. A reverse proxy
running in its own stack is not on that network yet — attach it once so it can
resolve the broker by name:

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

## 5. Route it in the reverse proxy (Traefik example)

The `http://omxterm:3000` service URL below resolves only if the Traefik
container shares the `omxterm-edge` network — attach it there once (step 3) if it
runs in its own stack. With Traefik's file provider, add these entries to your
dynamic configuration (merge into the existing `http.routers`, `http.services`,
and `http.middlewares` maps — don't duplicate the top-level keys):

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

  services:
    omxterm:
      loadBalancer:
        servers:
          - url: 'http://omxterm:3000'

  middlewares:
    omxterm-auth:
      basicAuth:
        usersFile: /auth/omxterm-usersfile
        realm: omxterm
```

The file provider applies the change on save (`watch=true`) — no proxy restart.
Watch the proxy logs for parse errors after saving.

> Do **not** reuse an unrelated strict security-headers middleware. OMXTerm sets
> its own CSP and headers via `@fastify/helmet`; a `default-src 'none'` CSP from
> another site would break the app.

## 6. Verify

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
OMXTerm service, leaving the reverse proxy and any other routes running:

```bash
/opt/omxterm/scripts/deploy
```

It stops before any Docker action when the checkout is dirty or `main` has
diverged from its upstream, so it never discards local work or rewrites history.
To roll out by hand instead:

```bash
cd /opt/omxterm
git fetch origin && git merge --ff-only origin/main
docker compose up -d --build omxterm   # app service only; don't touch the proxy
```

The stores are in-memory, so a rebuild drops active sessions and pending tickets
— expected (the MVP keeps no persistence).

## Rollback

Roll back the app service only; the edge stays up throughout.

```bash
cd /opt/omxterm
git checkout <previous-good-sha>       # detached HEAD, non-destructive
docker compose up -d --build omxterm
# If a proxy config edit caused it, restore the backup you made in step 5.
```
