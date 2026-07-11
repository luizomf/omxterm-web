import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { run } from './workflow.mjs';

function withState(testFunction) {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-agent-state-'));
  const path = join(directory, 'workflow.json');
  process.env.OMXTERM_AGENT_STATE_PATH = path;
  try {
    return testFunction(path);
  } finally {
    delete process.env.OMXTERM_AGENT_STATE_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
}

const START = [
  'start',
  '--task',
  'Fix issue #102',
  '--issue',
  '102',
  '--worker',
  'claude',
  '--next',
  'Implement and open a PR.',
  '--max-attempts',
  '3',
];

test('records the active worker, task, next action, and stop conditions', () => {
  withState((path) => {
    const state = run(START, '2026-07-11T18:00:00.000Z');

    assert.equal(state.coordination.status, 'implementing');
    assert.equal(state.coordination.worker, 'claude');
    assert.equal(state.coordination.next.action, 'Implement and open a PR.');
    assert.equal(state.task.issue, 102);
    assert.deepEqual(state.stop.conditions, [
      'review passed',
      '3 attempts exhausted',
      'blocked',
      'explicit stop',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state);
  });
});

test('refuses to overwrite an active workflow', () => {
  withState(() => {
    run(START);

    assert.throws(() => run(START), /Workflow already active with status "implementing"/);
    assert.equal(run(['show']).history.length, 1);
  });
});

test('runs one correction loop and records its transition history', () => {
  withState(() => {
    run(START);
    run(['transition', '--status', 'awaiting_review', '--worker', 'webhook', '--next', 'Review PR #103.', '--pr', '103', '--sha', 'abc']);
    run(['transition', '--status', 'reviewing', '--worker', 'brien', '--next', 'Publish one final review.', '--sha', 'abc']);
    const fixing = run(['retry', '--worker', 'claude', '--reason', 'Compose bind is unreachable.', '--next', 'Fix blockers on PR #103.']);

    assert.equal(fixing.coordination.status, 'fixing');
    assert.equal(fixing.coordination.attempt, 2);
    assert.equal(fixing.coordination.worker, 'claude');
    assert.equal(fixing.task.pullRequest, 103);
    assert.equal(fixing.coordination.headSha, 'abc');
    assert.equal(fixing.history.at(-1).event, 'retry_started');
  });
});

test('stops instead of starting a correction beyond the attempt limit', () => {
  withState(() => {
    run([...START.slice(0, -1), '1']);
    run(['transition', '--status', 'awaiting_review', '--worker', 'webhook', '--next', 'Review PR.']);
    run(['transition', '--status', 'reviewing', '--worker', 'brien', '--next', 'Review PR.']);
    const failed = run(['retry', '--worker', 'claude', '--reason', 'Blocker remains.', '--next', 'Fix blocker.']);

    assert.equal(failed.coordination.status, 'failed');
    assert.equal(failed.coordination.worker, 'none');
    assert.equal(failed.stop.requested, true);
    assert.equal(failed.stop.reason, 'Maximum attempts exhausted.');
    assert.equal(failed.coordination.next.owner, 'human');
  });
});

test('rejects invalid transitions without changing the state', () => {
  withState(() => {
    run(START);

    assert.throws(
      () => run(['transition', '--status', 'reviewing', '--worker', 'brien', '--next', 'Review.']),
      /Invalid transition from "implementing" to "reviewing"/,
    );
    assert.equal(run(['show']).coordination.status, 'implementing');
  });
});

test('records an explicit stop and prevents later transitions', () => {
  withState(() => {
    run(START);
    const stopped = run(['stop', '--reason', 'Luiz requested a pause.', '--next', 'Wait for Luiz.']);

    assert.equal(stopped.coordination.status, 'stopped');
    assert.equal(stopped.stop.reason, 'Luiz requested a pause.');
    assert.equal(stopped.coordination.next.action, 'Wait for Luiz.');
    assert.throws(
      () => run(['transition', '--status', 'awaiting_review', '--worker', 'webhook', '--next', 'Review.']),
      /already stopped/,
    );
  });
});
