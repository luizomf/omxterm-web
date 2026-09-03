#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(REPO_ROOT, 'scripts', 'install-dependencies.mjs');
const TEMP_ROOT = await mkdtemp(
  path.join(os.tmpdir(), 'omxterm-lifecycle-policy-'),
);

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    encoding: 'utf8',
    ...options,
  });
}

try {
  const fixture = path.join(TEMP_ROOT, 'fixture');
  const packageSource = path.join(TEMP_ROOT, 'unapproved-source');
  const sentinel = path.join(TEMP_ROOT, 'unapproved-install-ran');
  await mkdir(fixture);
  await mkdir(packageSource);
  await writeFile(
    path.join(packageSource, 'package.json'),
    `${JSON.stringify(
      {
        name: 'unapproved-lifecycle-fixture',
        version: '1.0.0',
        scripts: { install: 'node install.mjs' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(packageSource, 'install.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.OMXTERM_LIFECYCLE_SENTINEL, 'executed');\n`,
  );

  const packed = run(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      fixture,
    ],
    { cwd: packageSource },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const tarballName = JSON.parse(packed.stdout)[0].filename;
  await writeFile(
    path.join(fixture, 'package.json'),
    `${JSON.stringify(
      {
        name: 'lifecycle-policy-fixture',
        version: '1.0.0',
        private: true,
        dependencies: {
          'unapproved-lifecycle-fixture': `file:./${tarballName}`,
        },
      },
      null,
      2,
    )}\n`,
  );

  const lock = run(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: fixture },
  );
  assert.equal(lock.status, 0, lock.stderr);

  const installed = run(
    process.execPath,
    [INSTALLER, '--project-root', fixture, '--offline'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OMXTERM_LIFECYCLE_SENTINEL: sentinel,
      },
    },
  );
  assert.notEqual(installed.status, 0);
  assert.match(
    `${installed.stdout}\n${installed.stderr}`,
    /unapproved lifecycle package at node_modules\/unapproved-lifecycle-fixture/u,
  );
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
  await access(
    path.join(
      fixture,
      'node_modules',
      'unapproved-lifecycle-fixture',
      'package.json',
    ),
  );

  const [rootPackage, dockerfile, ci, readme, agents] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(REPO_ROOT, 'Dockerfile'), 'utf8'),
    readFile(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'README.md'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8'),
  ]);
  assert.equal(rootPackage.scripts?.bootstrap, 'node scripts/install-dependencies.mjs');
  assert.equal(rootPackage.scripts?.postinstall, undefined);
  assert.equal(rootPackage.allowScripts, undefined);
  assert.match(ci, /run: npm run bootstrap/u);
  assert.doesNotMatch(ci, /run: npm ci(?:\s|$)/u);
  const dockerPolicyCopy = dockerfile.indexOf(
    'COPY scripts/install-dependencies.mjs scripts/install-dependencies.mjs',
  );
  const dockerBootstrap = dockerfile.indexOf('RUN npm run bootstrap');
  assert.ok(dockerPolicyCopy >= 0 && dockerPolicyCopy < dockerBootstrap);
  assert.doesNotMatch(dockerfile, /RUN npm ci(?:\s|$)/u);
  assert.match(readme, /^npm run bootstrap$/mu);
  assert.match(agents, /^Bootstrap:\s+npm run bootstrap$/mu);

  console.log(
    'install-dependencies.test.mjs: local, CI, and Docker share the fail-closed bootstrap; a hermetic unapproved lifecycle script stayed inert',
  );
} finally {
  await rm(TEMP_ROOT, { recursive: true, force: true });
}
