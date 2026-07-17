# CONTEXT

## Glossary

### Web terminal

A browser-based terminal UI that renders an interactive remote shell through
xterm.js and WebSocket. In this project, the web terminal is not itself the
shell and does not define what the user is allowed to do on the target machine.

### SSH target

The remote machine chosen by the user. The SSH target's own SSH server, users,
permissions, sudo policy, firewall, and operating-system security define what
can happen after connection.

### SSH credential

A user-provided credential used to connect to an SSH target. For the MVP,
credentials are sensitive session input, not product-owned identity or
authorization policy.

### Terminal session

A live bridge between the browser terminal and an SSH session on an SSH target.
The session ends when the WebSocket closes, SSH disconnects, or the backend
terminates it.

### Product security boundary

The project's responsibility is to safely establish and broker the
browser-to-backend-to-SSH-target connection without leaking credentials or
accidentally creating public unauthenticated access. The project does not
sandbox commands executed on the SSH target.

### Connection profile

A set of SSH connection inputs such as host, port, username, private key, and
optional passphrase. For the MVP, a connection profile is submitted for one
connection attempt and is not saved by the product.

### Broker

The backend component that owns the WebSocket connection to the browser and the
SSH connection to the SSH target. The broker forwards terminal input/output
between both sides and is responsible for lifecycle cleanup, not for deciding
what commands are allowed on the SSH target.

### Terminal connector

A replaceable backend port that creates a terminal session against a target. The
MVP connector uses SSH, but the product language keeps this generic so future
connectors can use containers, local PTYs, or other execution environments.

### OMXTerm Web theme

The project's visual language uses a hand-made terminal palette as the product
palette. It is dark, premium, and terminal-native, but it avoids the overused
green-on-black Matrix aesthetic. The default background is `#0f0f14`, foreground
is `#eae8ff`, cursor is `#d6d1ff`, selection is `#3b4fa6`, and the preferred
accent family is cyan/teal first, then blue/purple. Green is reserved for ANSI
terminal output or semantic success states, not brand identity.

### Connection grace period

A short reconnect window after browser WebSocket interruption where the backend
may keep the SSH session alive briefly so the user can reconnect without
re-entering credentials. For the MVP this is optional polish, not a requirement,
and must never become credential persistence.

### Device token

A random, server-issued, per-browser secret stored as a secure HttpOnly SameSite
cookie after the access gate succeeds. It is not browser fingerprinting and not
a replacement for TLS, the access session, Origin validation, or single-use
terminal tickets. Its role is to bind terminal ticket issuance and WebSocket
upgrade to the same browser session that passed the gate.

### In-memory store

The MVP persistence choice for access sessions, device tokens, and terminal
tickets. It is process-local and intentionally disposable: restarting the server
invalidates sessions and pending tickets. Store behavior must sit behind ports
so SQLite, Redis, or another durable/shared store can replace it later without
changing product flow or broker logic.

### Terminal emulator component

The reusable frontend component that wraps xterm.js rendering, input/output
wiring, fit/resize behavior, theme, status display, and lifecycle UI. It must be
transport-agnostic: SSH, Hermes CLI, local PTY, container exec, or any future
backend should be able to drive it through a small adapter contract.

### Terminal transport adapter

A frontend port used by the terminal emulator component to connect, send input,
send resize events, receive output, and close. The MVP adapter speaks OMXTerm
Web's WebSocket protocol, but the component must not know about SSH forms,
access tokens, device tokens, or backend-specific product flows.
