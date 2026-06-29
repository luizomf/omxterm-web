import type { SshConnectionProfile } from '@omxterm/core/stores';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Client, type ClientChannel } from 'ssh2';
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

export class SshTerminalSession extends EventEmitter<SshTerminalSessionEvents> {
  readonly #client = new Client();
  #channel: ClientChannel | null = null;
  #closed = false;

  connect(profile: SshConnectionProfile, size: { cols: number; rows: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        if (this.#channel) {
          this.emit('error', error);
          return;
        }
        reject(error);
      };

      this.#client.on('error', fail);
      this.#client.on('close', () => {
        if (!this.#closed) this.emit('close', 'ssh_connection_closed');
      });

      this.#client.on('ready', () => {
        this.#client.shell(
          {
            term: 'xterm-256color',
            cols: size.cols,
            rows: size.rows,
            width: 0,
            height: 0,
          },
          (error, channel) => {
            if (error) {
              reject(error);
              return;
            }
            this.#channel = channel;
            // One decoder per stream so a multi-byte UTF-8 char split across
            // chunks is reassembled instead of becoming U+FFFD boxes (#11).
            const decodeStdout = createUtf8StreamDecoder();
            const decodeStderr = createUtf8StreamDecoder();
            channel.on('data', (data: Buffer | string) => {
              this.emit('output', decodeStdout(data));
            });
            channel.stderr.on('data', (data: Buffer | string) => {
              this.emit('output', decodeStderr(data));
            });
            channel.on('close', () => this.emit('close', 'ssh_channel_closed'));
            resolve();
          },
        );
      });

      const connectConfig = {
        host: sshDialHost(profile),
        port: profile.port,
        username: profile.username,
        privateKey: profile.privateKey,
        readyTimeout: 15_000,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        hostVerifier(key: Buffer) {
          if (!Buffer.isBuffer(key)) return false;
          return normalizeFingerprint(fingerprintHostKey(key)) === normalizeFingerprint(profile.acceptedHostFingerprint);
        },
      };
      if (profile.passphrase) Object.assign(connectConfig, { passphrase: profile.passphrase });
      this.#client.connect(connectConfig);
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
    this.#channel?.close();
    this.#client.end();
  }
}
