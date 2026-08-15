import type { SshConnectionProfile } from '@omxterm/core/stores';
import { EventEmitter } from 'node:events';
import { Client } from 'ssh2';
import { fingerprintHostKey } from './ssh-host-key';
import {
  Ssh2Establishment,
  sshDialHost,
  type SshEstablishment,
  type SshEstablishmentEvent,
  type SshTerminalChannel,
} from './ssh2-establishment';
import { createUtf8StreamDecoder } from './terminal-output-decoder';

export { normalizeFingerprint } from './ssh-host-key';
export { sshDialHost } from './ssh2-establishment';

export type HostKeyProbeInput = {
  host: string;
  port: number;
  pinnedAddress?: string;
};

export type HostKeyProbeResult = {
  fingerprint: string;
};

export type HostKeyProbeFailureReason =
  | 'host_key_probe_timeout'
  | 'host_key_resolution_failed'
  | 'host_key_connection_refused'
  | 'host_key_connection_failed';

/**
 * Maps network/SSH diagnostics to a closed metadata set. Raw error prose can
 * contain unstable target-controlled details and does not belong in audit logs.
 */
export function normalizeHostKeyProbeFailure(
  error: unknown,
): HostKeyProbeFailureReason {
  if (!(error instanceof Error)) return 'host_key_connection_failed';
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === 'ETIMEDOUT' ||
    error.message === 'Timed out while probing SSH host key.'
  ) {
    return 'host_key_probe_timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'host_key_resolution_failed';
  }
  if (code === 'ECONNREFUSED') return 'host_key_connection_refused';
  return 'host_key_connection_failed';
}

export function probeSshHostKey(
  input: HostKeyProbeInput,
  timeoutMs = 10_000,
): Promise<HostKeyProbeResult> {
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
  // Fires when a channel that pushed back on write() (returned false) has
  // flushed its buffer, so the broker can resume draining queued input (#77).
  drain: [];
};

// Normalized, credential-free reasons a connect attempt can fail with. They are
// safe to audit and to surface to the client without leaking anything about the
// key, passphrase, or target internals (#76). Raw dependency errors are never
// attached as causes because parser diagnostics can echo submitted key bytes.
export type SshConnectFailureReason =
  | 'ssh_connect_timeout'
  | 'ssh_connection_error'
  | 'ssh_connection_closed'
  | 'ssh_session_cancelled'
  | 'ssh_shell_open_failed';

export class SshConnectError extends Error {
  readonly reason: SshConnectFailureReason;

  constructor(reason: SshConnectFailureReason, message: string) {
    super(message);
    this.name = 'SshConnectError';
    this.reason = reason;
  }
}

export type SshTerminalSessionDeps = {
  createEstablishment?: () => SshEstablishment;
  connectDeadlineMs?: number;
};

// Total budget for the whole establishment path — TCP + SSH handshake + channel
// open + PTY + shell — not just the handshake. ssh2's `readyTimeout` only covers
// readiness, so a hostile server can authenticate and answer keepalives while
// stalling PTY/shell allocation forever; this deadline is the backstop (#76).
const CONNECT_DEADLINE_MS = 20_000;

export class SshTerminalSession extends EventEmitter<SshTerminalSessionEvents> {
  readonly #establishment: SshEstablishment;
  readonly #connectDeadlineMs: number;
  #channel: SshTerminalChannel | null = null;
  #closed = false;
  #clientDisposed = false;
  // Set while a connect() is in flight; calling it aborts the pending dial and
  // settles the connect promise exactly once. Null once connect() has settled.
  #cancelConnect: (() => void) | null = null;

  constructor(deps: SshTerminalSessionDeps = {}) {
    super();
    this.#establishment = (
      deps.createEstablishment ?? (() => new Ssh2Establishment())
    )();
    this.#connectDeadlineMs = deps.connectDeadlineMs ?? CONNECT_DEADLINE_MS;
  }

  /**
   * Takes ownership of `profile` for one connection attempt. Callers must not
   * read or reuse it after invoking this method.
   */
  connect(
    profile: SshConnectionProfile,
    size: { cols: number; rows: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let phase: 'authenticating' | 'authenticated' = 'authenticating';
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
        // Abortive teardown releases adapter-owned authentication references
        // before the failed/cancelled attempt becomes observable.
        this.#disposeClient(true);
        reject(error);
      };
      const handleEstablishmentEvent = (event: SshEstablishmentEvent) => {
        switch (event.type) {
          case 'authenticated':
            if (!settled) phase = 'authenticated';
            return;
          case 'shell-opened':
            // Cancelled or timed out while the shell was opening: discard the
            // late channel instead of wiring a session nobody is listening to.
            if (settled) {
              event.channel.close();
              return;
            }
            if (phase !== 'authenticated') {
              event.channel.close();
              finishError(
                new SshConnectError(
                  'ssh_connection_error',
                  'The SSH shell opened before authentication completed.',
                ),
              );
              return;
            }
            this.#attachChannel(event.channel);
            finishOk();
            return;
          case 'shell-open-failed':
            finishError(
              new SshConnectError(
                'ssh_shell_open_failed',
                'Could not open the SSH shell.',
              ),
            );
            return;
          case 'connection-error':
            if (!settled) {
              finishError(
                new SshConnectError(
                  'ssh_connection_error',
                  'The SSH connection failed before the session was ready.',
                ),
              );
              return;
            }
            // A live session errored after shell establishment: surface only a
            // normalized runtime error, never raw dependency diagnostics.
            if (this.#channel) {
              this.emit('error', new Error('The SSH connection failed.'));
            }
            return;
          case 'connection-closed':
            if (!settled) {
              finishError(
                new SshConnectError(
                  'ssh_connection_closed',
                  'The SSH connection closed before the session was ready.',
                ),
              );
              return;
            }
            // abort() after a failed attempt also closes ssh2. Only a connection
            // with an attached shell belongs on the runtime event path.
            if (!this.#closed && this.#channel) {
              this.emit('close', 'ssh_connection_closed');
            }
        }
      };

      deadline = setTimeout(() => {
        finishError(
          new SshConnectError(
            'ssh_connect_timeout',
            'Timed out while establishing the SSH session.',
          ),
        );
      }, this.#connectDeadlineMs);

      this.#cancelConnect = () => {
        finishError(
          new SshConnectError(
            'ssh_session_cancelled',
            'The SSH session was cancelled before it was ready.',
          ),
        );
      };

      try {
        this.#establishment.start(profile, size, handleEstablishmentEvent);
      } catch {
        finishError(
          new SshConnectError(
            'ssh_connection_error',
            'The SSH connection failed before the session was ready.',
          ),
        );
      }
    });
  }

  // Returns the channel's writable signal: false means ssh2's stdin buffer is
  // full and the broker should stop feeding input until the next `drain` (#77).
  // Reports writable (true) before a channel is attached — pre-ready input is
  // dropped, exactly as before, but must never look like backpressure or the
  // broker's bounded input queue would stall waiting for a drain that can't come.
  write(data: string): boolean {
    return this.#channel?.write(data) ?? true;
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

  #attachChannel(channel: SshTerminalChannel): void {
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
    channel.on('drain', () => this.emit('drain'));
    channel.on('close', () => this.emit('close', 'ssh_channel_closed'));
  }

  #disposeClient(abortive: boolean): void {
    if (this.#clientDisposed) return;
    this.#clientDisposed = true;
    if (abortive) {
      this.#establishment.abort();
      return;
    }
    this.#establishment.end();
  }
}
