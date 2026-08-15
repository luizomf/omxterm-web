#!/usr/bin/env node

// Stock ssh2 has no supported hook for releasing its authentication closure.
// This project-owned source adaptation accepts only the audited 1.17.0
// preimage or the exact complete postimage; any other installed tree fails.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SSH2_VERSION = '1.17.0';
const SSH2_INTEGRITY =
  'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==';
const SSH2_PACKAGE_JSON_SHA256 =
  'e6fd4e4c3e69e4ad185c87cb5ee1df631e3f4cbd43cf89470f83c1e5d1a76dfb';

const ADAPTATION_FILES = [
  {
    path: 'lib/client.js',
    upstreamSha256:
      'edd3484daa9d942bc5a6412edc9cf11f85df40b2db10b07877bbfe694beac7f4',
    adaptedSha256:
      'cf55735db830d6198b8cb02eb0eadbeb0c2639df18bbf3bc5b1dffc841fd1d44',
    replacements: [
      {
        upstream: `    this._resetKA = undefined;
  }

  connect(cfg) {`,
        adapted: `    this._resetKA = undefined;

    // OMXTerm's pinned adaptation installs one per-connect disposer. The
    // boolean is runtime evidence for the adapter; it carries no credentials.
    this._disposeAuthMaterial = undefined;
    this._authMaterialDisposed = true;
  }

  disposeAuthMaterial() {
    if (this._authMaterialDisposed)
      return true;
    if (typeof this._disposeAuthMaterial !== 'function')
      return false;
    return this._disposeAuthMaterial();
  }

  isAuthMaterialDisposed() {
    return this._authMaterialDisposed === true;
  }

  connect(cfg) {`,
      },
      {
        upstream: `    let callbacks = this._callbacks = [];
    this._chanMgr = new ChannelManager(this);
    this._forwarding = {};
    this._forwardingUnix = {};
    this._acceptX11 = 0;
    this._agentFwdEnabled = false;
    this._agent = (this.config.agent ? this.config.agent : undefined);
    this._remoteVer = undefined;
    let privateKey;

    if (this.config.privateKey) {
      privateKey = parseKey(this.config.privateKey, cfg.passphrase);
      if (privateKey instanceof Error)
        throw new Error(\`Cannot parse privateKey: \${privateKey.message}\`);
      if (Array.isArray(privateKey)) {
        // OpenSSH's newer format only stores 1 key for now
        privateKey = privateKey[0];
      }
      if (privateKey.getPrivatePEM() === null) {
        throw new Error(
          'privateKey value does not contain a (valid) private key'
        );
      }
    }
`,
        adapted: `    let callbacks = this._callbacks = [];
    this._chanMgr = new ChannelManager(this);
    this._forwarding = {};
    this._forwardingUnix = {};
    this._acceptX11 = 0;
    this._agentFwdEnabled = false;
    this._agent = (this.config.agent ? this.config.agent : undefined);
    this._remoteVer = undefined;
    let privateKey;
    let curAuth;

    this._authMaterialDisposed = false;
    const clearField = (object, field) => {
      try {
        object[field] = undefined;
      } catch {}
      return object[field] === undefined;
    };
    const clearRawAuthMaterial = () => {
      const inputKeyCleared = clearField(cfg, 'privateKey');
      const inputPassphraseCleared = clearField(cfg, 'passphrase');
      const configKeyCleared = clearField(this.config, 'privateKey');
      return inputKeyCleared && inputPassphraseCleared && configKeyCleared;
    };
    const disposeKey = (key) => {
      if (key === undefined || key === null)
        return true;
      if (Array.isArray(key)) {
        let disposed = true;
        for (const parsedKey of key)
          disposed = disposeKey(parsedKey) && disposed;
        return disposed;
      }
      return (
        typeof key.dispose === 'function'
        && key.dispose() === true
        && key.getPrivatePEM() === null
      );
    };
    const disposeAuthMaterial = () => {
      if (this._authMaterialDisposed)
        return true;

      const currentKey = curAuth && curAuth.key;
      const currentKeyDisposed = disposeKey(currentKey);
      const privateKeyDisposed = (
        currentKey === privateKey
        ? currentKeyDisposed
        : disposeKey(privateKey)
      );
      const keysDisposed = currentKeyDisposed && privateKeyDisposed;
      curAuth = undefined;
      privateKey = undefined;
      authHandler = undefined;

      const rawCleared = clearRawAuthMaterial();
      const inputHandlerCleared = clearField(cfg, 'authHandler');
      const configHandlerCleared = clearField(this.config, 'authHandler');
      const disposed = (
        keysDisposed
        && rawCleared
        && inputHandlerCleared
        && configHandlerCleared
        && curAuth === undefined
        && privateKey === undefined
        && authHandler === undefined
      );
      this._authMaterialDisposed = disposed;
      if (disposed)
        this._disposeAuthMaterial = undefined;
      return disposed;
    };
    this._disposeAuthMaterial = disposeAuthMaterial;

    try {
      if (this.config.privateKey) {
        privateKey = parseKey(this.config.privateKey, cfg.passphrase);
        if (privateKey instanceof Error) {
          const keyError = privateKey;
          privateKey = undefined;
          throw new Error(\`Cannot parse privateKey: \${keyError.message}\`);
        }
        if (Array.isArray(privateKey)) {
          // OpenSSH's newer format only stores 1 key for now
          privateKey = privateKey[0];
        }
        if (privateKey.getPrivatePEM() === null) {
          throw new Error(
            'privateKey value does not contain a (valid) private key'
          );
        }
      }
      if (!clearRawAuthMaterial())
        throw new Error('Failed to release raw authentication material');
    } catch (err) {
      this.disposeAuthMaterial();
      throw err;
    }
`,
      },
      {
        upstream: `        if (!proto._destruct)
          sock.removeAllListeners('data');
        this.emit('error', err);`,
        adapted: `        if (!proto._destruct)
          sock.removeAllListeners('data');
        if (!this.disposeAuthMaterial()) {
          err = new Error('Failed to dispose authentication material');
          err.level = 'client-authentication';
        }
        this.emit('error', err);`,
      },
      {
        upstream: `            const err = new Error(desc);
            err.code = reason;
            this.emit('error', err);`,
        adapted: `            let err = new Error(desc);
            if (!this.disposeAuthMaterial()) {
              err = new Error('Failed to dispose authentication material');
              err.level = 'client-authentication';
            } else {
              err.code = reason;
            }
            this.emit('error', err);`,
      },
      {
        upstream: `            } catch (ex) {
              this.emit('error', ex);
              try {`,
        adapted: `            } catch (ex) {
              if (!this.disposeAuthMaterial()) {
                ex = new Error('Failed to dispose authentication material');
                ex.level = 'client-authentication';
              }
              this.emit('error', ex);
              try {`,
      },
      {
        upstream: `        }).catch((err) => {
          this.emit('error', err);
          try {`,
        adapted: `        }).catch((err) => {
          if (!this.disposeAuthMaterial()) {
            err = new Error('Failed to dispose authentication material');
            err.level = 'client-authentication';
          }
          this.emit('error', err);
          try {`,
      },
      {
        upstream: `            const error = new Error(
              \`Error while looking up \${type} address for '\${host}': \${err}\`
            );
            clearTimeout(this._readyTimeout);
            error.level = 'client-dns';
            this.emit('error', error);`,
        adapted: `            let error = new Error(
              \`Error while looking up \${type} address for '\${host}': \${err}\`
            );
            clearTimeout(this._readyTimeout);
            if (!this.disposeAuthMaterial()) {
              error = new Error('Failed to dispose authentication material');
              error.level = 'client-authentication';
            } else {
              error.level = 'client-dns';
            }
            this.emit('error', error);`,
      },
      {
        upstream: `        USERAUTH_SUCCESS: (p) => {
          // Start keepalive mechanism
          resetKA();`,
        adapted: `        USERAUTH_SUCCESS: (p) => {
          if (!this.disposeAuthMaterial()) {
            const err = new Error('Failed to dispose authentication material');
            err.level = 'client-authentication';
            this.emit('error', err);
            this.end();
            return;
          }

          // Start keepalive mechanism
          resetKA();`,
      },
      {
        upstream: `      if (nextAuth === false) {
        const err = new Error('All configured authentication methods failed');
        err.level = 'client-authentication';
        this.emit('error', err);`,
        adapted: `      if (nextAuth === false) {
        const disposed = this.disposeAuthMaterial();
        const err = new Error(
          disposed
          ? 'All configured authentication methods failed'
          : 'Failed to dispose authentication material'
        );
        err.level = 'client-authentication';
        this.emit('error', err);`,
      },
      {
        upstream: `    }).on('error', (err) => {
      debug && debug(\`Socket error: \${err.message}\`);
      clearTimeout(this._readyTimeout);
      err.level = 'client-socket';
      this.emit('error', err);`,
        adapted: `    }).on('error', (err) => {
      debug && debug(\`Socket error: \${err.message}\`);
      clearTimeout(this._readyTimeout);
      if (!this.disposeAuthMaterial()) {
        err = new Error('Failed to dispose authentication material');
        err.level = 'client-authentication';
      } else {
        err.level = 'client-socket';
      }
      this.emit('error', err);`,
      },
      {
        upstream: `      return () => {
        if (called)
          return;
        called = true;
        if (wasConnected && !sawHeader) {`,
        adapted: `      return () => {
        if (called)
          return;
        called = true;
        this.disposeAuthMaterial();
        if (wasConnected && !sawHeader) {`,
      },
      {
        upstream: `        this._readyTimeout = setTimeout(() => {
          const err = new Error('Timed out while waiting for handshake');
          err.level = 'client-timeout';
          this.emit('error', err);`,
        adapted: `        this._readyTimeout = setTimeout(() => {
          const disposed = this.disposeAuthMaterial();
          const err = new Error(
            disposed
            ? 'Timed out while waiting for handshake'
            : 'Failed to dispose authentication material'
          );
          err.level = 'client-timeout';
          this.emit('error', err);`,
      },
      {
        upstream: `  end() {
    if (this._sock && isWritable(this._sock)) {`,
        adapted: `  end() {
    this.disposeAuthMaterial();
    if (this._sock && isWritable(this._sock)) {`,
      },
      {
        upstream: `  destroy() {
    this._sock && isWritable(this._sock) && this._sock.destroy();`,
        adapted: `  destroy() {
    this.disposeAuthMaterial();
    this._sock && isWritable(this._sock) && this._sock.destroy();`,
      },
      {
        upstream: `    let curAuth;
    let curPartial = null;`,
        adapted: `    let curPartial = null;`,
      },
    ],
  },
  {
    path: 'lib/protocol/keyParser.js',
    upstreamSha256:
      'ba4f40a5a9edef15ff49a38226e2be2e66f75aa2673840dd18b807bb7943eca9',
    adaptedSha256:
      'a2db7d2f49d334f09aafe79af0882ca933bbfaa09089852ef50acf76d238889b',
    replacements: [
      {
        upstream: `  getPrivatePEM: function getPrivatePEM() {
    return this[SYM_PRIV_PEM];
  },
  getPublicPEM: function getPublicPEM() {`,
        adapted: `  getPrivatePEM: function getPrivatePEM() {
    return this[SYM_PRIV_PEM];
  },
  dispose: function dispose() {
    this[SYM_PRIV_PEM] = null;
    return this[SYM_PRIV_PEM] === null;
  },
  getPublicPEM: function getPublicPEM() {`,
      },
    ],
  },
];

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function replaceExactlyOnce(source, replacement, filePath) {
  const first = source.indexOf(replacement.upstream);
  const last = source.lastIndexOf(replacement.upstream);
  if (first === -1 || first !== last) {
    throw new Error(
      `ssh2 adaptation preimage mismatch in ${filePath}; refusing a partial or drifted patch`,
    );
  }
  return `${source.slice(0, first)}${replacement.adapted}${source.slice(
    first + replacement.upstream.length,
  )}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function assertPinnedPackage(projectRoot, ssh2Root) {
  const [rootPackage, lock, installedPackage, installedPackageText] =
    await Promise.all([
      readJson(path.join(projectRoot, 'package.json')),
      readJson(path.join(projectRoot, 'package-lock.json')),
      readJson(path.join(ssh2Root, 'package.json')),
      readFile(path.join(ssh2Root, 'package.json')),
    ]);
  const locked = lock.packages?.['node_modules/ssh2'];
  const server = lock.packages?.['apps/server'];

  if (
    rootPackage.workspaces?.includes('apps/*') !== true ||
    server?.dependencies?.ssh2 !== SSH2_VERSION ||
    locked?.version !== SSH2_VERSION ||
    locked?.integrity !== SSH2_INTEGRITY ||
    installedPackage.name !== 'ssh2' ||
    installedPackage.version !== SSH2_VERSION ||
    sha256(installedPackageText) !== SSH2_PACKAGE_JSON_SHA256
  ) {
    throw new Error(
      `ssh2 adaptation requires the exact locked ssh2 ${SSH2_VERSION} package`,
    );
  }
}

export async function adaptSsh2AuthenticationMaterial({
  projectRoot = DEFAULT_PROJECT_ROOT,
  mode = 'apply',
} = {}) {
  if (mode !== 'apply' && mode !== 'verify') {
    throw new Error(`Unknown ssh2 adaptation mode: ${mode}`);
  }

  const ssh2Root = path.join(projectRoot, 'node_modules', 'ssh2');
  await assertPinnedPackage(projectRoot, ssh2Root);

  const inspected = await Promise.all(
    ADAPTATION_FILES.map(async (file) => {
      const filePath = path.join(ssh2Root, file.path);
      const source = await readFile(filePath, 'utf8');
      const digest = sha256(source);
      const state =
        digest === file.upstreamSha256
          ? 'upstream'
          : digest === file.adaptedSha256
            ? 'adapted'
            : 'drifted';
      return { file, filePath, source, state };
    }),
  );

  if (inspected.some(({ state }) => state === 'drifted')) {
    throw new Error(
      `ssh2 ${SSH2_VERSION} source drift detected; refusing to apply or trust the authentication-material adaptation`,
    );
  }

  const states = new Set(inspected.map(({ state }) => state));
  if (states.size !== 1) {
    throw new Error(
      `ssh2 ${SSH2_VERSION} is only partially adapted; refusing the installed tree`,
    );
  }

  const [state] = states;
  if (state === 'adapted') {
    return { state: 'verified', version: SSH2_VERSION };
  }
  if (mode === 'verify') {
    throw new Error(
      `ssh2 ${SSH2_VERSION} is unadapted; run the repository install lifecycle`,
    );
  }

  const outputs = inspected.map(({ file, filePath, source }) => {
    let adapted = source;
    for (const replacement of file.replacements) {
      adapted = replaceExactlyOnce(adapted, replacement, filePath);
    }
    if (sha256(adapted) !== file.adaptedSha256) {
      throw new Error(
        `ssh2 adaptation output mismatch in ${filePath}; refusing to write`,
      );
    }
    return { filePath, adapted };
  });

  await Promise.all(
    outputs.map(({ filePath, adapted }) => writeFile(filePath, adapted)),
  );

  await adaptSsh2AuthenticationMaterial({ projectRoot, mode: 'verify' });
  return { state: 'applied', version: SSH2_VERSION };
}

async function main() {
  const argument = process.argv[2] ?? '--apply';
  const mode =
    argument === '--verify'
      ? 'verify'
      : argument === '--apply'
        ? 'apply'
        : null;
  if (!mode) {
    throw new Error(
      `Usage: ${path.basename(SCRIPT_PATH)} [--apply|--verify]`,
    );
  }
  const result = await adaptSsh2AuthenticationMaterial({ mode });
  console.log(
    `ssh2 auth-material adaptation: ${result.state} ssh2 ${result.version}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ssh2 auth-material adaptation failed: ${message}`);
    process.exitCode = 1;
  });
}
