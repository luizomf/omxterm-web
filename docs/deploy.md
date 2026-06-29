# Deploying OMXTerm

This is the runbook for putting OMXTerm behind a reverse proxy on a server. It
documents the reference deploy: a single container at `omxterm.inprod.cloud`,
behind a shared Traefik that already terminates TLS for other sites.

For the env knobs themselves and why each exists, see the
[README Deploy section](../README.md#deploy) and
[`how-it-works.md`](./how-it-works.md). This document is the _how to roll it
out_, not the security model.

---

## Topology

OMXTerm ships as **one container**. The broker (Fastify) serves both the API/
WebSocket and the built web SPA, so everything is one origin — the browser's
relative `/api` calls and the same-origin `wss://` just work, with no path
splitting in the proxy.

```text
Browser ──HTTPS/WSS──> Traefik (edge, TLS + basicAuth) ──HTTP──> omxterm:3000
                                                                   ├─ /            SPA (apps/web/dist)
                                                                   ├─ /api/*       broker API
                                                                   └─ /terminal/ws WebSocket
```

The broker serves the SPA only when `OMXTERM_WEB_ROOT` is set (the image sets it
to `/app/apps/web/dist`). Left unset — as in local dev — Vite serves the web.

### Reference environment

- Host: Ubuntu jump host reachable over a WireGuard VPN (`wg0`, `10.100.0.0/24`).
- A shared **Traefik v3** runs as the edge for several sites. It is configured by
  the **file provider** (a `dynamic.yml`), **not** Docker labels, and issues TLS
  via Let's Encrypt (resolver `le`, HTTP challenge). Sites attach to the external
  Docker network `read_inprod_web`.
- Convention: app code in `/projects/code/<domain>/`, mutable state in
  `/projects/state/<domain>/`.

If your edge is different (Caddy, nginx, Traefik via labels), only steps 4–5
change: route the host to `omxterm:3000`, terminate TLS, and optionally add
basic auth.

---

## Prerequisites

- **DNS**: `omxterm.inprod.cloud` resolves to the edge host (A/AAAA record).
- The shared Traefik and the `read_inprod_web` network are already up.
- Docker + compose on the host; the repo cloned at `/projects/code/omxterm`.

---

## 1. Get the code

```bash
cd /projects/code/omxterm
git fetch origin
git reset --hard origin/main   # discard any local drift, then take main
```

## 2. Write the production `.env`

`.env` is git-ignored; it never ships in the image. Create it next to
`compose.yml` with the production values:

```bash
cd /projects/code/omxterm
cat > .env <<'ENV'
OMXTERM_ACCESS_TOKEN=__REPLACE_WITH_A_STRONG_TOKEN__
OMXTERM_ALLOWED_ORIGIN=https://omxterm.inprod.cloud
OMXTERM_SECURE_COOKIES=true
OMXTERM_TRUST_PROXY=__DOCKER_NETWORK_SUBNET__
OMXTERM_SSH_ALLOWED_CIDR=10.100.0.0/24
ENV
```

- `OMXTERM_ACCESS_TOKEN` — generate one: `openssl rand -base64 32`.
- `OMXTERM_TRUST_PROXY` — the `read_inprod_web` subnet, so `request.ip` is the
  real client and HTTPS is detected from `X-Forwarded-Proto`. Prefer the subnet
  over a blanket `true`. Read it from:

  ```bash
  docker network inspect read_inprod_web -f '{{(index .IPAM.Config 0).Subnet}}'
  ```

- `OMXTERM_SSH_ALLOWED_CIDR` — the egress allowlist. `10.100.0.0/24` limits the
  broker to VPN hosts (default-deny SSRF guard).
- `OMXTERM_WEB_ROOT`, `OMXTERM_SERVER_HOST`, `OMXTERM_SERVER_PORT` are baked into
  the image; don't set them here unless you need to override.

> The broker **refuses to boot** if `OMXTERM_SECURE_COOKIES` is false while the
> bind is non-loopback — that's the guard against shipping auth cookies in the
> clear.

## 3. Build and start

```bash
cd /projects/code/omxterm
docker compose up -d --build
docker compose logs -f omxterm   # expect: "OMXTerm server listening on http://0.0.0.0:3000"
```

The container joins `read_inprod_web`; Traefik reaches it as `http://omxterm:3000`.

## 4. Add the basic-auth credentials

Basic auth is an extra barrier in front of OMXTerm's own access gate, useful
while the deploy is still a private preview. The shared Traefik already mounts
`/projects/state/read.inprod.cloud/auth` at `/auth`, so drop a dedicated
users file there (bcrypt):

```bash
htpasswd -nbB <user> '<password>' \
  | sudo tee -a /projects/state/read.inprod.cloud/auth/omxterm-usersfile
```

(`htpasswd` is in `apache2-utils`. Keep OMXTerm's users file separate from the
other sites' so credentials don't bleed across.)

## 5. Route it in Traefik (shared `dynamic.yml`)

> ⚠️ **This file is shared with other sites.** A YAML typo here is hot-reloaded
> and can break their routing too. Back it up first and re-read it after saving.

```bash
sudo cp /projects/code/read.inprod.cloud/traefik/dynamic.yml{,.bak}
```

Add these entries under the existing `http.routers`, `http.services`, and
`http.middlewares` maps (merge into the maps — don't duplicate the top-level
keys):

```yaml
http:
  routers:
    omxterm:
      rule: "Host(`omxterm.inprod.cloud`)"
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
          - url: "http://omxterm:3000"

  middlewares:
    omxterm-auth:
      basicAuth:
        usersFile: /auth/omxterm-usersfile
        realm: omxterm
```

The file provider has `watch=true`, so the change applies on save — no Traefik
restart. Watch the logs for parse errors:

```bash
docker logs -f readinprodcloud-traefik-1
```

> Do **not** reuse the other sites' security-headers middleware. OMXTerm sets its
> own CSP and headers via `@fastify/helmet`; that middleware's strict
> `default-src 'none'` CSP would break the app.

## 6. Verify

```bash
# TLS + basic auth challenge
curl -sI https://omxterm.inprod.cloud | head -n 1          # 401 (basic auth)
curl -sI -u <user>:'<password>' https://omxterm.inprod.cloud | head -n 1  # 200
```

Then in a browser: clear the basic-auth prompt → the OMXTerm access gate →
enter the access token → fill the SSH form for a VPN host (`10.100.0.x`) →
confirm the host-key fingerprint → use the terminal. The full walkthrough is in
[`usage.md`](./usage.md).

If the SSH step fails to reach a `10.100.0.x` host, confirm the container can
route to the VPN (bridge containers egress via the host, which owns `wg0`):

```bash
docker compose exec omxterm sh -lc 'getent hosts 10.100.0.2 || true'
```

---

## Updating

```bash
cd /projects/code/omxterm
git pull
docker compose up -d --build
```

The stores are in-memory, so a rebuild drops active sessions and pending
tickets — expected (the MVP keeps no persistence).

## Rollback

```bash
cd /projects/code/omxterm
git checkout <previous-good-sha>
docker compose up -d --build
# If a dynamic.yml edit caused it:
sudo mv /projects/code/read.inprod.cloud/traefik/dynamic.yml.bak \
        /projects/code/read.inprod.cloud/traefik/dynamic.yml
```
