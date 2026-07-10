import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SshConnectionProfile } from '@omxterm/core/stores';
import type { ClientChannel } from 'ssh2';
import {
  normalizeFingerprint,
  SshConnectError,
  type SshClientDriver,
  type SshShellCallback,
  SshTerminalSession,
  sshDialHost,
} from './ssh';

describe('normalizeFingerprint', () => {
  test('trims padding and whitespace for session fingerprint comparison', () => {
    expect(normalizeFingerprint(' SHA256:abc== ')).toBe('SHA256:abc');
  });
});

describe('sshDialHost', () => {
  test('dials the pinned validated IP instead of the hostname so ssh2 never re-resolves (#26)', () => {
    expect(sshDialHost({ host: 'kvm4.vpn', pinnedAddress: '10.100.0.4' })).toBe('10.100.0.4');
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
class FakeSshClient extends EventEmitter implements SshClientDriver {
  connectCount = 0;
  shellCount = 0;
  endCount = 0;
  destroyCount = 0;
  #shellCallback: SshShellCallback | null = null;

  connect(): this {
    this.connectCount += 1;
    return this;
  }

  shell(_options: unknown, callback: SshShellCallback): this {
    this.shellCount += 1;
    this.#shellCallback = callback;
    return this;
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

function fakeChannel(): ClientChannel {
  const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void };
  channel.stderr = new EventEmitter();
  channel.close = () => channel.emit('close');
  return channel as unknown as ClientChannel;
}

function createSession(overrides: { connectDeadlineMs?: number } = {}): {
  session: SshTerminalSession;
  client: FakeSshClient;
} {
  const client = new FakeSshClient();
  const session = new SshTerminalSession({
    createClient: () => client,
    connectDeadlineMs: overrides.connectDeadlineMs ?? 20_000,
  });
  return { session, client };
}

describe('SshTerminalSession lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('destroys the client and rejects connect when closed before the SSH connection is ready', async () => {
    const { session, client } = createSession();
    const connecting = session.connect(profile, { cols: 80, rows: 24 });

    session.close();

    await expect(connecting).rejects.toBeInstanceOf(SshConnectError);
    await connecting.catch((error: SshConnectError) => {
      expect(error.reason).toBe('ssh_session_cancelled');
    });
    expect(client.destroyCount).toBe(1);
  });

  test('times out and destroys the client when the shell never opens', async () => {
    vi.useFakeTimers();
    const { session, client } = createSession({ connectDeadlineMs: 5_000 });
    const connecting = session.connect(profile, { cols: 80, rows: 24 });

    client.emit('ready');
    expect(client.shellCount).toBe(1);

    // Attach the rejection handler before firing the deadline so the reject is
    // never momentarily unhandled while fake timers advance.
    const rejects = expect(connecting).rejects.toMatchObject({ reason: 'ssh_connect_timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejects;
    expect(client.destroyCount).toBe(1);
  });

  test('rejects when the SSH connection closes before it is ready', async () => {
    const { session, client } = createSession();
    const connecting = session.connect(profile, { cols: 80, rows: 24 });

    // A bare close (no preceding error) must still settle connect() so the
    // caller never hangs on a dropped dial.
    client.emit('close');

    await expect(connecting).rejects.toMatchObject({ reason: 'ssh_connection_closed' });
  });

  test('settles connect only once when an error arrives before a late ready', async () => {
    const { session, client } = createSession();
    const closes: string[] = [];
    session.on('close', reason => closes.push(reason));
    const connecting = session.connect(profile, { cols: 80, rows: 24 });

    client.emit('error', new Error('handshake failed'));
    // ssh2 emits close after destroy(); a failed dial must not masquerade as a
    // runtime close from an established terminal session.
    client.emit('close');
    // A late ready after the failure must not open a shell or re-settle.
    client.emit('ready');

    await expect(connecting).rejects.toMatchObject({ reason: 'ssh_connection_error' });
    expect(client.shellCount).toBe(0);
    expect(client.destroyCount).toBe(1);
    expect(closes).toEqual([]);
  });

  test('resolves once, then routes a later connection close as a close event', async () => {
    const { session, client } = createSession();
    const closes: string[] = [];
    session.on('close', reason => closes.push(reason));

    const connecting = session.connect(profile, { cols: 80, rows: 24 });
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
    const connecting = session.connect(profile, { cols: 80, rows: 24 });

    client.emit('ready');
    client.failShell(new Error('channel open failure'));

    await expect(connecting).rejects.toMatchObject({ reason: 'ssh_shell_open_failed' });
    expect(client.destroyCount).toBe(1);
  });
});
