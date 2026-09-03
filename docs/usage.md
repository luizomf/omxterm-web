# Using OMXTerm Web

This is the operator's walkthrough: you already have OMXTerm Web running, and now you
want to open a remote shell and know what every screen and key does. It follows
the path the UI actually takes — access token, SSH form, host-key confirmation,
terminal — and then lists what the terminal can do once you are connected.

It does **not** cover setup or the security model:

- Getting it running (install, env vars, deploy) — [`README.md`](../README.md).
- Why each step exists and what it defends against —
  [`docs/how-it-works.md`](./how-it-works.md).
- How the pieces fit together — [`docs/architecture.md`](./architecture.md).

---

## Before you start

You need OMXTerm Web running and reachable, plus three things to connect:

- The **access token** the server was started with (`OMXTERM_ACCESS_TOKEN`).
- An **SSH target** you own: host, port, and username.
- A **private key** for that target (paste it, or load the file), and its
  passphrase if the key is encrypted.

Open the app in your browser. Locally that is `http://localhost:5173`; on a
deploy it is whatever origin you put behind your HTTPS proxy (see the README
[Deploy](../README.md#deploy) section).

---

## The walkthrough

### 1. Enter the access token

The first screen is the **access gate**. Paste the access token and press
**Unlock OMXTerm Web**. This is the shared gate that keeps the public URL from being
an open SSH proxy; it is not your SSH credential. On success the browser gets its
session and device cookies and moves on to the connection form. A wrong token
just shows an error — try again.

If you have already unlocked OMXTerm Web in this browser, you skip straight to the
connection form.

### 2. Fill in the SSH target

The **connection form** collects one connection's inputs:

- **Host** — the server's hostname or IP (e.g. `example.com`).
- **Port** — SSH port, `22` by default.
- **Username** — the remote user to log in as (e.g. `root`).
- **Private key** — paste the key, or use **Load private key file** to read one
  from disk into the field. The key is **masked by default** (including when
  loaded from a file) to guard against shoulder-surfing; use the **Show/Hide**
  control to reveal or re-hide it while editing.
- **Passphrase (optional)** — only if your private key is encrypted.

Press **Continue to fingerprint**. Nothing here is saved: OMXTerm Web does not keep
keys, profiles, `known_hosts`, or transcripts, so every connection starts from a
blank form.

### 3. Confirm the host-key fingerprint

Before logging in, OMXTerm Web probes the server's SSH host key and shows you its
**SHA256 fingerprint** alongside the `host:port` you entered. The probe collects
the key offered on the broker's current network path; displaying that key does
not authenticate the server by itself.

First obtain the expected fingerprint through an independent source you already
trust, such as the target's trusted console, trusted host-key metadata in the
provider control panel, or a previously authenticated administrative channel.
Compare that trusted value with the fingerprint OMXTerm Web displays. Press
**Trust for this session** only when the values match; if you cannot obtain an
independent value or anything looks off, press **Back**.

You can use `ssh-keyscan` to collect the key offered over the scanning
machine's current network path:

```bash
ssh-keyscan -p 22 ssh.example.net | ssh-keygen -lf -
```

This is collection, not independent authentication. If the scan and OMXTerm
Web's probe traverse the same potentially intercepted path, a man-in-the-middle
can present the same substituted key to both. Their agreement therefore does
not detect that interception and must not be the basis for trusting the key.

This trust is **per session only** — the MVP has no persistent `known_hosts`, so
you will confirm the fingerprint again next time.

### 4. Use the terminal

After you trust the key, OMXTerm Web opens the WebSocket, logs in over SSH, and drops
you into a real shell. Both terminal toolbars start hidden so the terminal gets
the available space. Use the top-left **Show toolbar (+)** control to reveal the
session title (`username@host`), **status pill**, and **End session** button. The
status pill tracks the live connection state (for example `connecting` then
`connected`, or `error` / `closed` when the session ends). The keyboard-tools
bar has its own independent `+` control.

Type as you would in any terminal. When you are done, reveal the top toolbar and
press **End session** to close the SSH session and return to the connection form.

---

## What the terminal can do

Once connected, the terminal is a full xterm.js surface with a few extras:

- **Auto-resize** — the grid fits the window, and the remote PTY is resized to
  match, so full-screen programs (`htop`, `vim`, `tmux`) use the whole area.
- **Font zoom** — `Cmd` + `=` / `+` grows the font, `Cmd` + `-` / `_` shrinks it,
  and `Cmd` + `0` resets to the default size. Zoom uses `Cmd` (not `Ctrl`) so it
  never shadows terminal shortcuts like `Ctrl` + `_`.
- **Clickable links** — visible `http://` and `https://` URLs in the output are
  clickable and open in a new tab. Remote OSC 8 semantic hyperlinks are
  intentionally ignored so an SSH target cannot retain attacker-sized hidden
  URIs in browser memory.
- **Emoji and wide characters** — emoji and CJK glyphs are measured at their real
  width, so they no longer push the grid out of alignment.
- **Copy to your clipboard (OSC 52)** — remote clipboard writes start disabled.
  Reveal the top toolbar and explicitly enable them for the current terminal
  session. Each `tmux`, `nvim`, or other OSC 52 write then shows its decoded text
  for review and needs a separate **Copy to clipboard** or **Reject** decision.
  Opt-in ends when the WebSocket closes, SSH disconnects, or the backend ends
  the session. This remains **write-only**: the remote host can propose text for
  your clipboard but can never read it back. Writes larger than 64 KiB are
  ignored. Accepted writes need a secure context, so they work on `localhost`
  and over HTTPS, but not over plain HTTP on a remote deploy.
- **Scrollback** — the terminal keeps the last 2000 lines.
- **Key bar** — a row of buttons below the terminal (`Esc`, `Tab`, `Ctrl`, arrow
  keys, `Ctrl-C`) for combos that are awkward on touch or remote keyboards. Use
  **Hide tools** to give the terminal the full height; the `+` button restores
  the bar.
  `Ctrl` is a one-shot modifier: tap it, then tap a letter, to send that
  control character (e.g. `Ctrl` then `d` sends `Ctrl-D`). Typing on mobile also
  disables autocorrect/autocapitalize so keystrokes reach the shell unmodified.

---

## What it deliberately does not do

OMXTerm Web is a weekend-sized MVP, and some of the "missing" behavior is on purpose:

- No saved keys, profiles, or `known_hosts` — every connection re-enters the
  form and re-confirms the fingerprint.
- No reconnect or resume — if the WebSocket drops, you reconnect from the form.
- No clipboard read, no terminal transcripts, no command sandboxing — what you
  can do on the target is decided by the target's own SSH server and users.

For the full list and the reasoning, see
[What OMXTerm Web does not do](./how-it-works.md#what-omxterm-web-does-not-do).
