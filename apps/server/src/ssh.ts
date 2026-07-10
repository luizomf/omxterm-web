import type { SshConnectionProfile } from '@omxterm/core/stores';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { createUtf8StreamDecoder } from './terminal-output-decoder';

export type HostKeyProbeInput = {
  host: string;
  port: number;
  pinnedAddress?: string;
};

export type HostKeyProbeResult = {
  fingerprint: string;
};

// The egress allowlist (#4) validated a specific resolved IP at request time;
// dialing that pinned address instead of re-resolving the hostname closes the
// DNS-rebinding window between check and dial (#26). ssh2 has no SNI/virtual
// hosting, so dialing by IP is equivalent for the host-key check, which compares
// fingerprints regardless of the string dialed. Unrestricted mode pins nothing,
// so the dial falls back to the hostname (localhost demo).
export function sshDialHost(target: { host: string; pinnedAddress?: string }): string {
  return target.pinnedAddress ?? target.host;
}

function fingerprintHostKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.trim().replace(/=+$/u, '');
}

export function probeSshHostKey(input: HostKeyProbeInput, timeoutMs = 10_000): Promise<HostKeyProbeResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(new Error('Timed out while probing SSH host key.'));
    }, timeoutMs);

    client.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    client.connect({
      host: sshDialHost(input),
      port: input.port,
      username: 'omxterm-host-key-probe',
      readyTimeout: timeoutMs,
      hostVerifier(key: Buffer) {
        if (!Buffer.isBuffer(key)) return false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ fingerprint: fingerprintHostKey(key) });
        }
        client.end();
        return false;
      },
    });
  });
}

export type SshTerminalSessionEvents = {
  output: [data: string];
  close: [reason: string];
  error: [error: Error];
};

// Normalized, credential-free reasons a connect attempt can fail with. They are
// safe to audit and to surface to the client without leaking anything about the
// key, passphrase, or target internals (#76).
export type SshConnectFailureReason =
  | 'ssh_connect_timeout'
  | 'ssh_connection_error'
  | 'ssh_connection_closed'
  | 'ssh_session_cancelled'
  | 'ssh_shell_open_failed';

export class SshConnectError extends Error {
  readonly reason: SshConnectFailureReason;

  constructor(reason: SshConnectFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SshConnectError';
    this.reason = reason;
  }
}

type SshShellOptions = {
  term: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
};

export type SshShellCallback = (error: Error | undefined, channel: ClientChannel) => void;

// The slice of the ssh2 Client the session drives. Injecting a factory for this
// (instead of `new Client()` inline) is the smallest seam that lets tests script
// ready/error/close/shell orderings deterministically (#76). Returns are `unknown`
// so the real Client stays structurally assignable without re-declaring overloads.
export type SshClientDriver = {
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  connect(config: ConnectConfig): unknown;
  shell(options: SshShellOptions, callback: SshShellCallback): unknown;
  end(): unknown;
  destroy(): unknown;
};

export type SshTerminalSessionDeps = {
  createClient?: () => SshClientDriver;
  connectDeadlineMs?: number;
};

// Total budget for the whole establishment path — TCP + SSH handshake + channel
// open + PTY + shell — not just the handshake. ssh2's `readyTimeout` only covers
// readiness, so a hostile server can authenticate and answer keepalives while
// stalling PTY/shell allocation forever; this deadline is the backstop (#76).
const CONNECT_DEADLINE_MS = 20_000;
const SSH_READY_TIMEOUT_MS = 15_000;

export class SshTerminalSession extends EventEmitter<SshTerminalSessionEvents> {
  readonly #client: SshClientDriver;
  readonly #connectDeadlineMs: number;
  #channel: ClientChannel | null = null;
  #closed = false;
  #clientDisposed = false;
  // Set while a connect() is in flight; calling it aborts the pending dial and
  // settles the connect promise exactly once. Null once connect() has settled.
  #cancelConnect: (() => void) | null = null;

  constructor(deps: SshTerminalSessionDeps = {}) {
    super();
    this.#client = (deps.createClient ?? (() => new Client()))();
    this.#connectDeadlineMs = deps.connectDeadlineMs ?? CONNECT_DEADLINE_MS;
  }

  connect(profile: SshConnectionProfile, size: { cols: number; rows: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout>;

      const settle = () => {
        settled = true;
        clearTimeout(deadline);
        this.#cancelConnect = null;
      };
      const finishOk = () => {
        if (settled) return;
        settle();
        resolve();
      };
      const finishError = (error: SshConnectError) => {
        if (settled) return;
        settle();
        // Abortive teardown so a half-open dial never lingers past connect()
        // (a graceful end() lets a stalling server keep the socket alive).
        this.#disposeClient(true);
        reject(error);
      };

      deadline = setTimeout(() => {
        finishError(new SshConnectError('ssh_connect_timeout', 'Timed out while establishing the SSH session.'));
      }, this.#connectDeadlineMs);

      this.#cancelConnect = () => {
        finishError(new SshConnectError('ssh_session_cancelled', 'The SSH session was cancelled before it was ready.'));
      };

      this.#client.on('error', (error) => {
        if (!settled) {
          finishError(
            new SshConnectError('ssh_connection_error', 'The SSH connection failed before the session was ready.', {
              cause: error,
            }),
          );
          return;
        }
        // A live session errored after it was established: surface it as a
        // runtime error, not a connect rejection.
        if (this.#channel) this.emit('error', error);
      });

      this.#client.on('close', () => {
        if (!settled) {
          finishError(new SshConnectError('ssh_connection_closed', 'The SSH connection closed before the session was ready.'));
          return;
        }
        if (!this.#closed) this.emit('close', 'ssh_connection_closed');
      });

      this.#client.on('ready', () => {
        if (settled) return;
        this.#client.shell(shellOptions(size), (error, channel) => {
          // Cancelled or timed out while the shell was opening: discard the
          // late channel instead of wiring a session nobody is listening to.
          if (settled) {
            channel?.close();
            return;
          }
          if (error) {
            finishError(new SshConnectError('ssh_shell_open_failed', 'Could not open the SSH shell.', { cause: error }));
            return;
          }
          this.#attachChannel(channel);
          finishOk();
        });
      });

      this.#client.connect(this.#buildConnectConfig(profile));
    });
  }

  write(data: string): void {
    this.#channel?.write(data);
  }

  // Pause/resume only the readable side of the channel for backpressure (#19).
  // The writable side stays open, so input (e.g. Ctrl-C) keeps flowing while the
  // consumer drains. ssh2's channel windowing turns this into end-to-end
  // backpressure that blocks the remote writer.
  pause(): void {
    this.#channel?.pause();
    this.#channel?.stderr.pause();
  }

  resume(): void {
    this.#channel?.resume();
    this.#channel?.stderr.resume();
  }

  resize(cols: number, rows: number): void {
    this.#channel?.setWindow(rows, cols, 0, 0);
  }

  close(): void {
    this.#closed = true;
    // Still dialing: abort the pending client so a stalling target can't keep
    // the outbound socket alive past the WebSocket that authorized it (#76).
    if (this.#cancelConnect) {
      this.#cancelConnect();
      return;
    }
    this.#channel?.close();
    // Established sessions end gracefully so buffered output can flush.
    this.#disposeClient(false);
  }

  #attachChannel(channel: ClientChannel): void {
    this.#channel = channel;
    // One decoder per stream so a multi-byte UTF-8 char split across chunks is
    // reassembled instead of becoming U+FFFD boxes (#11).
    const decodeStdout = createUtf8StreamDecoder();
    const decodeStderr = createUtf8StreamDecoder();
    channel.on('data', (data: Buffer | string) => {
      this.emit('output', decodeStdout(data));
    });
    channel.stderr.on('data', (data: Buffer | string) => {
      this.emit('output', decodeStderr(data));
    });
    channel.on('close', () => this.emit('close', 'ssh_channel_closed'));
  }

  #disposeClient(abortive: boolean): void {
    if (this.#clientDisposed) return;
    this.#clientDisposed = true;
    if (abortive) {
      this.#client.destroy();
      return;
    }
    this.#client.end();
  }

  #buildConnectConfig(profile: SshConnectionProfile): ConnectConfig {
    const config: ConnectConfig = {
      host: sshDialHost(profile),
      port: profile.port,
      username: profile.username,
      privateKey: profile.privateKey,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        if (!Buffer.isBuffer(key)) return false;
        return normalizeFingerprint(fingerprintHostKey(key)) === normalizeFingerprint(profile.acceptedHostFingerprint);
      },
    };
    if (profile.passphrase) config.passphrase = profile.passphrase;
    return config;
  }
}

function shellOptions(size: { cols: number; rows: number }): SshShellOptions {
  return {
    term: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    width: 0,
    height: 0,
  };
}
