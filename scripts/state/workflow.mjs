#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_PATH = resolve(SCRIPT_DIR, 'workflow.json');
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'blocked', 'stopped']);
const TRANSITIONS = {
  implementing: new Set(['awaiting_review']),
  awaiting_review: new Set(['reviewing']),
  reviewing: new Set(['passed', 'failed', 'blocked']),
  fixing: new Set(['awaiting_review']),
};

function fail(message) {
  throw new Error(message);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      fail(`Expected --name value options, received "${key ?? ''}".`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name]?.trim();
  if (!value) fail(`Missing required option --${name}.`);
  return value;
}

function optionalNumber(options, name) {
  if (options[name] === undefined) return null;
  const raw = String(options[name]).trim();
  // Number.parseInt would silently accept "1.5" (→1) or "3abc" (→3); require the
  // whole string to be digits so malformed CLI input is rejected, not truncated.
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`--${name} must be a positive integer, received "${options[name]}".`);
  }
  return value;
}

function statePath() {
  return resolve(process.env.OMXTERM_AGENT_STATE_PATH || DEFAULT_STATE_PATH);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Workflow state not found at ${path}. Run "start" first.`);
    throw error;
  }
}

function acquireLock(path) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(`Workflow state is locked at ${lockPath}. Another agent may be updating it.`);
    }
    throw error;
  }
  return () => {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  };
}

function writeState(path, state) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function appendHistory(state, event, now) {
  state.history.push({ at: now, ...event });
  state.updatedAt = now;
}

function start(options, path, now) {
  if (existsSync(path)) {
    const existingState = readState(path);
    if (!TERMINAL_STATUSES.has(existingState.coordination?.status)) {
      fail(
        `Workflow already active with status "${existingState.coordination?.status ?? 'unknown'}". ` +
          'Stop it before starting another task.',
      );
    }
  }

  const maxAttempts = optionalNumber(options, 'max-attempts') ?? 3;
  const task = requireOption(options, 'task');
  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  const state = {
    version: 1,
    task: {
      description: task,
      issue: optionalNumber(options, 'issue'),
      pullRequest: optionalNumber(options, 'pr'),
      repository: options.repository || 'luizomf/omxterm',
    },
    coordination: {
      status: 'implementing',
      attempt: 1,
      maxAttempts,
      worker,
      headSha: options.sha || null,
      next: { owner: worker, action: next },
    },
    stop: {
      requested: false,
      reason: null,
      conditions: ['review passed', `${maxAttempts} attempts exhausted`, 'blocked', 'explicit stop'],
    },
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  appendHistory(state, { event: 'started', status: 'implementing', worker, next }, now);
  writeState(path, state);
  return state;
}

function transition(options, path, now) {
  const state = readState(path);
  const currentStatus = state.coordination.status;
  if (TERMINAL_STATUSES.has(currentStatus)) {
    fail(`Workflow already stopped with status "${currentStatus}".`);
  }

  const status = requireOption(options, 'status');
  const allowed = TRANSITIONS[currentStatus];
  if (!allowed?.has(status)) {
    fail(`Invalid transition from "${currentStatus}" to "${status}".`);
  }

  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  state.coordination = {
    ...state.coordination,
    status,
    worker,
    headSha: options.sha || state.coordination.headSha,
    next: { owner: options['next-owner'] || worker, action: next },
  };
  if (options.pr) state.task.pullRequest = optionalNumber(options, 'pr');
  if (TERMINAL_STATUSES.has(status)) {
    state.stop = { ...state.stop, requested: true, reason: options.reason || status };
  }
  appendHistory(state, { event: 'transitioned', from: currentStatus, status, worker, next }, now);
  writeState(path, state);
  return state;
}

function retry(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'reviewing') {
    fail(`Retry requires status "reviewing", found "${state.coordination.status}".`);
  }

  const reason = requireOption(options, 'reason');
  const nextAttempt = state.coordination.attempt + 1;
  if (nextAttempt > state.coordination.maxAttempts) {
    state.coordination.status = 'failed';
    state.coordination.worker = 'none';
    state.coordination.next = { owner: 'human', action: 'Inspect remaining review blockers.' };
    state.stop = { ...state.stop, requested: true, reason: 'Maximum attempts exhausted.' };
    appendHistory(state, { event: 'attempts_exhausted', status: 'failed', reason }, now);
    writeState(path, state);
    return state;
  }

  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  state.coordination = {
    ...state.coordination,
    status: 'fixing',
    attempt: nextAttempt,
    worker,
    next: { owner: worker, action: next },
  };
  appendHistory(state, { event: 'retry_started', status: 'fixing', attempt: nextAttempt, worker, reason, next }, now);
  writeState(path, state);
  return state;
}

function stop(options, path, now) {
  const state = readState(path);
  const previousStatus = state.coordination.status;
  if (TERMINAL_STATUSES.has(previousStatus)) {
    fail(`Workflow already terminal with status "${previousStatus}"; cannot overwrite the outcome.`);
  }
  const status = options.status || 'stopped';
  if (!TERMINAL_STATUSES.has(status)) {
    fail(`Stop status must be one of: ${[...TERMINAL_STATUSES].join(', ')}.`);
  }
  const reason = requireOption(options, 'reason');
  state.coordination.status = status;
  state.coordination.worker = 'none';
  state.coordination.next = { owner: 'human', action: options.next || 'Inspect workflow state.' };
  state.stop = { ...state.stop, requested: true, reason };
  appendHistory(state, { event: 'stopped', from: previousStatus, status, reason }, now);
  writeState(path, state);
  return state;
}

function mutate(path, operation) {
  const release = acquireLock(path);
  try {
    return operation();
  } finally {
    release();
  }
}

export function run(argv, now = new Date().toISOString()) {
  const [command, ...optionArgs] = argv;
  const options = parseOptions(optionArgs);
  const path = statePath();

  switch (command) {
    case 'show':
      return readState(path);
    case 'start':
      return mutate(path, () => start(options, path, now));
    case 'transition':
      return mutate(path, () => transition(options, path, now));
    case 'retry':
      return mutate(path, () => retry(options, path, now));
    case 'stop':
      return mutate(path, () => stop(options, path, now));
    default:
      fail('Usage: workflow.mjs show|start|transition|retry|stop [--name value ...]');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`agent-state: ${error.message}`);
    process.exitCode = 1;
  }
}
