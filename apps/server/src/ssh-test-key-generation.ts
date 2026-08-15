import { utils, type ParsedKey } from 'ssh2';

const DEFAULT_MAX_ATTEMPTS = 64;

type GeneratedKeyPair = {
  private: string;
  public: string;
};

type DisposableParsedKey = ParsedKey & {
  dispose(): boolean;
};

type GenerateValidatedEd25519KeyPairOptions = {
  passphrase?: string | undefined;
  maxAttempts?: number;
  generateKeyPair?: () => GeneratedKeyPair;
  parseKey?: typeof utils.parseKey;
};

// ssh2 1.17.0 can intermittently emit malformed OpenSSH keys in tests. Keep
// production behavior untouched: test callers accept only output that the same
// pinned parser can consume, and every parser-validation key is disposed.
export function generateValidatedEd25519KeyPair(
  options: GenerateValidatedEd25519KeyPairOptions = {},
): GeneratedKeyPair {
  const {
    passphrase,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    parseKey = utils.parseKey,
  } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('SSH test key generation requires a positive retry bound.');
  }

  const generateKeyPair =
    options.generateKeyPair ??
    (() =>
      passphrase === undefined
        ? utils.generateKeyPairSync('ed25519')
        : utils.generateKeyPairSync('ed25519', {
            passphrase,
            cipher: 'aes256-ctr',
            rounds: 16,
          }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = generateKeyPair();
    const parsed = parseKey(generated.private, passphrase);
    if (parsed instanceof Error) {
      generated.private = '';
      continue;
    }

    const validationKey = parsed as DisposableParsedKey;
    let isPrivateKey = false;
    let disposed = false;
    try {
      isPrivateKey = validationKey.isPrivateKey();
    } finally {
      try {
        disposed =
          typeof validationKey.dispose === 'function' &&
          validationKey.dispose() === true &&
          validationKey.getPrivatePEM() === null;
      } catch {
        disposed = false;
      }
    }

    if (!disposed) {
      generated.private = '';
      throw new Error(
        'SSH test key validation could not dispose its parsed private key.',
      );
    }
    if (isPrivateKey) return generated;
    generated.private = '';
  }

  throw new Error(
    `Failed to generate a parser-valid ed25519 SSH test key after ${maxAttempts} attempts.`,
  );
}
