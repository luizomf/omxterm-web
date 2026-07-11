#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { run } from './workflow.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'omxterm-agent/claude.lock');

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Expected --name value, received "${key ?? ''}".`);
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name]?.trim();
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
}

function acquireGlobalLock(lockPath, runnerId) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, `${runnerId}\n`);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === 'EEXIST') throw new Error(`Another Claude runner owns ${lockPath}; reconcile it before launching another.`);
    throw error;
  }
  closeSync(descriptor);
}

function waitForRunner(pullRequest, runnerId) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const active = spawnSync('systemctl', ['--user', 'is-active', runnerId], { encoding: 'utf8' });
    const state = run(['show', '--pr', pullRequest]);
    if (active.status === 0) return 'running';
    if (state.runner?.status !== 'starting') return state.runner?.status || 'unknown';
    Atomics.wait(sleeper, 0, 0, 200);
  }
  return 'starting';
}

function runnerEnvironment(options) {
  const environment = {
    OMXTERM_AGENT_STATE_PATH: process.env.OMXTERM_AGENT_STATE_PATH,
    OMXTERM_AGENT_STATE_DIR: process.env.OMXTERM_AGENT_STATE_DIR,
    OMXTERM_CLAUDE_LOCK_PATH: process.env.OMXTERM_CLAUDE_LOCK_PATH,
    OMXTERM_CLAUDE_PATH: options['claude-path'] || process.env.OMXTERM_CLAUDE_PATH,
  };
  return Object.entries(environment)
    .filter(([, value]) => value)
    .map(([name, value]) => `--setenv=${name}=${value}`);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const pullRequest = required(options, 'pr');
  const sha = required(options, 'sha');
  const runnerId = required(options, 'runner-id');
  if (!/^[a-zA-Z0-9_.@-]+$/.test(runnerId)) throw new Error(`Invalid systemd runner id "${runnerId}".`);
  const promptFile = resolve(required(options, 'prompt-file'));
  const workdir = resolve(options.workdir || process.cwd());
  const lockPath = resolve(process.env.OMXTERM_CLAUDE_LOCK_PATH || DEFAULT_LOCK);
  acquireGlobalLock(lockPath, runnerId);
  let launched = false;

  try {
    run([
      'dispatch-fix', '--pr', pullRequest, '--sha', sha, '--worker', 'claude',
      '--runner-id', runnerId, '--deadline-at', required(options, 'deadline-at'),
      '--reason', required(options, 'reason'), '--next', 'Claude implements, tests, commits, and pushes. Await synchronize or guardian wakeup.',
    ]);
    const result = spawnSync('systemd-run', [
      '--user', `--unit=${runnerId}`, '--collect', '--quiet',
      `--property=WorkingDirectory=${workdir}`,
      ...runnerEnvironment(options),
      process.execPath, resolve(SCRIPT_DIR, 'claude-runner.mjs'),
      '--pr', pullRequest, '--runner-id', runnerId, '--prompt-file', promptFile,
      '--workdir', workdir,
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      run(['runner', '--pr', pullRequest, '--runner-id', runnerId, '--status', 'failed', '--reason', result.stderr.trim() || 'systemd-run failed.']);
      throw new Error(result.stderr.trim() || `systemd-run exited with status ${result.status}.`);
    }
    launched = true;
    const status = waitForRunner(pullRequest, runnerId);
    if (status === 'starting') {
      throw new Error(`Runner ${runnerId} was accepted by systemd but startup is not confirmed; preserve its lock and reconcile before takeover.`);
    }
    console.log(JSON.stringify({ runnerId, status }, null, 2));
  } catch (error) {
    if (!launched) rmSync(lockPath, { force: true });
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`start-claude: ${error.message}`);
  process.exitCode = 1;
}
