import { describe, expect, test } from 'vitest';
import type { ParsedKey } from 'ssh2';
import { generateValidatedEd25519KeyPair } from './ssh-test-key-generation';

type DisposableParsedKey = ParsedKey & {
  dispose(): boolean;
};

describe('SSH test key generation', () => {
  test('retries parser-rejected output and disposes the validation key', () => {
    const generated = [
      { private: 'malformed-generated-key', public: 'malformed-public-key' },
      { private: 'parser-valid-key', public: 'parser-valid-public-key' },
    ];
    const parsedPrivatePem = { value: 'generated-private-pem' as string | null };
    const validationKey = {
      isPrivateKey: () => true,
      getPrivatePEM: () => parsedPrivatePem.value,
      dispose: () => {
        parsedPrivatePem.value = null;
        return true;
      },
    } as DisposableParsedKey;
    const parsedInputs: Array<{
      privateKey: string;
      passphrase: string | undefined;
    }> = [];

    const result = generateValidatedEd25519KeyPair({
      passphrase: 'correct-passphrase',
      generateKeyPair: () => generated.shift()!,
      parseKey: (privateKey, passphrase) => {
        parsedInputs.push({
          privateKey: privateKey as string,
          passphrase: passphrase as string | undefined,
        });
        return privateKey === 'parser-valid-key'
          ? validationKey
          : new Error('malformed generated key');
      },
      maxAttempts: 2,
    });

    expect(result).toEqual({
      private: 'parser-valid-key',
      public: 'parser-valid-public-key',
    });
    expect(parsedInputs).toEqual([
      {
        privateKey: 'malformed-generated-key',
        passphrase: 'correct-passphrase',
      },
      {
        privateKey: 'parser-valid-key',
        passphrase: 'correct-passphrase',
      },
    ]);
    expect(parsedPrivatePem.value).toBeNull();
  });

  test('fails clearly after the bounded parser-validation retries', () => {
    let attempts = 0;

    expect(() =>
      generateValidatedEd25519KeyPair({
        generateKeyPair: () => {
          attempts += 1;
          return {
            private: `malformed-generated-key-${attempts}`,
            public: 'malformed-public-key',
          };
        },
        parseKey: () => new Error('malformed generated key'),
      }),
    ).toThrow(
      'Failed to generate a parser-valid ed25519 SSH test key after 64 attempts.',
    );
    expect(attempts).toBe(64);
  });
});
