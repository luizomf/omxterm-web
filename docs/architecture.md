# OMXTerm MVP architecture

Visual diagram:

- [`omxterm-mvp-architecture.excalidraw`](./omxterm-mvp-architecture.excalidraw)

Open it by dragging the `.excalidraw` file into <https://excalidraw.com>.

## What the diagram shows

OMXTerm is a browser SSH terminal, not a local sandbox terminal.

```text
Browser + xterm.js
  -> WebSocket with single-use ticket
  -> OMXTerm backend broker
  -> ssh2 client
  -> user-selected SSH server
```

Important boundaries:

- The browser never speaks raw SSH directly.
- The backend validates access/session/device/origin/ticket before opening the terminal WebSocket.
- The private key/passphrase are not persisted by the MVP.
- SSH host key trust is explicit per session; persistent `known_hosts` is out of MVP scope.
- Remote privileges are controlled by the SSH target, not by OMXTerm.
