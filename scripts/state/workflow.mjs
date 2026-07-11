#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_DIR = resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'omxterm-agent/pr');
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'blocked', 'stopped']);
const RUNNER_STATUSES = new Set(['starting', 'running', 'succeeded', 'failed', 'abandoned']);

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
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`--${name} must be a positive integer, received "${options[name]}".`);
  }
  return value;
}

function optionalBoolean(options, name, fallback = false) {
  if (options[name] === undefined) return fallback;
  if (options[name] === 'true') return true;
  if (options[name] === 'false') return false;
  fail(`--${name} must be true or false, received "${options[name]}".`);
}

function statePath(options) {
  if (process.env.OMXTERM_AGENT_STATE_PATH) return resolve(process.env.OMXTERM_AGENT_STATE_PATH);
  const pullRequest = optionalNumber(options, 'pr');
  if (!pullRequest) fail('Missing required option --pr.');
  return resolve(process.env.OMXTERM_AGENT_STATE_DIR || DEFAULT_STATE_DIR, `${pullRequest}.json`);
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
  let descriptor = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === 0 && removeDeadLocalLock(lockPath)) continue;
      fail(`Workflow state is locked at ${lockPath}. Another orchestrator may be updating it.`);
    }
  }
  return () => {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  };
}

function removeDeadLocalLock(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid)) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error?.code !== 'ESRCH') return false;
    }
    rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
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

function commandOutcome(state, outcome, reason) {
  return { ...state, command: { outcome, reason } };
}

function queueFrom(options) {
  const nextIssue = optionalNumber(options, 'next-issue');
  const end = optionalBoolean(options, 'queue-end');
  if ((nextIssue === null && !end) || (nextIssue !== null && end)) {
    fail('Provide exactly one of --next-issue <number> or --queue-end true.');
  }
  return {
    nextIssue,
    end,
    continueOnFailure: optionalBoolean(options, 'continue-on-failure'),
  };
}

function start(options, path, now) {
  if (existsSync(path)) {
    const existingState = readState(path);
    if (!TERMINAL_STATUSES.has(existingState.coordination?.status)) {
      fail(`Workflow already active with status "${existingState.coordination?.status ?? 'unknown'}".`);
    }
  }

  const pullRequest = optionalNumber(options, 'pr');
  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  const state = {
    version: 2,
    task: {
      description: requireOption(options, 'task'),
      issue: optionalNumber(options, 'issue'),
      pullRequest,
      repository: options.repository || 'luizomf/omxterm',
    },
    queue: queueFrom(options),
    coordination: {
      status: 'queued',
      codeAttempt: 0,
      maxCodeAttempts: optionalNumber(options, 'max-attempts') ?? 3,
      worker,
      headSha: requireOption(options, 'sha'),
      expectedEvent: 'pull_request',
      next: { owner: worker, action: next },
    },
    lease: null,
    runner: null,
    wakeup: { deadlineAt: options['deadline-at'] || null, lastTriggeredAt: null },
    stop: { requested: false, reason: null },
    createdAt: now,
    updatedAt: now,
    history: [],
  };
  appendHistory(state, { event: 'started', status: 'queued', worker, next }, now);
  writeState(path, state);
  return state;
}

function ingestEvent(options, path, now) {
  const sha = requireOption(options, 'sha');
  const deadlineAt = requireOption(options, 'deadline-at');
  if (!existsSync(path)) {
    const state = start({
      ...options,
      task: options.task || `Review PR #${requireOption(options, 'pr')}`,
      worker: 'webhook',
      next: 'Brien must claim and review this PR event.',
      'queue-end': options['queue-end'] || 'true',
    }, path, now);
    return commandOutcome(state, 'event_queued', `Queued ${options.action || 'pull_request'} for ${sha}.`);
  }

  const state = readState(path);
  const currentStatus = state.coordination.status;
  if (state.coordination.headSha === sha) {
    return commandOutcome(state, 'ignored_duplicate', `SHA ${sha} is already known in status ${currentStatus}.`);
  }

  if (state.runner && ['starting', 'running'].includes(state.runner.status)) {
    state.runner = { ...state.runner, status: 'abandoned', updatedAt: now, reason: 'Superseded by a newer GitHub SHA.' };
  }
  state.coordination = {
    ...state.coordination,
    status: 'queued',
    codeAttempt: TERMINAL_STATUSES.has(currentStatus) ? 0 : state.coordination.codeAttempt,
    worker: 'webhook',
    headSha: sha,
    expectedEvent: 'pull_request',
    next: { owner: 'brien', action: `Claim and review SHA ${sha}.` },
  };
  state.lease = null;
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  state.stop = { requested: false, reason: null };
  appendHistory(state, { event: 'github_event_ingested', from: currentStatus, status: 'queued', sha, action: options.action || null }, now);
  writeState(path, state);
  return commandOutcome(state, 'event_queued', `Queued new SHA ${sha}.`);
}

function claimReview(options, path, now) {
  const state = readState(path);
  const status = state.coordination.status;
  const sha = requireOption(options, 'sha');
  if (TERMINAL_STATUSES.has(status)) {
    return commandOutcome(state, 'ignored_terminal', `Workflow is ${status}.`);
  }
  if (status === 'reviewing' && state.coordination.headSha === sha) {
    return commandOutcome(state, 'ignored_duplicate', `SHA ${sha} is already being reviewed.`);
  }
  if (status === 'fixing' && state.coordination.headSha === sha) {
    return commandOutcome(state, 'ignored_worker_active', `Waiting for a new SHA after ${sha}.`);
  }
  if (!['queued', 'reviewing', 'fixing'].includes(status)) {
    fail(`Cannot claim a review from status "${status}".`);
  }

  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  const event = status === 'reviewing' ? 'review_superseded' : 'review_claimed';
  state.coordination = {
    ...state.coordination,
    status: 'reviewing',
    worker,
    headSha: sha,
    expectedEvent: null,
    next: { owner: worker, action: next },
  };
  state.lease = { owner: worker, expiresAt: options['deadline-at'] || null };
  state.wakeup.deadlineAt = options['deadline-at'] || null;
  appendHistory(state, { event, from: status, status: 'reviewing', worker, sha, next }, now);
  writeState(path, state);
  return commandOutcome(state, 'claimed', `Review claimed for ${sha}.`);
}

function dispatchFix(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'reviewing') {
    fail(`Correction dispatch requires status "reviewing", found "${state.coordination.status}".`);
  }
  const sha = requireOption(options, 'sha');
  if (sha !== state.coordination.headSha) {
    fail(`Cannot dispatch correction for stale SHA "${sha}"; current SHA is "${state.coordination.headSha}".`);
  }

  const codeAttempt = state.coordination.codeAttempt + 1;
  const reason = requireOption(options, 'reason');
  if (codeAttempt > state.coordination.maxCodeAttempts) {
    state.coordination = {
      ...state.coordination,
      status: 'failed',
      worker: 'none',
      expectedEvent: null,
      next: failureNext(state),
    };
    state.stop = { requested: true, reason: 'Maximum code correction attempts exhausted.' };
    appendHistory(state, { event: 'attempts_exhausted', status: 'failed', reason }, now);
    writeState(path, state);
    return commandOutcome(state, 'attempts_exhausted', state.stop.reason);
  }

  const worker = requireOption(options, 'worker');
  const runnerId = requireOption(options, 'runner-id');
  const deadlineAt = requireOption(options, 'deadline-at');
  const next = requireOption(options, 'next');
  state.coordination = {
    ...state.coordination,
    status: 'fixing',
    codeAttempt,
    worker,
    expectedEvent: 'pull_request.synchronize',
    next: { owner: worker, action: next },
  };
  state.runner = { id: runnerId, type: worker, status: 'starting', baseSha: sha, startedAt: now, updatedAt: now };
  state.lease = { owner: runnerId, expiresAt: deadlineAt };
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  appendHistory(state, { event: 'correction_dispatched', status: 'fixing', codeAttempt, worker, runnerId, reason, next }, now);
  writeState(path, state);
  return commandOutcome(state, 'dispatched', `Correction attempt ${codeAttempt} assigned to ${runnerId}.`);
}

function failureNext(state) {
  if (state.queue.continueOnFailure && state.queue.nextIssue) {
    return { owner: 'brien', action: `Record failure and start issue #${state.queue.nextIssue}.` };
  }
  return { owner: 'none', action: state.queue.end ? 'Queue finished with a failed task.' : 'Stop the queue after failure.' };
}

function updateRunner(options, path, now) {
  const state = readState(path);
  const runnerId = requireOption(options, 'runner-id');
  if (!state.runner || state.runner.id !== runnerId) {
    return commandOutcome(state, 'ignored_stale_runner', `Runner ${runnerId} no longer owns this workflow.`);
  }
  const status = requireOption(options, 'status');
  if (!RUNNER_STATUSES.has(status)) fail(`Unknown runner status "${status}".`);
  state.runner = { ...state.runner, status, updatedAt: now, reason: options.reason || null };
  if (status === 'failed') {
    state.coordination.expectedEvent = 'workflow_wakeup';
    state.wakeup.deadlineAt = now;
  }
  appendHistory(state, { event: 'runner_updated', runnerId, status, reason: options.reason || null }, now);
  writeState(path, state);
  return commandOutcome(state, 'runner_updated', `${runnerId} is ${status}.`);
}

function takeover(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'fixing') {
    fail(`Takeover requires status "fixing", found "${state.coordination.status}".`);
  }
  if (state.runner?.status === 'running' || state.runner?.status === 'starting') {
    fail(`Runner "${state.runner.id}" is still ${state.runner.status}; prove it stopped before takeover.`);
  }
  const worker = requireOption(options, 'worker');
  const next = requireOption(options, 'next');
  const deadlineAt = requireOption(options, 'deadline-at');
  if (state.runner) state.runner = { ...state.runner, status: 'abandoned', updatedAt: now };
  state.coordination = {
    ...state.coordination,
    worker,
    expectedEvent: 'pull_request.synchronize',
    next: { owner: worker, action: next },
  };
  state.lease = { owner: worker, expiresAt: deadlineAt };
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  appendHistory(state, { event: 'implementation_taken_over', worker, reason: requireOption(options, 'reason'), next }, now);
  writeState(path, state);
  return commandOutcome(state, 'taken_over', `${worker} owns the correction.`);
}

function passReview(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'reviewing') {
    fail(`Passing requires status "reviewing", found "${state.coordination.status}".`);
  }
  const sha = requireOption(options, 'sha');
  if (sha !== state.coordination.headSha) {
    fail(`Cannot pass stale SHA "${sha}"; current SHA is "${state.coordination.headSha}".`);
  }
  const reason = requireOption(options, 'reason');
  const action = state.queue.nextIssue ? `Merge this PR, then start issue #${state.queue.nextIssue}.` : 'Merge this PR; queue is complete.';
  state.coordination = {
    ...state.coordination,
    status: 'passed',
    worker: 'none',
    expectedEvent: null,
    next: { owner: 'brien', action },
  };
  state.lease = null;
  state.wakeup.deadlineAt = null;
  state.stop = { requested: true, reason };
  appendHistory(state, { event: 'review_passed', status: 'passed', sha, reason, next: action }, now);
  writeState(path, state);
  return commandOutcome(state, 'passed', reason);
}

function stop(options, path, now) {
  const state = readState(path);
  const previousStatus = state.coordination.status;
  if (TERMINAL_STATUSES.has(previousStatus)) {
    return commandOutcome(state, 'ignored_terminal', `Workflow is already ${previousStatus}.`);
  }
  const status = options.status || 'stopped';
  if (!TERMINAL_STATUSES.has(status)) fail(`Unknown terminal status "${status}".`);
  const reason = requireOption(options, 'reason');
  state.coordination = {
    ...state.coordination,
    status,
    worker: 'none',
    expectedEvent: null,
    next: failureNext(state),
  };
  state.lease = null;
  state.wakeup.deadlineAt = null;
  state.stop = { requested: true, reason };
  appendHistory(state, { event: 'stopped', from: previousStatus, status, reason }, now);
  writeState(path, state);
  return commandOutcome(state, status, reason);
}

function recordWakeup(options, path, now) {
  const state = readState(path);
  if (TERMINAL_STATUSES.has(state.coordination.status)) {
    return commandOutcome(state, 'ignored_terminal', `Workflow is ${state.coordination.status}.`);
  }
  state.wakeup.lastTriggeredAt = now;
  appendHistory(state, { event: 'wakeup_triggered', reason: options.reason || 'deadline reached' }, now);
  writeState(path, state);
  return commandOutcome(state, 'wakeup_recorded', options.reason || 'deadline reached');
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
  const path = statePath(options);
  const operations = {
    start,
    ingest: ingestEvent,
    'claim-review': claimReview,
    'dispatch-fix': dispatchFix,
    runner: updateRunner,
    takeover,
    pass: passReview,
    stop,
    wake: recordWakeup,
  };
  if (command === 'show') return readState(path);
  if (!operations[command]) {
    fail('Usage: workflow.mjs show|start|ingest|claim-review|dispatch-fix|runner|takeover|pass|stop|wake [--name value ...]');
  }
  return mutate(path, () => operations[command](options, path, now));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`agent-state: ${error.message}`);
    process.exitCode = 1;
  }
}