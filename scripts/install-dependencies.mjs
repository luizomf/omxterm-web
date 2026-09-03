#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSsh2AuthenticationMaterial } from './ssh2-auth-material-adaptation.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const LIFECYCLE_FIELDS = ['preinstall', 'install', 'postinstall', 'prepare'];

// `npm ci --ignore-scripts` makes every lockfile lifecycle entry inert first.
// This table is then the complete, exact review boundary for dependency-owned
// install behavior. A lockfile change must update both the integrity and the
// explicit action here before any dependency code can run.
const APPROVED_LIFECYCLE_PACKAGES = [
  {
    lockPath: 'node_modules/cpu-features',
    name: 'cpu-features',
    version: '0.0.10',
    integrity:
      'sha512-9IkYqtX3YHPCzoVg1Py+o9057a3i0fp7S530UWokCSaFVTc7CwXPRiOjRjBQQ18ZCNafx78YfnG+HALxtVmOGA==',
    optional: true,
    lifecycle: {
      install: 'node buildcheck.js > buildcheck.gypi && node-gyp rebuild',
    },
    action: 'rebuild',
  },
  {
    lockPath: 'node_modules/esbuild',
    name: 'esbuild',
    version: '0.28.1',
    integrity:
      'sha512-HrJrvZv5ayxBzPfwphOoNzkzOIIlifzk0KJrGK2c8R4+LKpMtpYLQeUdjnwjWv/LZlkH2laZk+4w78pi99D4Vw==',
    optional: false,
    lifecycle: { postinstall: 'node install.js' },
    action: 'rebuild',
  },
  {
    lockPath: 'node_modules/fsevents',
    name: 'fsevents',
    version: '2.3.3',
    integrity:
      'sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==',
    optional: true,
    lifecycle: {},
    action: 'verify-prebuilt',
  },
  {
    lockPath: 'node_modules/playwright/node_modules/fsevents',
    name: 'fsevents',
    version: '2.3.2',
    integrity:
      'sha512-xiqMQR4xAeHTuB9uWm+fFRcIOgKBMiOBP+eXiyT7jsgVCq1bkVygt00oASowB7EdtpOHaaPgKt812P9ab+DDKA==',
    optional: true,
    lifecycle: {},
    action: 'verify-prebuilt',
  },
  {
    lockPath: 'node_modules/ssh2',
    name: 'ssh2',
    version: '1.17.0',
    integrity:
      'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==',
    optional: false,
    lifecycle: { install: 'node install.js' },
    action: 'rebuild',
  },
];

function parseArguments(argv) {
  let projectRoot = DEFAULT_PROJECT_ROOT;
  let offline = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--offline') {
      offline = true;
      continue;
    }
    if (argument === '--project-root' && argv[index + 1]) {
      projectRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(
      'Usage: install-dependencies.mjs [--offline] [--project-root PATH]',
    );
  }

  return { offline, projectRoot };
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && minor >= 12) || major === 24)) {
    throw new Error(
      `Unsupported Node.js ${process.versions.node}; use ^22.12.0 or ^24.0.0`,
    );
  }
}

function npmInvocation(arguments_) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      arguments: [process.env.npm_execpath, ...arguments_],
    };
  }
  return { command: 'npm', arguments: arguments_ };
}

function run(command, arguments_, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(true);
      } else if (allowFailure) {
        resolve(false);
      } else {
        reject(
          new Error(
            `${path.basename(command)} failed${signal ? ` with signal ${signal}` : ` with status ${code ?? 'unknown'}`}`,
          ),
        );
      }
    });
  });
}

async function runNpm(arguments_, options) {
  const invocation = npmInvocation(arguments_);
  return run(invocation.command, invocation.arguments, options);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assertLockedLifecyclePolicy(lock) {
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== 'object') {
    throw new Error('Lifecycle policy requires an npm lockfileVersion 3 lockfile');
  }

  const approvedByPath = new Map(
    APPROVED_LIFECYCLE_PACKAGES.map((entry) => [entry.lockPath, entry]),
  );
  const lifecyclePaths = Object.entries(lock.packages)
    .filter(([, entry]) => entry?.hasInstallScript === true)
    .map(([lockPath]) => lockPath);
  const problems = [];

  for (const lockPath of lifecyclePaths) {
    const approved = approvedByPath.get(lockPath);
    const locked = lock.packages[lockPath];
    if (!approved) {
      problems.push(`unapproved lifecycle package at ${lockPath || '<root>'}`);
      continue;
    }
    if (
      locked.version !== approved.version ||
      locked.integrity !== approved.integrity ||
      Boolean(locked.optional) !== approved.optional
    ) {
      problems.push(`lifecycle metadata drift at ${lockPath}`);
    }
  }

  for (const approved of APPROVED_LIFECYCLE_PACKAGES) {
    if (!lifecyclePaths.includes(approved.lockPath)) {
      problems.push(`approved lifecycle package missing at ${approved.lockPath}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Lifecycle policy rejected the lockfile:\n- ${problems.join('\n- ')}`);
  }
}

async function assertInstalledManifest(projectRoot, approved) {
  const packageRoot = path.join(projectRoot, approved.lockPath);
  let manifest;
  try {
    manifest = await readJson(path.join(packageRoot, 'package.json'));
  } catch (error) {
    if (approved.optional && error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  if (manifest.name !== approved.name || manifest.version !== approved.version) {
    throw new Error(`Installed package drift at ${approved.lockPath}`);
  }
  for (const field of LIFECYCLE_FIELDS) {
    if (manifest.scripts?.[field] !== approved.lifecycle[field]) {
      throw new Error(
        `Installed lifecycle script drift for ${approved.name}@${approved.version} (${field})`,
      );
    }
  }
  return packageRoot;
}

async function runApprovedLifecycleSteps(projectRoot) {
  for (const approved of APPROVED_LIFECYCLE_PACKAGES) {
    const packageRoot = await assertInstalledManifest(projectRoot, approved);
    if (!packageRoot) {
      console.log(
        `lifecycle policy: ${approved.name}@${approved.version} omitted on this platform`,
      );
      continue;
    }

    if (approved.action === 'verify-prebuilt') {
      await access(path.join(packageRoot, 'fsevents.node'));
      console.log(
        `lifecycle policy: verified prebuilt ${approved.name}@${approved.version}`,
      );
      continue;
    }

    const rebuilt = await runNpm(
      [
        'rebuild',
        `${approved.name}@${approved.version}`,
        '--foreground-scripts',
        '--ignore-scripts=false',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: projectRoot, allowFailure: approved.optional },
    );
    if (!rebuilt) {
      await rm(packageRoot, { recursive: true, force: true });
      console.warn(
        `lifecycle policy: optional ${approved.name}@${approved.version} build failed and was omitted`,
      );
    }
  }
}

async function assertSupportedNpm(projectRoot) {
  const invocation = npmInvocation(['--version']);
  const output = [];
  await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Unable to read npm version')),
    );
  });
  const version = Buffer.concat(output).toString('utf8').trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version) || Number(version.split('.')[0]) < 10) {
    throw new Error(`Unsupported npm ${version || '<unknown>'}; use npm 10 or newer`);
  }
  return version;
}

export async function installDependencies({ projectRoot, offline = false }) {
  assertSupportedNode();
  const npmVersion = await assertSupportedNpm(projectRoot);
  console.log(`lifecycle policy: installing with npm ${npmVersion}, scripts disabled`);

  const ciArguments = [
    'ci',
    '--ignore-scripts',
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--no-audit',
    '--no-fund',
  ];
  if (offline) ciArguments.push('--offline');
  await runNpm(ciArguments, { cwd: projectRoot });

  const lock = await readJson(path.join(projectRoot, 'package-lock.json'));
  assertLockedLifecyclePolicy(lock);
  await runApprovedLifecycleSteps(projectRoot);

  const result = await adaptSsh2AuthenticationMaterial({
    projectRoot,
    mode: 'apply',
  });
  await adaptSsh2AuthenticationMaterial({ projectRoot, mode: 'verify' });
  console.log(
    `lifecycle policy: ${result.state} and verified ssh2 ${result.version} adaptation`,
  );
}

async function main() {
  await installDependencies(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`dependency installation failed: ${message}`);
    process.exitCode = 1;
  });
}
