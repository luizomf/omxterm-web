#!/usr/bin/env node

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_DIR = resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'omxterm-agent/pr');
const TERMINAL_STATUSES = new Set(['passed', 'completed', 'failed', 'blocked', 'stopped']);
const RUNNER_STATUSES = new Set(['starting', 'running', 'succeeded', 'failed', 'abandoned']);
const TERMINAL_RUNNER_STATUSES = new Set(['succeeded', 'failed', 'abandoned']);
const ACTIVE_RUNNER_STATUSES = new Set(['starting', 'running']);
// systemd never reports "active" or "activating" for a unit that has actually stopped, so
// restricting this set is what keeps confirm-runner-stop from being satisfied by a lie.
const CONFIRMED_INACTIVE_UNIT_STATUSES = new Set(['inactive', 'failed', 'not-found']);
// A workflow in one of these states never produced usable durable work, so it cannot serve
// as completion evidence; "passed"/"completed" remain valid (stronger, even) evidence.
const UNRECOVERABLE_EVIDENCE_STATUSES = new Set(['failed', 'blocked', 'stopped']);

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

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function requireGitSha(options, name) {
  const value = requireOption(options, name);
  if (!GIT_SHA_PATTERN.test(value)) {
    fail(`--${name} must be a full 40-character lowercase hexadecimal Git SHA, received "${value}".`);
  }
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

// Marking a runner "abandoned" here only updates JSON; the systemd unit it names may
// still be alive (mid `systemd-run`, or Claude actively executing inside claude-runner.mjs).
// stopConfirmed stays false until confirm-runner-stop proves the unit is inactive, and
// claim-review refuses to hand the workflow to a new reviewer/implementer until then.
function supersedeActiveRunner(state, now, reason) {
  if (!state.runner || !ACTIVE_RUNNER_STATUSES.has(state.runner.status)) return false;
  state.runner = { ...state.runner, status: 'abandoned', stopConfirmed: false, updatedAt: now, reason };
  return true;
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
    queue: { ...queueFrom(options), continuation: null },
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
    reviewBatch: null,
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
  if (currentStatus === 'completed') {
    return commandOutcome(state, 'ignored_terminal', 'Workflow is completed; later PR events cannot reopen it.');
  }
  if (state.coordination.headSha === sha) {
    return commandOutcome(state, 'ignored_duplicate', `SHA ${sha} is already known in status ${currentStatus}.`);
  }

  const supersededRunner = supersedeActiveRunner(state, now, 'Superseded by a newer GitHub SHA.');
  state.coordination = {
    ...state.coordination,
    status: 'queued',
    codeAttempt: state.coordination.codeAttempt,
    worker: 'webhook',
    headSha: sha,
    expectedEvent: 'pull_request',
    next: supersededRunner
      ? { owner: 'brien', action: `Stop and confirm runner ${state.runner.id} inactive, then claim SHA ${sha}.` }
      : { owner: 'brien', action: `Claim and review SHA ${sha}.` },
  };
  state.lease = null;
  state.reviewBatch = null;
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  state.stop = { requested: false, reason: null };
  appendHistory(state, { event: 'github_event_ingested', from: currentStatus, status: 'queued', sha, action: options.action || null, runnerSuperseded: supersededRunner }, now);
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
  if (state.runner?.stopConfirmed === false) {
    return commandOutcome(state, 'ignored_runner_stop_pending', `Runner ${state.runner.id} stop is not yet confirmed inactive; run confirm-runner-stop before claiming SHA ${sha}.`);
  }
  // Brien can discover a newer SHA directly (recovery step: "treat the webhook as missed")
  // without an `ingest` call ever running. Mirror ingestEvent's supersede-and-requeue
  // transition here, including moving status out of "fixing" so takeover's own guard
  // (which only inspects runner.status, already flipped to "abandoned" below) cannot be
  // used to bypass this block while the runner's systemd unit is still unconfirmed.
  if (state.coordination.headSha !== sha && supersedeActiveRunner(state, now, 'Superseded by a newer GitHub SHA observed during claim-review.')) {
    state.coordination = {
      ...state.coordination,
      status: 'queued',
      worker: 'webhook',
      headSha: sha,
      expectedEvent: 'pull_request',
      next: { owner: 'brien', action: `Stop and confirm runner ${state.runner.id} inactive, then claim SHA ${sha}.` },
    };
    state.lease = null;
    appendHistory(state, { event: 'runner_superseded_pending_stop', runnerId: state.runner.id, sha }, now);
    writeState(path, state);
    return commandOutcome(state, 'ignored_runner_stop_pending', `Runner ${state.runner.id} may still be running SHA ${state.runner.baseSha}; stop and confirm it inactive before claiming SHA ${sha}.`);
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
  state.reviewBatch = null;
  state.wakeup.deadlineAt = options['deadline-at'] || null;
  appendHistory(state, { event, from: status, status: 'reviewing', worker, sha, next }, now);
  writeState(path, state);
  return commandOutcome(state, 'claimed', `Review claimed for ${sha}.`);
}

function dispatchReviewBatch(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'reviewing') {
    fail(`Review batch dispatch requires status "reviewing", found "${state.coordination.status}".`);
  }
  const sha = requireOption(options, 'sha');
  if (sha !== state.coordination.headSha) {
    fail(`Cannot dispatch review batch for stale SHA "${sha}"; current SHA is "${state.coordination.headSha}".`);
  }
  const delegationId = requireOption(options, 'delegation-id');
  const deadlineAt = requireOption(options, 'deadline-at');
  if (state.reviewBatch) {
    if (state.reviewBatch.status === 'completed') {
      const outcome = state.reviewBatch.delegationId === delegationId ? 'ignored_terminal' : 'ignored_stale_batch';
      return commandOutcome(state, outcome, `Review batch ${state.reviewBatch.delegationId} already completed for this claim.`);
    }
    const outcome = state.reviewBatch.delegationId === delegationId ? 'ignored_duplicate' : 'ignored_worker_active';
    return commandOutcome(state, outcome, `Review batch ${state.reviewBatch.delegationId} is still pending.`);
  }
  state.reviewBatch = { delegationId, status: 'pending', sha, dispatchedAt: now, completedAt: null };
  state.coordination.next = { owner: 'brien', action: `Await consolidated review batch ${delegationId}.` };
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  appendHistory(state, { event: 'review_batch_dispatched', delegationId, sha }, now);
  writeState(path, state);
  return commandOutcome(state, 'review_batch_dispatched', `Review batch ${delegationId} is pending.`);
}

function completeReviewBatch(options, path, now) {
  const state = readState(path);
  const delegationId = requireOption(options, 'delegation-id');
  if (state.coordination.status !== 'reviewing') {
    const duplicate = state.reviewBatch?.status === 'completed' && state.reviewBatch.delegationId === delegationId;
    const outcome = duplicate ? 'ignored_duplicate' : 'ignored_stale_batch';
    return commandOutcome(state, outcome, `Review batch ${delegationId} cannot change workflow status ${state.coordination.status}.`);
  }
  if (!state.reviewBatch) {
    return commandOutcome(state, 'ignored_stale_batch', `Review batch ${delegationId} no longer belongs to this claim.`);
  }
  if (state.reviewBatch.status === 'completed') {
    const outcome = state.reviewBatch.delegationId === delegationId ? 'ignored_duplicate' : 'ignored_stale_batch';
    return commandOutcome(state, outcome, `Review batch ${state.reviewBatch.delegationId} already completed.`);
  }
  if (state.reviewBatch.delegationId !== delegationId) {
    return commandOutcome(state, 'ignored_stale_batch', `Review batch ${delegationId} does not own pending batch ${state.reviewBatch.delegationId}.`);
  }
  const sha = requireOption(options, 'sha');
  if (sha !== state.reviewBatch.sha || sha !== state.coordination.headSha) {
    return commandOutcome(state, 'ignored_stale_sha', `Review batch ${delegationId} does not match current SHA ${state.coordination.headSha}.`);
  }
  const worker = requireOption(options, 'worker');
  if (worker !== state.coordination.worker || worker !== state.lease?.owner) {
    return commandOutcome(state, 'ignored_worker_active', `${worker} does not own review batch ${delegationId}.`);
  }
  state.reviewBatch = { ...state.reviewBatch, status: 'completed', completedAt: now };
  state.coordination.next = { owner: 'brien', action: `Synthesize review batch ${delegationId}, revalidate remote SHA, then pass or dispatch correction.` };
  appendHistory(state, { event: 'review_batch_completed', delegationId, sha: state.reviewBatch.sha }, now);
  writeState(path, state);
  return commandOutcome(state, 'review_batch_completed', `Review batch ${delegationId} completed.`);
}

function requireReviewBatchComplete(state, action) {
  if (state.reviewBatch?.status === 'pending') {
    fail(`Cannot ${action} while review batch "${state.reviewBatch.delegationId}" is pending.`);
  }
}

function dispatchFix(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'reviewing') {
    fail(`Correction dispatch requires status "reviewing", found "${state.coordination.status}".`);
  }
  requireReviewBatchComplete(state, 'dispatch correction');
  const sha = requireOption(options, 'sha');
  if (sha !== state.coordination.headSha) {
    fail(`Cannot dispatch correction for stale SHA "${sha}"; current SHA is "${state.coordination.headSha}".`);
  }

  const codeAttempt = state.coordination.codeAttempt + 1;
  const reason = requireOption(options, 'reason');
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

function resumeWorkflow(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'failed') {
    return commandOutcome(state, 'ignored_not_failed', `Workflow is ${state.coordination.status}, not failed.`);
  }
  if (state.runner && ACTIVE_RUNNER_STATUSES.has(state.runner.status)) {
    return commandOutcome(state, 'ignored_worker_active', `Runner ${state.runner.id} is still ${state.runner.status}; prove it stopped before resuming.`);
  }
  if (state.runner?.stopConfirmed === false) {
    return commandOutcome(state, 'ignored_runner_stop_pending', `Runner ${state.runner.id} stop is not yet confirmed inactive; run confirm-runner-stop before resuming.`);
  }
  const reason = requireOption(options, 'reason');
  state.coordination = {
    ...state.coordination,
    status: 'queued',
    worker: 'webhook',
    expectedEvent: 'pull_request',
    next: { owner: 'brien', action: `Claim and review SHA ${state.coordination.headSha}.` },
  };
  state.lease = null;
  state.wakeup = { deadlineAt: options['deadline-at'] || null, lastTriggeredAt: null };
  state.stop = { requested: false, reason: null };
  appendHistory(state, { event: 'workflow_resumed', from: 'failed', status: 'queued', reason }, now);
  writeState(path, state);
  return commandOutcome(state, 'resumed', reason);
}

function updateRunner(options, path, now) {
  const state = readState(path);
  const runnerId = requireOption(options, 'runner-id');
  if (!state.runner || state.runner.id !== runnerId) {
    return commandOutcome(state, 'ignored_stale_runner', `Runner ${runnerId} no longer owns this workflow.`);
  }
  // A newer SHA (ingest) or a takeover already retired this runner id; a late status
  // report from that same id must not revive it, or a stale unit could execute Claude
  // against work that no longer matches the current head SHA.
  if (TERMINAL_RUNNER_STATUSES.has(state.runner.status)) {
    return commandOutcome(state, 'ignored_superseded_runner', `Runner ${runnerId} is already ${state.runner.status} and cannot transition further.`);
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

// The caller must have already inspected the named systemd unit (never a raw PID) and
// pass what it observed. This is the only way stopConfirmed can flip back to true, which
// is what unblocks claim-review for the SHA that superseded this runner.
function confirmRunnerStop(options, path, now) {
  const state = readState(path);
  const runnerId = requireOption(options, 'runner-id');
  if (!state.runner || state.runner.id !== runnerId) {
    return commandOutcome(state, 'ignored_stale_runner', `Runner ${runnerId} no longer owns this workflow.`);
  }
  if (state.runner.stopConfirmed !== false) {
    return commandOutcome(state, 'ignored_already_confirmed', `Runner ${runnerId} stop is already confirmed.`);
  }
  const unitStatus = requireOption(options, 'unit-status');
  if (!CONFIRMED_INACTIVE_UNIT_STATUSES.has(unitStatus)) {
    fail(`--unit-status must confirm the systemd unit is inactive (one of ${[...CONFIRMED_INACTIVE_UNIT_STATUSES].join(', ')}), received "${unitStatus}".`);
  }
  const reason = requireOption(options, 'reason');
  state.runner = { ...state.runner, stopConfirmed: true, stopConfirmedAt: now, stopUnitStatus: unitStatus };
  appendHistory(state, { event: 'runner_stop_confirmed', runnerId, unitStatus, reason }, now);
  writeState(path, state);
  return commandOutcome(state, 'runner_stop_confirmed', `Runner ${runnerId} confirmed inactive (${unitStatus}).`);
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
  requireReviewBatchComplete(state, 'pass review');
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

function completeWorkflow(options, path, now) {
  const state = readState(path);
  if (state.coordination.status === 'completed') {
    return commandOutcome(state, 'ignored_terminal', 'Workflow is already completed.');
  }
  if (state.coordination.status !== 'passed') {
    fail(`Completing requires status "passed", found "${state.coordination.status}".`);
  }
  const mergeSha = requireGitSha(options, 'merge-sha');
  const nextIssue = state.queue.nextIssue;
  const action = nextIssue
    ? `Claim and dispatch the durable continuation for issue #${nextIssue} with claim-continuation.`
    : 'Queue is complete.';
  state.coordination = {
    ...state.coordination,
    status: 'completed',
    worker: 'none',
    expectedEvent: null,
    next: { owner: nextIssue ? 'brien' : 'none', action },
  };
  // A completed PR is terminal for review, but a declared nextIssue still owes the queue a
  // durable handoff. `continuation` survives independently of coordination.status so a crashed
  // or missed session leaves a claimable/recoverable record instead of only human-readable prose (#110).
  state.queue = {
    ...state.queue,
    continuation: nextIssue
      ? { status: 'pending', issue: nextIssue, claimedBy: null, claimedAt: null, completedAt: null, evidence: null }
      : null,
  };
  state.merge = { sha: mergeSha, completedAt: now };
  state.lease = null;
  state.wakeup = nextIssue ? { deadlineAt: now, lastTriggeredAt: null } : { deadlineAt: null, lastTriggeredAt: null };
  state.stop = { requested: true, reason: `Merged as ${mergeSha}.` };
  appendHistory(state, { event: 'workflow_completed', status: 'completed', mergeSha, next: action, continuationPending: Boolean(nextIssue) }, now);
  writeState(path, state);
  return commandOutcome(state, 'completed', `Workflow completed at merge ${mergeSha}.`);
}

// A continuation owner is an orchestrator role (e.g. "brien"), not a systemd-tracked
// process, so there is no unit to inspect the way confirm-runner-stop inspects a runner.
// The recorded claim deadline (mirrored onto wakeup.deadlineAt while the continuation is
// pending/claimed) is the only durable proof of inactivity available, matching how the
// guardian already treats wakeup.deadlineAt as the recovery signal (#113).
function continuationLeaseExpired(state, now) {
  const deadline = Date.parse(state.wakeup?.deadlineAt || '');
  const currentTime = Date.parse(now);
  return Number.isFinite(deadline) && Number.isFinite(currentTime) && deadline <= currentTime;
}

function claimContinuation(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'completed') {
    fail(`Continuation claim requires status "completed", found "${state.coordination.status}".`);
  }
  if (!state.queue.continuation) {
    fail('Workflow has no pending queue continuation to claim.');
  }
  if (state.queue.continuation.status === 'done') {
    return commandOutcome(state, 'ignored_terminal', `Issue #${state.queue.continuation.issue} continuation is already done.`);
  }
  const worker = requireOption(options, 'worker');
  if (state.queue.continuation.status === 'claimed') {
    if (!continuationLeaseExpired(state, now)) {
      const outcome = state.queue.continuation.claimedBy === worker ? 'ignored_duplicate' : 'ignored_worker_active';
      return commandOutcome(state, outcome, `${state.queue.continuation.claimedBy} already claimed issue #${state.queue.continuation.issue} continuation.`);
    }
    const next = requireOption(options, 'next');
    const deadlineAt = requireOption(options, 'deadline-at');
    const previousWorker = state.queue.continuation.claimedBy;
    state.queue.continuation = { ...state.queue.continuation, claimedBy: worker, claimedAt: now };
    state.coordination = { ...state.coordination, next: { owner: worker, action: next } };
    state.wakeup = { deadlineAt, lastTriggeredAt: null };
    appendHistory(state, {
      event: 'continuation_reclaimed', issue: state.queue.continuation.issue, from: previousWorker, worker, next,
    }, now);
    writeState(path, state);
    return commandOutcome(state, 'continuation_reclaimed', `${worker} reclaimed expired issue #${state.queue.continuation.issue} continuation from ${previousWorker}.`);
  }
  const next = requireOption(options, 'next');
  const deadlineAt = requireOption(options, 'deadline-at');
  state.queue.continuation = { ...state.queue.continuation, status: 'claimed', claimedBy: worker, claimedAt: now };
  state.coordination = { ...state.coordination, next: { owner: worker, action: next } };
  state.wakeup = { deadlineAt, lastTriggeredAt: null };
  appendHistory(state, { event: 'continuation_claimed', issue: state.queue.continuation.issue, worker, next }, now);
  writeState(path, state);
  return commandOutcome(state, 'continuation_claimed', `${worker} claimed issue #${state.queue.continuation.issue} continuation.`);
}

// Validates the concrete durable artifact the caller declares (a sibling workflow state
// file, e.g. one written by `start --pr <evidence-pr>`) instead of trusting free-text
// prose (#113): the evidence PR must exist, target this continuation's issue and
// repository, and not be a dead/broken workflow.
function evidenceStateFor(options, path, state) {
  const evidencePullRequest = optionalNumber(options, 'evidence-pr');
  if (!evidencePullRequest) fail('Missing required option --evidence-pr.');
  const evidencePath = resolve(dirname(path), `${evidencePullRequest}.json`);
  const evidenceState = readState(evidencePath);
  if (evidenceState.task?.pullRequest !== evidencePullRequest
    || evidenceState.task?.issue !== state.queue.continuation.issue
    || evidenceState.task?.repository !== state.task.repository) {
    fail(`Evidence workflow PR #${evidencePullRequest} does not match issue #${state.queue.continuation.issue} in ${state.task.repository}.`);
  }
  const evidenceStatus = evidenceState.coordination?.status;
  if (UNRECOVERABLE_EVIDENCE_STATUSES.has(evidenceStatus)) {
    fail(`Evidence workflow PR #${evidencePullRequest} is "${evidenceStatus}", not a durable implementation step.`);
  }
  return evidencePullRequest;
}

function completeContinuation(options, path, now) {
  const state = readState(path);
  if (state.coordination.status !== 'completed') {
    fail(`Continuation completion requires status "completed", found "${state.coordination.status}".`);
  }
  if (!state.queue.continuation) {
    fail('Workflow has no pending queue continuation to complete.');
  }
  if (state.queue.continuation.status === 'done') {
    return commandOutcome(state, 'ignored_terminal', `Issue #${state.queue.continuation.issue} continuation is already done.`);
  }
  if (state.queue.continuation.status !== 'claimed') {
    fail(`Continuation must be "claimed" before it can be completed, found "${state.queue.continuation.status}".`);
  }
  const issueOption = requireOption(options, 'issue');
  if (Number(issueOption) !== state.queue.continuation.issue) {
    fail(`--issue must match the claimed continuation issue #${state.queue.continuation.issue}, received "${issueOption}".`);
  }
  const evidencePullRequest = evidenceStateFor(options, path, state);
  // The prose aids operators, but the sibling workflow state is the completion evidence.
  // A free-text assertion alone cannot prove the next durable step exists (#113).
  const evidence = requireOption(options, 'evidence');
  state.queue.continuation = {
    ...state.queue.continuation, status: 'done', completedAt: now, evidence, evidencePullRequest,
  };
  state.coordination = { ...state.coordination, next: { owner: 'none', action: `Issue #${state.queue.continuation.issue} continuation verified: ${evidence}` } };
  state.wakeup = { deadlineAt: null, lastTriggeredAt: null };
  appendHistory(state, { event: 'continuation_completed', issue: state.queue.continuation.issue, evidence }, now);
  writeState(path, state);
  return commandOutcome(state, 'continuation_completed', `Issue #${state.queue.continuation.issue} continuation verified.`);
}

function stop(options, path, now) {
  const state = readState(path);
  const previousStatus = state.coordination.status;
  if (TERMINAL_STATUSES.has(previousStatus)) {
    return commandOutcome(state, 'ignored_terminal', `Workflow is already ${previousStatus}.`);
  }
  requireReviewBatchComplete(state, 'stop workflow');
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
  // "completed" is normally terminal for wakeups too, but a declared nextIssue leaves a
  // pending/claimed continuation record that a missed or crashed session must still be able
  // to recover through (#110); only a continuation already marked "done" stays a true no-op.
  const continuationPending = state.coordination.status === 'completed' && state.queue.continuation?.status
    && state.queue.continuation.status !== 'done';
  if (TERMINAL_STATUSES.has(state.coordination.status) && !continuationPending) {
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
    'dispatch-review-batch': dispatchReviewBatch,
    'complete-review-batch': completeReviewBatch,
    'dispatch-fix': dispatchFix,
    runner: updateRunner,
    'confirm-runner-stop': confirmRunnerStop,
    takeover,
    pass: passReview,
    complete: completeWorkflow,
    'claim-continuation': claimContinuation,
    'complete-continuation': completeContinuation,
    resume: resumeWorkflow,
    stop,
    wake: recordWakeup,
  };
  if (command === 'show') return readState(path);
  if (!operations[command]) {
    fail('Usage: workflow.mjs show|start|ingest|claim-review|dispatch-review-batch|complete-review-batch|dispatch-fix|runner|confirm-runner-stop|takeover|pass|complete|claim-continuation|complete-continuation|resume|stop|wake [--name value ...]');
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