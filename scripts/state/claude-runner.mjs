#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { run } from './workflow.mjs';

const STATE_HOME = resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'omxterm-agent');
const DEFAULT_CLAUDE = resolve(homedir(), '.local/bin/claude');
const DEFAULT_LOCK = resolve(STATE_HOME, 'claude.lock');

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

function releaseGlobalLock(lockPath, runnerId) {
  if (!existsSync(lockPath)) return;
  if (readFileSync(lockPath, 'utf8').trim() === runnerId) rmSync(lockPath);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const pullRequest = required(options, 'pr');
  const runnerId = required(options, 'runner-id');
  const promptFile = resolve(required(options, 'prompt-file'));
  const workdir = resolve(required(options, 'workdir'));
  const lockPath = resolve(process.env.OMXTERM_CLAUDE_LOCK_PATH || DEFAULT_LOCK);
  const logPath = resolve(options['log-file'] || resolve(STATE_HOME, 'runners', `${runnerId}.log`));
  mkdirSync(dirname(logPath), { recursive: true });

  const claim = run(['runner', '--pr', pullRequest, '--runner-id', runnerId, '--status', 'running']);
  if (claim.command.outcome !== 'runner_updated') {
    // The workflow already moved on (newer SHA ingested, or a takeover) while this
    // unit was still starting. Executing Claude here would run a stale correction
    // prompt against a checkout the workflow no longer owns.
    releaseGlobalLock(lockPath, runnerId);
    throw new Error(`Refusing to run Claude: ${claim.command.reason}`);
  }
  const log = openSync(logPath, 'a', 0o600);
  let result;
  let executionError = null;
  try {
    result = spawnSync(process.env.OMXTERM_CLAUDE_PATH || DEFAULT_CLAUDE, [
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--effort', 'high',
      '--no-session-persistence',
      '-p',
    ], {
      cwd: workdir,
      input: readFileSync(promptFile),
      stdio: ['pipe', log, log],
      env: process.env,
    });
  } catch (error) {
    executionError = error;
  } finally {
    closeSync(log);
  }

  const spawnError = executionError || result?.error;
  const succeeded = !spawnError && result?.status === 0;
  const reason = spawnError?.message || (succeeded ? 'Claude exited successfully.' : `Claude exited with status ${result?.status ?? 'unknown'}.`);
  try {
    run([
      'runner', '--pr', pullRequest, '--runner-id', runnerId,
      '--status', succeeded ? 'succeeded' : 'failed', '--reason', reason,
    ]);
  } finally {
    releaseGlobalLock(lockPath, runnerId);
  }
  if (spawnError) throw spawnError;
  process.exitCode = result?.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(`claude-runner: ${error.message}`);
  process.exitCode = 1;
}
