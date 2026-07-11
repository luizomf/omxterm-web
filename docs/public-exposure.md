# Safe public exposure

OMXTerm is a browser-to-SSH broker. Publishing it on the internet is a decision
about **your edge**, not merely a `docker compose up` command. This guide is
proxy-agnostic: use the controls that fit your network and hosting provider.

## What OMXTerm protects

The broker has useful application-level controls:

- the access gate validates a strong operator token with a timing-safe compare;
- failed access-token attempts are limited per client (10 failures per 60
  seconds); over the limit returns `429` with `Retry-After`;
- after authentication, host-key probes and terminal-ticket requests are limited
  per session (30 per minute), and session and WebSocket capacity is bounded;
- terminal tickets are short-lived, single-use, and bound to the authenticated
  browser and allowed Origin;
- exact Origin validation protects browser requests and WebSocket upgrades.

These controls reduce accidental exposure and simple abuse. They do **not** turn
the broker into a bot filter or DDoS service. Origin validation is a browser
security boundary; non-browser clients can send any Origin value, so it is not
bot authentication.

## Put an edge in front of OMXTerm

For any public deployment, use HTTPS/WSS and set `OMXTERM_SECURE_COOKIES=true`.
The auth cookies are credentials, so cleartext HTTP is not an acceptable
fallback. Keep the broker behind a reverse proxy and expose only the proxy to
the public network. The portable `compose.yml` baseline already publishes the
broker to loopback only.

Application limits do not replace edge request limiting, firewall policy,
provider DDoS controls, or a WAF where that is appropriate for the deployment.
Use layers:

1. **Network:** restrict the broker to the proxy or a private network; restrict
   SSH egress with `OMXTERM_SSH_ALLOWED_CIDR`.
2. **TLS:** terminate HTTPS/WSS at the edge and redirect or reject HTTP.
3. **Edge policy:** rate-limit the OMXTerm router before traffic reaches Node;
   add provider DDoS controls and a WAF when the threat model needs them.
4. **Application:** keep OMXTerm's token, Origin, ticket, and capacity controls
   enabled as the final broker-specific layer.

Do not log request bodies, access tokens, cookies, private keys, passphrases,
tickets, authorization headers, or terminal transcripts at the proxy or in
application logs.

## Trust the real client IP carefully

`OMXTERM_TRUST_PROXY` controls whether Fastify uses forwarded headers for the
client IP and HTTPS detection.

- **Proxy in front, variable unset:** every request appears to come from the
  proxy. The failed-login limiter then puts unrelated users in the same bucket.
- **Too broad a trust setting:** a client that can reach the broker directly can
  spoof `X-Forwarded-For` or `X-Forwarded-Proto`, defeating client attribution
  and confusing HTTPS detection.
- **Safe setting:** allow only the known proxy IP/CIDR. `true` is appropriate
  only when the broker is reachable exclusively through one trusted local proxy
  path; otherwise prefer an explicit IP/CIDR.
- **No proxy:** leave it unset. Forwarded headers are client-controlled there.

Verify the container/network topology first, then set the narrowest value that
matches it. See [the deployment runbook](./deploy.md) for the two Compose
paths.

## Optional edge recipes

Basic Auth can be a useful **private-preview** layer in front of OMXTerm's own
access gate. It is optional; it does not replace the OMXTerm token, TLS, or edge
rate limiting. Keep its credential file separate from unrelated proxy routes and
avoid putting passwords on command lines.

The following Traefik dynamic-config fragment is one optional example. It
attaches a rate limit only to the OMXTerm router; merge it into existing maps
rather than replacing global proxy configuration. Choose values for expected
users and test traffic before deploying.

```yaml
http:
  routers:
    omxterm:
      rule: 'Host(`terminal.example.test`)'
      entryPoints:
        - websecure
      tls: {}
      middlewares:
        - omxterm-rate-limit
      service: omxterm

  middlewares:
    omxterm-rate-limit:
      rateLimit:
        average: 20
        burst: 40
        period: 1m

  services:
    omxterm:
      loadBalancer:
        servers:
          - url: 'http://127.0.0.1:3000'
```

Caddy, nginx, a cloud load balancer, or another edge can provide the same
properties: TLS, a narrow upstream path, and router-scoped request limiting.
Do not add a reverse-proxy dependency to the OMXTerm runtime just to copy this
example.

## Before opening the URL

- Confirm HTTPS/WSS works and plain HTTP is redirected or rejected.
- Confirm the broker is not directly reachable from the internet.
- Set `OMXTERM_ALLOWED_ORIGIN` to the exact public HTTPS origin.
- Set `OMXTERM_TRUST_PROXY` only to the proxy path that can actually reach the
  broker.
- Test that the edge limit applies to the OMXTerm route without throttling
  unrelated routes.
- Review provider DDoS, firewall, and WAF controls for the expected audience.
- Treat access tokens, cookies, keys, tickets, and terminal data as secrets in
  logs, support bundles, and monitoring.
