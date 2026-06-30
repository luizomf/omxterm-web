# ADR 0001: Use TypeScript with Node, Fastify, Vite, and React

## Status

Accepted

## Context

The project needs a weekend-sized MVP for a browser-based SSH terminal. It must
look good, work reliably, and remain easy to extend later without turning the
first version into a large framework exercise.

The core flow includes a browser terminal UI, an HTTP endpoint for short-lived
connection tickets, a WebSocket terminal stream, and a backend SSH client that
connects to a user-provided SSH target.

## Decision

Use TypeScript across a small monorepo:

- `apps/web`: Vite, React, xterm.js
- `apps/server`: Node.js, Fastify, WebSocket, ssh2
- `packages/core`: shared contracts, types, and pure rules

The implementation should keep boundaries explicit through small
ports/interfaces for terminal connection, ticket storage, audit logging, and
broker orchestration.

## Consequences

- The MVP can be built quickly with mature Node libraries for WebSocket and SSH.
- Frontend and backend share type definitions without publishing packages.
- Later changes can replace in-memory tickets, SSH credential handling, audit
  storage, or authentication without rewriting the browser terminal UI.
- The project avoids runtime experiments during the MVP. Bun, Deno, edge
  runtimes, and container-per-session orchestration stay out of scope for now.
