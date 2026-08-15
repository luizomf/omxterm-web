import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SshConnectionProfile } from '@omxterm/core/stores';
import { utils, type ClientChannel, type ConnectConfig } from 'ssh2';
import {
  normalizeFingerprint,
  normalizeHostKeyProbeFailure,
  SshConnectError,
  SshTerminalSession,
  sshDialHost,
} from './ssh';
import {
  Ssh2Establishment,
  type Ssh2ClientDriver,
  type Ssh2ShellCallback,
  type SshEstablishment,
} from './ssh2-establishment';

describe('normalizeFingerprint', () => {
  test('trims padding and whitespace for session fingerprint comparison', () => {
    expect(normalizeFingerprint(' SHA256:abc== ')).toBe('SHA256:abc');
  });
});

describe('normalizeHostKeyProbeFailure', () => {
  test.each([
    {
      error: Object.assign(new Error('dns detail'), { code: 'ENOTFOUND' }),
      reason: 'host_key_resolution_failed',
    },
    {
      error: Object.assign(new Error('connection detail'), {
        code: 'ECONNREFUSED',
      }),
      reason: 'host_key_connection_refused',
    },
    {
      error: Object.assign(new Error('timeout detail'), { code: 'ETIMEDOUT' }),
      reason: 'host_key_probe_timeout',
    },
    {
      error: new Error('server-controlled diagnostic detail'),
      reason: 'host_key_connection_failed',
    },
  ])('maps probe failures to $reason', ({ error, reason }) => {
    expect(normalizeHostKeyProbeFailure(error)).toBe(reason);
  });
});

describe('sshDialHost', () => {
  test('dials the pinned validated IP instead of the hostname so ssh2 never re-resolves (#26)', () => {
    expect(
      sshDialHost({
        host: 'private-host.example',
        pinnedAddress: '10.100.0.4',
      }),
    ).toBe('10.100.0.4');
  });

  test('falls back to the hostname when no IP was pinned (unrestricted/localhost demo)', () => {
    expect(sshDialHost({ host: 'localhost' })).toBe('localhost');
  });
});

const profile: SshConnectionProfile = {
  host: 'ssh.example',
  port: 22,
  username: 'deploy',
  privateKey: 'test-private-key',
  acceptedHostFingerprint: 'SHA256:test',
};

// A scriptable stand-in for the ssh2 Client that lets a test drive the
// ready/error/close/shell orderings deterministically and observe how the
// session tears the client down. It only implements the surface connect() uses.
class FakeSshClient extends EventEmitter implements Ssh2ClientDriver {
  connectCount = 0;
  shellCount = 0;
  endCount = 0;
  destroyCount = 0;
  retainedAuthenticationCredentialsAtShellOpen: boolean | undefined;
  authenticationInputMatched: boolean | undefined;
  authenticationInputParsed: boolean | undefined;
  parseAuthenticationInput = false;
  connectError: Error | null = null;
  #connectConfig: ConnectConfig | null = null;
  #expectedAuthenticationInput: {
    privateKey: string;
    passphrase?: string;
  } | null = null;
  #shellCallback: Ssh2ShellCallback | null = null;

  connect(config: ConnectConfig): this {
    this.connectCount += 1;
    this.#connectConfig = config;
    if (this.#expectedAuthenticationInput) {
      this.authenticationInputMatched =
        config.privateKey === this.#expectedAuthenticationInput.privateKey &&
        config.passphrase === this.#expectedAuthenticationInput.passphrase;
      this.#expectedAuthenticationInput = null;
    }
    if (this.parseAuthenticationInput) {
      const parsed = utils.parseKey(
        config.privateKey ?? '',
        config.passphrase,
      );
      this.authenticationInputParsed = !(parsed instanceof Error);
    }
    if (this.connectError) throw this.connectError;
    return this;
  }

  shell(_options: unknown, callback: Ssh2ShellCallback): this {
    this.shellCount += 1;
    this.retainedAuthenticationCredentialsAtShellOpen =
      this.retainsAuthenticationCredentials();
    this.#shellCallback = callback;
    return this;
  }

  retainsAuthenticationCredentials(): boolean {
    return Boolean(
      this.#connectConfig?.privateKey || this.#connectConfig?.passphrase,
    );
  }

  expectAuthenticationInput(
    privateKey: string,
    passphrase?: string,
  ): void {
    this.#expectedAuthenticationInput = {
      privateKey,
      ...(passphrase === undefined ? {} : { passphrase }),
    };
  }

  verifyHostKey(key: Buffer): boolean {
    const verifier = this.#connectConfig?.hostVerifier as
      | ((candidate: Buffer) => boolean)
      | undefined;
    return verifier?.(key) === true;
  }

  end(): this {
    this.endCount += 1;
    return this;
  }

  destroy(): void {
    this.destroyCount += 1;
  }

  openShell(channel: ClientChannel): void {
    this.#shellCallback?.(undefined, channel);
  }

  failShell(error: Error): void {
    this.#shellCallback?.(error, undefined as unknown as ClientChannel);
  }
}

function diagnosticGraphContains(value: unknown, needle: string): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current.includes(needle)) return true;
      continue;
    }
    if (
      current === null ||
      (typeof current !== 'object' && typeof current !== 'function')
    ) {
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);

    if (ArrayBuffer.isView(current)) {
      const bytes = Buffer.from(
        current.buffer,
        current.byteOffset,
        current.byteLength,
      );
      if (bytes.toString('utf8').includes(needle)) return true;
    }
    if (current instanceof Map) {
      for (const [key, entry] of current) pending.push(key, entry);
    }
    if (current instanceof Set) {
      for (const entry of current) pending.push(entry);
    }
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
    }
  }

  return false;
}

function fakeChannel(writeResult = true): ClientChannel {
  const channel = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close(): void;
    write(data: string): boolean;
  };
  channel.stderr = new EventEmitter();
  channel.close = () => channel.emit('close');
  channel.write = () => writeResult;
  return channel as unknown as ClientChannel;
}

async function establishedSession(channel: ClientChannel): Promise<{
  session: SshTerminalSession;
  client: FakeSshClient;
}> {
  const { session, client } = createSession();
  const connecting = session.connect({ ...profile }, { cols: 80, rows: 24 });
  client.emit('ready');
  client.openShell(channel);
  await connecting;
  return { session, client };
}

function createSession(overrides: { connectDeadlineMs?: number } = {}): {
  session: SshTerminalSession;
  client: FakeSshClient;
} {
  const client = new FakeSshClient();
  const session = new SshTerminalSession({
    createEstablishment: () =>
      new Ssh2Establishment({ createClient: () => client }),
    connectDeadlineMs: overrides.connectDeadlineMs ?? 20_000,
  });
  return { session, client };
}

describe('SshTerminalSession lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('releases application-owned credentials at authentication before a stalled shell allocation', async () => {
    const { session, client } = createSession();
    const consumedGrant = {
      profile: {
        ...profile,
        passphrase: 'test-passphrase',
      } satisfies SshConnectionProfile,
    };
    const connecting = session.connect(consumedGrant.profile, {
      cols: 80,
      rows: 24,
    });
    let settled = false;
    void connecting
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    try {
      expect(
        Boolean(
          consumedGrant.profile.privateKey || consumedGrant.profile.passphrase,
        ),
      ).toBe(false);

      client.emit('ready');
      await Promise.resolve();

      expect(client.shellCount).toBe(1);
      expect(client.retainedAuthenticationCredentialsAtShellOpen).toBe(false);
      expect(client.retainsAuthenticationCredentials()).toBe(false);
      expect(settled).toBe(false);
    } finally {
      session.close();
      await connecting.catch(() => {});
    }
  });

  test.each([
    { keyKind: 'unencrypted', encrypted: false },
    { keyKind: 'encrypted', encrypted: true },
  ])(
    'preserves $keyKind OpenSSH input and its optional passphrase at the ssh2 seam',
    async ({ encrypted }) => {
      const passphrase = encrypted ? 'generated-test-passphrase' : undefined;
      const generated = encrypted
        ? utils.generateKeyPairSync('ed25519', {
            passphrase: passphrase ?? '',
            cipher: 'aes256-ctr',
            rounds: 16,
          })
        : utils.generateKeyPairSync('ed25519');
      const { session, client } = createSession();
      client.parseAuthenticationInput = true;
      client.expectAuthenticationInput(generated.private, passphrase);
      const ownedProfile: SshConnectionProfile = {
        ...profile,
        privateKey: generated.private,
        ...(passphrase === undefined ? {} : { passphrase }),
      };
      const connecting = session.connect(ownedProfile, {
        cols: 80,
        rows: 24,
      });

      expect(client.authenticationInputMatched).toBe(true);
      expect(client.authenticationInputParsed).toBe(true);
      expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
        false,
      );

      session.close();
      await expect(connecting).rejects.toMatchObject({
        reason: 'ssh_session_cancelled',
      });
    },
  );

  test('normalizes real ssh2 parser diagnostics before rejecting malformed credentials', async () => {
    const privateKeyMarker = 'LEAK-MARKER-123';
    const passphraseMarker = 'PASSPHRASE-MARKER-456';
    const malformedPayload = Buffer.concat([
      Buffer.from(privateKeyMarker),
      Buffer.alloc(16),
    ]).toString('base64');
    const privateKey = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      malformedPayload,
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const rawParserError = utils.parseKey(privateKey, passphraseMarker);
    expect(
      rawParserError instanceof Error &&
        rawParserError.message.includes(privateKeyMarker),
    ).toBe(true);
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey,
      passphrase: passphraseMarker,
    };
    const session = new SshTerminalSession();

    const rejection = await session
      .connect(ownedProfile, { cols: 80, rows: 24 })
      .catch((error: unknown) => error);

    expect(rejection instanceof SshConnectError).toBe(true);
    if (!(rejection instanceof SshConnectError)) return;
    expect({
      name: rejection.name,
      reason: rejection.reason,
      message: rejection.message,
    }).toEqual({
      name: 'SshConnectError',
      reason: 'ssh_connection_error',
      message: 'The SSH connection failed before the session was ready.',
    });
    expect(diagnosticGraphContains(rejection, privateKeyMarker)).toBe(false);
    expect(diagnosticGraphContains(rejection, passphraseMarker)).toBe(false);
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
  });

  test('does not mutate a profile after establishment takes ownership', async () => {
    let ownershipTransferred = false;
    let writesAfterTransfer = 0;
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'single-owner-test-private-key',
      passphrase: 'single-owner-test-passphrase',
    };
    const transferredProfile = new Proxy(ownedProfile, {
      set(target, property, value) {
        if (ownershipTransferred) writesAfterTransfer += 1;
        return Reflect.set(target, property, value);
      },
    });
    const establishment: SshEstablishment = {
      start() {
        ownedProfile.privateKey = '';
        ownedProfile.passphrase = '';
        ownershipTransferred = true;
      },
      abort() {},
      end() {},
    };
    const session = new SshTerminalSession({
      createEstablishment: () => establishment,
    });
    const connecting = session.connect(transferredProfile, {
      cols: 80,
      rows: 24,
    });

    expect(writesAfterTransfer).toBe(0);

    session.close();
    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_session_cancelled',
    });
  });

  test('releases credentials before a synchronous key-parse failure settles', async () => {
    const { session, client } = createSession();
    client.connectError = new Error(
      'Cannot parse privateKey: Unsupported key format',
    );
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'invalid-test-private-key',
      passphrase: 'invalid-test-passphrase',
    };

    const error = await session
      .connect(ownedProfile, { cols: 80, rows: 24 })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: 'SshConnectError',
      reason: 'ssh_connection_error',
    });
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
    const diagnostic =
      error instanceof Error
        ? `${error.name}:${error.message}:${error.cause instanceof Error ? error.cause.message : ''}`
        : '';
    expect(diagnostic.includes('invalid-test-private-key')).toBe(false);
    expect(diagnostic.includes('invalid-test-passphrase')).toBe(false);
  });

  test('re-verifies the exact host fingerprint and releases credentials on rejection', async () => {
    const { session, client } = createSession();
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'host-verification-test-private-key',
      passphrase: 'host-verification-test-passphrase',
      acceptedHostFingerprint:
        'SHA256:13VYV41+lQ5DfMWfk2nFOS6LzRlfxA/WhjtEAN31FcI',
    };
    const connecting = session.connect(ownedProfile, {
      cols: 80,
      rows: 24,
    });

    expect(client.verifyHostKey(Buffer.from('accepted-host-key'))).toBe(true);
    expect(client.verifyHostKey(Buffer.from('different-host-key'))).toBe(false);
    client.emit('error', new Error('Host key verification failed.'));

    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connection_error',
    });
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
  });

  test('releases credentials before authentication rejection settles', async () => {
    const { session, client } = createSession();
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'rejected-test-private-key',
      passphrase: 'rejected-test-passphrase',
    };
    const connecting = session.connect(ownedProfile, {
      cols: 80,
      rows: 24,
    });

    client.emit('error', new Error('Authentication rejected.'));

    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connection_error',
    });
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
  });

  test('releases credentials and destroys the client when the browser cancels before authentication', async () => {
    const { session, client } = createSession();
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'cancelled-test-private-key',
      passphrase: 'cancelled-test-passphrase',
    };
    const connecting = session.connect(ownedProfile, {
      cols: 80,
      rows: 24,
    });

    session.close();

    await expect(connecting).rejects.toBeInstanceOf(SshConnectError);
    await connecting.catch((error: SshConnectError) => {
      expect(error.reason).toBe('ssh_session_cancelled');
    });
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
    expect(client.destroyCount).toBe(1);
  });

  test('times out and destroys the client when the shell never opens', async () => {
    vi.useFakeTimers();
    const { session, client } = createSession({ connectDeadlineMs: 5_000 });
    const connecting = session.connect(
      { ...profile },
      { cols: 80, rows: 24 },
    );

    client.emit('ready');
    expect(client.shellCount).toBe(1);

    // Attach the rejection handler before firing the deadline so the reject is
    // never momentarily unhandled while fake timers advance.
    const rejects = expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connect_timeout',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejects;
    expect(client.destroyCount).toBe(1);
  });

  test('releases credentials before an authentication timeout settles', async () => {
    vi.useFakeTimers();
    const { session, client } = createSession({ connectDeadlineMs: 5_000 });
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'timeout-test-private-key',
      passphrase: 'timeout-test-passphrase',
    };
    const connecting = session.connect(ownedProfile, {
      cols: 80,
      rows: 24,
    });
    const rejects = expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connect_timeout',
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await rejects;

    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
    expect(client.destroyCount).toBe(1);
  });

  test('releases credentials when the SSH connection closes before it is ready', async () => {
    const { session, client } = createSession();
    const ownedProfile: SshConnectionProfile = {
      ...profile,
      privateKey: 'closed-test-private-key',
      passphrase: 'closed-test-passphrase',
    };
    const connecting = session.connect(ownedProfile, {
      cols: 80,
      rows: 24,
    });

    // A bare close (no preceding error) must still settle connect() so the
    // caller never hangs on a dropped dial.
    client.emit('close');

    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connection_closed',
    });
    expect(Boolean(ownedProfile.privateKey || ownedProfile.passphrase)).toBe(
      false,
    );
    expect(client.retainsAuthenticationCredentials()).toBe(false);
  });

  test('settles connect only once when an error arrives before a late ready', async () => {
    const { session, client } = createSession();
    const closes: string[] = [];
    session.on('close', (reason) => closes.push(reason));
    const connecting = session.connect(
      { ...profile },
      { cols: 80, rows: 24 },
    );

    client.emit('error', new Error('handshake failed'));
    // ssh2 emits close after destroy(); a failed dial must not masquerade as a
    // runtime close from an established terminal session.
    client.emit('close');
    // A late ready after the failure must not open a shell or re-settle.
    client.emit('ready');

    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_connection_error',
    });
    expect(client.shellCount).toBe(0);
    expect(client.destroyCount).toBe(1);
    expect(closes).toEqual([]);
  });

  test('resolves once, then routes a later connection close as a close event', async () => {
    const { session, client } = createSession();
    const closes: string[] = [];
    session.on('close', (reason) => closes.push(reason));

    const connecting = session.connect(
      { ...profile },
      { cols: 80, rows: 24 },
    );
    client.emit('ready');
    client.openShell(fakeChannel());

    await expect(connecting).resolves.toBeUndefined();

    client.emit('close');
    expect(closes).toEqual(['ssh_connection_closed']);
    // The session was already established, so tearing the client down again is
    // never abortive here (no lingering dial to destroy).
    expect(client.destroyCount).toBe(0);
  });

  test('rejects when the shell fails to open', async () => {
    const { session, client } = createSession();
    const connecting = session.connect(
      { ...profile },
      { cols: 80, rows: 24 },
    );

    client.emit('ready');
    client.failShell(new Error('channel open failure'));

    await expect(connecting).rejects.toMatchObject({
      reason: 'ssh_shell_open_failed',
    });
    expect(client.destroyCount).toBe(1);
  });
});

describe('SshTerminalSession write backpressure (#77)', () => {
  test('reports the channel accepted the input when write() returns true', async () => {
    const { session } = await establishedSession(fakeChannel(true));
    expect(session.write('ls\n')).toBe(true);
  });

  test('surfaces SSH write backpressure when the channel buffer is full', async () => {
    const { session } = await establishedSession(fakeChannel(false));
    expect(session.write('flood')).toBe(false);
  });

  test('emits drain when the channel drains so the broker can resume queued input', async () => {
    const channel = fakeChannel(false);
    const { session } = await establishedSession(channel);
    const drains: number[] = [];
    session.on('drain', () => drains.push(1));

    (channel as unknown as EventEmitter).emit('drain');

    expect(drains).toEqual([1]);
  });

  test('reports writable before a channel is attached so pre-ready input never stalls the queue', () => {
    const { session } = createSession();
    expect(session.write('typed before ready')).toBe(true);
  });
});
