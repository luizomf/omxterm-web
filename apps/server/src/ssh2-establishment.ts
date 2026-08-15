import {
  releaseSshConnectionCredentials,
  type SshConnectionProfile,
} from '@omxterm/core/stores';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { matchesHostKeyFingerprint } from './ssh-host-key';

const SSH_READY_TIMEOUT_MS = 15_000;

export type SshReadableStream = {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
};

export type SshTerminalChannel = SshReadableStream & {
  stderr: SshReadableStream;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  write(data: string): boolean;
  setWindow(rows: number, cols: number, width: number, height: number): unknown;
  close(): unknown;
};

export type SshEstablishmentEvent =
  | { type: 'authenticated' }
  | { type: 'connection-error'; error: Error }
  | { type: 'connection-closed' }
  | { type: 'shell-opened'; channel: SshTerminalChannel }
  | { type: 'shell-open-failed'; error: Error };

export type SshEstablishment = {
  /**
   * Takes ownership of the one-attempt profile. The adapter releases all
   * OMXTerm-owned credential references before reporting `authenticated`, and
   * therefore before requesting the shell.
   */
  start(
    profile: SshConnectionProfile,
    size: { cols: number; rows: number },
    onEvent: (event: SshEstablishmentEvent) => void,
  ): void;
  abort(): void;
  end(): void;
};

type SshShellOptions = {
  term: string;
  cols: number;
  rows: number;
  width: number;
  height: number;
};

export type Ssh2ShellCallback = (
  error: Error | undefined,
  channel: ClientChannel,
) => void;

// True-external seam: only this adapter knows ssh2's event names, ConnectConfig,
// callback shape, and ClientChannel type. Tests substitute the locked client at
// this seam; SshTerminalSession depends only on the local lifecycle above.
export type Ssh2ClientDriver = {
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  connect(config: ConnectConfig): unknown;
  shell(options: SshShellOptions, callback: Ssh2ShellCallback): unknown;
  end(): unknown;
  destroy(): unknown;
};

export type Ssh2EstablishmentDeps = {
  createClient?: () => Ssh2ClientDriver;
};

export class Ssh2Establishment implements SshEstablishment {
  readonly #client: Ssh2ClientDriver;
  #authenticationConfig: ConnectConfig | null = null;
  #onEvent: ((event: SshEstablishmentEvent) => void) | null = null;
  #shellSize: { cols: number; rows: number } | null = null;
  #active = false;
  #shellRequested = false;

  constructor(deps: Ssh2EstablishmentDeps = {}) {
    this.#client = (deps.createClient ?? (() => new Client()))();
    this.#client.on('ready', () => this.#handleAuthenticated());
    this.#client.on('error', (error) => this.#handleConnectionError(error));
    this.#client.on('close', () => this.#handleConnectionClose());
  }

  start(
    profile: SshConnectionProfile,
    size: { cols: number; rows: number },
    onEvent: (event: SshEstablishmentEvent) => void,
  ): void {
    if (this.#onEvent) {
      throw new Error('An SSH establishment adapter supports one attempt.');
    }

    this.#active = true;
    this.#onEvent = onEvent;
    this.#shellSize = size;

    try {
      this.#authenticationConfig = buildConnectConfig(profile);
      // The consumed grant and caller-visible profile stop owning credentials
      // as soon as their values have moved into this attempt's auth config.
      releaseSshConnectionCredentials(profile);
      this.#client.connect(this.#authenticationConfig);
    } catch (error) {
      releaseSshConnectionCredentials(profile);
      this.#releaseAuthenticationConfig();
      this.#active = false;
      throw error;
    }
  }

  abort(): void {
    this.#active = false;
    this.#releaseAuthenticationConfig();
    this.#client.destroy();
  }

  end(): void {
    this.#active = false;
    this.#releaseAuthenticationConfig();
    this.#client.end();
  }

  #handleAuthenticated(): void {
    if (!this.#active) return;
    // ssh2's ready event is SSH user-authentication success. Release the
    // application-owned auth config before exposing that milestone, then
    // request PTY/shell as a separate lifecycle step.
    this.#releaseAuthenticationConfig();
    this.#emit({ type: 'authenticated' });
    this.#requestShell();
  }

  #requestShell(): void {
    if (!this.#active || this.#shellRequested || !this.#shellSize) return;
    this.#shellRequested = true;
    try {
      this.#client.shell(shellOptions(this.#shellSize), (error, channel) => {
        if (!this.#active) {
          channel?.close();
          return;
        }
        if (error) {
          this.#emit({ type: 'shell-open-failed', error });
          return;
        }
        this.#emit({ type: 'shell-opened', channel });
      });
    } catch (error) {
      this.#emit({
        type: 'shell-open-failed',
        error:
          error instanceof Error
            ? error
            : new Error('The SSH shell request failed.'),
      });
    }
  }

  #handleConnectionError(error: Error): void {
    if (!this.#active) return;
    this.#releaseAuthenticationConfig();
    this.#emit({ type: 'connection-error', error });
  }

  #handleConnectionClose(): void {
    if (!this.#active) return;
    this.#releaseAuthenticationConfig();
    this.#emit({ type: 'connection-closed' });
  }

  #releaseAuthenticationConfig(): void {
    if (!this.#authenticationConfig) return;
    delete this.#authenticationConfig.privateKey;
    delete this.#authenticationConfig.passphrase;
    this.#authenticationConfig = null;
  }

  #emit(event: SshEstablishmentEvent): void {
    this.#onEvent?.(event);
  }
}

// The egress allowlist (#4) validated a specific resolved IP at request time;
// dialing that pinned address instead of re-resolving the hostname closes the
// DNS-rebinding window between check and dial (#26). ssh2 has no SNI/virtual
// hosting, so dialing by IP is equivalent for the host-key check, which compares
// fingerprints regardless of the string dialed. Unrestricted mode pins nothing,
// so the dial falls back to the hostname (localhost demo).
export function sshDialHost(target: {
  host: string;
  pinnedAddress?: string;
}): string {
  return target.pinnedAddress ?? target.host;
}

function buildConnectConfig(profile: SshConnectionProfile): ConnectConfig {
  const acceptedFingerprint = profile.acceptedHostFingerprint;
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
      return matchesHostKeyFingerprint(key, acceptedFingerprint);
    },
  };
  if (profile.passphrase !== undefined) {
    config.passphrase = profile.passphrase;
  }
  return config;
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
