#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSsh2AuthenticationMaterial } from './ssh2-auth-material-adaptation.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const TEMP_ROOT = await mkdtemp(
  path.join(os.tmpdir(), 'omxterm-ssh2-adaptation-'),
);

async function copyInstalledProject(name) {
  const root = path.join(TEMP_ROOT, name);
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    cp(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json')),
    cp(
      path.join(REPO_ROOT, 'package-lock.json'),
      path.join(root, 'package-lock.json'),
    ),
    cp(
      path.join(REPO_ROOT, 'node_modules', 'ssh2'),
      path.join(root, 'node_modules', 'ssh2'),
      { recursive: true },
    ),
  ]);
  return root;
}

try {
  const installed = await adaptSsh2AuthenticationMaterial({
    projectRoot: REPO_ROOT,
    mode: 'verify',
  });
  assert.equal(installed.state, 'verified');

  const driftedRoot = await copyInstalledProject('source-drift');
  const driftedClient = path.join(
    driftedRoot,
    'node_modules',
    'ssh2',
    'lib',
    'client.js',
  );
  await writeFile(
    driftedClient,
    `${await readFile(driftedClient, 'utf8')}\n// unexpected drift\n`,
  );
  await assert.rejects(
    adaptSsh2AuthenticationMaterial({
      projectRoot: driftedRoot,
      mode: 'verify',
    }),
    /source drift detected/u,
  );

  const protocolDriftRoot = await copyInstalledProject('protocol-drift');
  const driftedProtocol = path.join(
    protocolDriftRoot,
    'node_modules',
    'ssh2',
    'lib',
    'protocol',
    'Protocol.js',
  );
  const protocolSource = await readFile(driftedProtocol, 'utf8');
  const protocolWithPrivateKeyRetention = protocolSource
    .replace(
      '  authPK(username, pubKey, keyAlgo, cbSign) {',
      `  authPK(username, pubKey, keyAlgo, cbSign) {
    const retainedPrivatePEM = pubKey.getPrivatePEM();`,
    )
    .replace(
      '    cbSign(packet, (signature) => {',
      `    cbSign(packet, (signature) => {
      void retainedPrivatePEM;`,
    );
  assert.notEqual(protocolWithPrivateKeyRetention, protocolSource);
  await writeFile(driftedProtocol, protocolWithPrivateKeyRetention);
  for (const mode of ['apply', 'verify']) {
    await assert.rejects(
      adaptSsh2AuthenticationMaterial({
        projectRoot: protocolDriftRoot,
        mode,
      }),
      /source drift detected/u,
    );
  }

  const versionDriftRoot = await copyInstalledProject('version-drift');
  const dependencyPackagePath = path.join(
    versionDriftRoot,
    'node_modules',
    'ssh2',
    'package.json',
  );
  const dependencyPackage = JSON.parse(
    await readFile(dependencyPackagePath, 'utf8'),
  );
  dependencyPackage.version = '1.17.1';
  await writeFile(
    dependencyPackagePath,
    `${JSON.stringify(dependencyPackage, null, 2)}\n`,
  );
  await assert.rejects(
    adaptSsh2AuthenticationMaterial({
      projectRoot: versionDriftRoot,
      mode: 'verify',
    }),
    /requires the exact locked ssh2 1\.17\.0 package/u,
  );

  const partialRoot = await copyInstalledProject('partial-patch');
  const keyParserPath = path.join(
    partialRoot,
    'node_modules',
    'ssh2',
    'lib',
    'protocol',
    'keyParser.js',
  );
  const adaptedKeyParser = await readFile(keyParserPath, 'utf8');
  const dispositionMethod = `  dispose: function dispose() {
    this[SYM_PRIV_PEM] = null;
    return this[SYM_PRIV_PEM] === null;
  },
`;
  assert.equal(adaptedKeyParser.split(dispositionMethod).length, 2);
  await writeFile(
    keyParserPath,
    adaptedKeyParser.replace(dispositionMethod, ''),
  );
  await assert.rejects(
    adaptSsh2AuthenticationMaterial({
      projectRoot: partialRoot,
      mode: 'verify',
    }),
    /only partially adapted/u,
  );

  const [rootPackage, dockerfile, ci] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REPO_ROOT, 'Dockerfile'), 'utf8'),
    readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  ]);
  assert.equal(
    rootPackage.scripts?.postinstall,
    'node scripts/ssh2-auth-material-adaptation.mjs --apply',
  );
  assert.equal(
    rootPackage.scripts?.['verify:ssh2-adaptation'],
    'node scripts/ssh2-auth-material-adaptation.mjs --verify',
  );
  const dockerScriptCopy = dockerfile.indexOf(
    'COPY scripts/ssh2-auth-material-adaptation.mjs scripts/ssh2-auth-material-adaptation.mjs',
  );
  const dockerInstall = dockerfile.indexOf('RUN npm ci');
  assert.ok(dockerScriptCopy >= 0 && dockerScriptCopy < dockerInstall);
  assert.match(ci, /run: npm run verify:ssh2-adaptation/u);

  console.log(
    'ssh2-auth-material-adaptation.test.mjs: installed tree verified; version, adapted-source, Protocol-support, partial-patch, and lifecycle drift fail closed',
  );
} finally {
  await rm(TEMP_ROOT, { recursive: true, force: true });
}
