import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, test } from 'vitest';
import {
  Client,
  Server,
  utils,
  type AnyAuthMethod,
  type ConnectConfig,
  type NextAuthHandler,
  type ParsedKey,
} from 'ssh2';
import { generateValidatedEd25519KeyPair } from './ssh-test-key-generation';

// Integration coverage uses the installed pinned parser/client and an in-process
// ssh2 server on an ephemeral loopback port. It never reaches an external host.
type DisposableParsedKey = ParsedKey & {
  dispose(): boolean;
};

type AdaptedClient = Client & {
  disposeAuthMaterial(): boolean;
  isAuthMaterialDisposed(): boolean;
};

describe('pinned ssh2 authentication-material adaptation', () => {
  test('disposes generated private PEM while preserving public-key operations', () => {
    const generated = generateValidatedEd25519KeyPair();
    let privateKey: string | undefined = generated.private;
    generated.private = '';

    const parsed = utils.parseKey(privateKey) as DisposableParsedKey | Error;
    privateKey = undefined;
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;

    const publicPem = parsed.getPublicPEM();
    const publicSsh = Buffer.from(parsed.getPublicSSH());
    const message = Buffer.from('ssh2-disposal-contract');
    const signature = parsed.sign(message);

    expect(parsed.dispose()).toBe(true);
    expect(parsed.getPrivatePEM()).toBeNull();
    expect(parsed.isPrivateKey()).toBe(false);
    expect(parsed.getPublicPEM()).toBe(publicPem);
    expect(parsed.getPublicSSH()).toEqual(publicSsh);
    expect(parsed.verify(message, signature)).toBe(true);
  });

  test('preserves encrypted OpenSSH missing, wrong, and correct passphrase behavior', () => {
    let passphrase: string | undefined = 'parser-passphrase';
    const generated = generateValidatedEd25519KeyPair({ passphrase });
    let privateKey: string | undefined = generated.private;
    generated.private = '';

    expect(utils.parseKey(privateKey)).toBeInstanceOf(Error);
    expect(utils.parseKey(privateKey, 'wrong-parser-passphrase')).toBeInstanceOf(
      Error,
    );
    const parsed = utils.parseKey(privateKey, passphrase) as
      | DisposableParsedKey
      | Error;
    privateKey = undefined;
    passphrase = undefined;

    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) return;
    expect(parsed.isPrivateKey()).toBe(true);
    expect(parsed.dispose()).toBe(true);
  });

  test('disposes raw authentication configuration before a parse failure escapes', () => {
    const client = new Client() as AdaptedClient;
    const config: ConnectConfig = {
      host: '127.0.0.1',
      username: 'test',
      privateKey: 'not-a-private-key',
      passphrase: 'not-a-passphrase',
    };

    expect(() => client.connect(config)).toThrow('Cannot parse privateKey');
    expect(client.isAuthMaterialDisposed()).toBe(true);
    expect(client.disposeAuthMaterial()).toBe(true);
    expect(config.privateKey).toBeUndefined();
    expect(config.passphrase).toBeUndefined();
  });

  test('disposes before a real host-key rejection is observable', async () => {
    const generatedHost = generateValidatedEd25519KeyPair();
    const server = new Server({ hostKeys: [generatedHost.private] });
    generatedHost.private = '';
    server.on('connection', (connection) => connection.on('error', () => {}));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'rejected-host-user',
      privateKey: generatedClient.private,
      hostVerifier: () => false,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => reject(new Error('Unexpected SSH ready')));
        client.once('error', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
      });
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('disposes before a real authentication rejection is observable', async () => {
    const generatedHost = generateValidatedEd25519KeyPair();
    const server = new Server({ hostKeys: [generatedHost.private] });
    generatedHost.private = '';
    server.on('connection', (connection) => {
      connection.on('error', () => {});
      connection.on('authentication', (context) => context.reject());
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'rejected-auth-user',
      privateKey: generatedClient.private,
      hostVerifier: () => true,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => reject(new Error('Unexpected SSH ready')));
        client.once('error', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
      });
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('disposes before a real handshake timeout is observable', async () => {
    const sockets = new Set<Socket>();
    const idleServer = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      idleServer.once('error', reject);
      idleServer.listen(0, '127.0.0.1', resolve);
    });

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (idleServer.address() as AddressInfo).port,
      username: 'timeout-user',
      privateKey: generatedClient.private,
      readyTimeout: 10,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;

    try {
      await new Promise<void>((resolve, reject) => {
        let observedFailure = false;
        client.once('ready', () => reject(new Error('Unexpected SSH ready')));
        client.on('error', () => {
          if (observedFailure) return;
          observedFailure = true;
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
      });
    } finally {
      client.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => idleServer.close(() => resolve()));
    }
  });

  test('disposes synchronously when a pending connection is cancelled', async () => {
    const sockets = new Set<Socket>();
    const idleServer = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      idleServer.once('error', reject);
      idleServer.listen(0, '127.0.0.1', resolve);
    });

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (idleServer.address() as AddressInfo).port,
      username: 'cancelled-user',
      privateKey: generatedClient.private,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;
    client.on('error', () => {});

    try {
      client.connect(config);
      expect(client.isAuthMaterialDisposed()).toBe(false);

      client.destroy();

      expect(client.isAuthMaterialDisposed()).toBe(true);
      expect(config.privateKey).toBeUndefined();
    } finally {
      client.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => idleServer.close(() => resolve()));
    }
  });

  test('rejects a delayed authentication callback after cancellation without stale disposal evidence', async () => {
    const generatedHost = generateValidatedEd25519KeyPair();
    const server = new Server({ hostKeys: [generatedHost.private] });
    generatedHost.private = '';
    server.on('connection', (connection) => connection.on('error', () => {}));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    let delayedCallback: NextAuthHandler | undefined;
    let resolveCallbackCaptured: (() => void) | undefined;
    const callbackCaptured = new Promise<void>((resolve) => {
      resolveCallbackCaptured = resolve;
    });
    const client = new Client() as AdaptedClient;
    client.on('error', () => {});
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'delayed-callback-user',
      hostVerifier: () => true,
      authHandler: (_methods, _partialSuccess, next) => {
        delayedCallback = next;
        resolveCallbackCaptured?.();
      },
    };

    try {
      client.connect(config);
      await callbackCaptured;
      resolveCallbackCaptured = undefined;
      client.destroy();
      expect(client.isAuthMaterialDisposed()).toBe(true);

      const generated = generateValidatedEd25519KeyPair();
      let parsedKey = utils.parseKey(generated.private) as
        | DisposableParsedKey
        | Error
        | undefined;
      generated.private = '';
      expect(parsedKey).not.toBeInstanceOf(Error);
      if (parsedKey instanceof Error || parsedKey === undefined) return;

      const observation: { calls: number; privatePem?: string | null } = {
        calls: 0,
      };
      const originalDispose = parsedKey.dispose;
      parsedKey.dispose = function observeDisposal() {
        const disposed = originalDispose.call(this);
        observation.calls += 1;
        observation.privatePem = this.getPrivatePEM();
        return disposed;
      };
      let delayedAttempt: AnyAuthMethod | undefined = {
        type: 'publickey',
        username: 'delayed-callback-user',
        key: parsedKey,
      };
      parsedKey = undefined;
      let invokeDelayed = delayedCallback;
      delayedCallback = undefined;

      expect(() => invokeDelayed?.(delayedAttempt!)).not.toThrow();
      invokeDelayed = undefined;
      delayedAttempt = undefined;

      expect(observation).toEqual({ calls: 1, privatePem: null });
      expect(client.isAuthMaterialDisposed()).toBe(true);
      expect(client.disposeAuthMaterial()).toBe(true);
      expect(observation.calls).toBe(1);
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('disposes before a terminal socket error is observable', async () => {
    const unavailableServer = createServer();
    await new Promise<void>((resolve, reject) => {
      unavailableServer.once('error', reject);
      unavailableServer.listen(0, '127.0.0.1', resolve);
    });
    const unavailablePort = (unavailableServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => unavailableServer.close(() => resolve()));

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: unavailablePort,
      username: 'socket-error-user',
      privateKey: generatedClient.private,
      readyTimeout: 500,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => reject(new Error('unexpected readiness')));
        client.once('error', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
      });
    } finally {
      client.destroy();
    }
  });

  test('disposes before an early connection close is observable', async () => {
    const sockets = new Set<Socket>();
    const closingServer = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      closingServer.once('error', reject);
      closingServer.listen(0, '127.0.0.1', resolve);
    });

    const generatedClient = generateValidatedEd25519KeyPair();
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: (closingServer.address() as AddressInfo).port,
      username: 'closed-user',
      privateKey: generatedClient.private,
    };
    generatedClient.private = '';
    const client = new Client() as AdaptedClient;

    try {
      await new Promise<void>((resolve, reject) => {
        client.on('error', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.once('close', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
      });
    } finally {
      client.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    }
  });

  test('disposes before real authentication readiness and preserves rekey plus shell operation', async () => {
    const generatedHost = generateValidatedEd25519KeyPair();
    let hostPrivateKey: string | undefined = generatedHost.private;
    generatedHost.private = '';
    const parsedHost = utils.parseKey(hostPrivateKey) as
      | DisposableParsedKey
      | Error;
    expect(parsedHost).not.toBeInstanceOf(Error);
    if (parsedHost instanceof Error) return;
    const expectedHostKey = Buffer.from(parsedHost.getPublicSSH());
    expect(parsedHost.dispose()).toBe(true);

    const server = new Server({ hostKeys: [hostPrivateKey] });
    hostPrivateKey = undefined;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const client = new Client() as AdaptedClient;
    try {
      let passphrase: string | undefined = 'integration-passphrase';
      const generatedClient = generateValidatedEd25519KeyPair({ passphrase });
      const config: ConnectConfig = {
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        username: 'integration-user',
        privateKey: generatedClient.private,
        passphrase,
        authHandler: ['publickey'],
        hostVerifier: (candidate: Buffer) => candidate.equals(expectedHostKey),
      };
      generatedClient.private = '';

      await new Promise<void>((resolve, reject) => {
        let clientReady = false;
        let handshakes = 0;
        let shellRequested = false;
        const requestShellAfterRekey = () => {
          if (!clientReady || handshakes < 2 || shellRequested) return;
          shellRequested = true;
          client.shell(
            { term: 'xterm-256color', cols: 80, rows: 24 },
            (error, channel) => {
              if (error) {
                reject(error);
                return;
              }
              let output = '';
              channel.on('data', (data: Buffer) => {
                output += data.toString('utf8');
              });
              channel.on('close', () => {
                try {
                  expect(output).toBe('shell-after-disposal');
                  resolve();
                } catch (assertionError) {
                  reject(assertionError);
                }
              });
            },
          );
        };

        server.once('connection', (connection) => {
          connection.on('error', reject);
          connection.on('authentication', (context) => {
            if (context.method === 'publickey') context.accept();
            else context.reject();
          });
          connection.on('ready', () => {
            connection.on('session', (accept) => {
              const session = accept();
              session.on('pty', (acceptPty) => acceptPty());
              session.on('shell', (acceptShell) => {
                const channel = acceptShell();
                channel.end('shell-after-disposal');
              });
            });
            connection.rekey();
          });
        });

        client.on('error', reject);
        client.on('handshake', () => {
          handshakes += 1;
          requestShellAfterRekey();
        });
        client.on('ready', () => {
          try {
            expect(client.isAuthMaterialDisposed()).toBe(true);
            expect(config.privateKey).toBeUndefined();
            expect(config.passphrase).toBeUndefined();
            expect(config.authHandler).toBeUndefined();
            clientReady = true;
            requestShellAfterRekey();
          } catch (assertionError) {
            reject(assertionError);
          }
        });
        client.connect(config);
        passphrase = undefined;
      });
    } finally {
      client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
