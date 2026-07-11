import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { run } from './workflow.mjs';

function withState(testFunction) {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-agent-state-'));
  process.env.OMXTERM_AGENT_STATE_PATH = join(directory, '103.json');
  try {
    return testFunction(process.env.OMXTERM_AGENT_STATE_PATH);
  } finally {
    delete process.env.OMXTERM_AGENT_STATE_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
}

const START = [
  'start', '--task', 'Fix issue #102', '--issue', '102', '--pr', '103',
  '--worker', 'webhook', '--next', 'Review PR #103.', '--sha', 'sha-a',
  '--max-attempts', '3', '--queue-end', 'true',
];
const CLAIM = [
  'claim-review', '--pr', '103', '--sha', 'sha-a', '--worker', 'brien',
  '--next', 'Review SHA sha-a.', '--deadline-at', '2026-07-11T19:00:00.000Z',
];

test('creates one external workflow per PR with an explicit queue end', () => {
  withState((path) => {
    const state = run(START, '2026-07-11T18:00:00.000Z');
    assert.equal(state.version, 2);
    assert.equal(state.coordination.status, 'queued');
    assert.equal(state.coordination.codeAttempt, 0);
    assert.equal(state.queue.end, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state);
  });
});

test('requires either a next issue or an explicit queue end', () => {
  withState(() => {
    assert.throws(() => run(START.slice(0, -2)), /exactly one of --next-issue/);
    assert.throws(() => run([...START, '--next-issue', '104']), /exactly one of --next-issue/);
  });
});

test('ignores a duplicate review claim instead of blocking the workflow', () => {
  withState(() => {
    run(START);
    assert.equal(run(CLAIM).command.outcome, 'claimed');
    const duplicate = run(CLAIM);
    assert.equal(duplicate.command.outcome, 'ignored_duplicate');
    assert.equal(run(['show', '--pr', '103']).coordination.status, 'reviewing');
  });
});

test('persists a GitHub event before Hermes starts and ignores redelivery', () => {
  withState(() => {
    const event = [
      'ingest', '--pr', '103', '--sha', 'sha-a', '--action', 'opened',
      '--deadline-at', '2026-07-11T19:00:00.000Z',
    ];
    const queued = run(event, '2026-07-11T18:00:00.000Z');
    assert.equal(queued.command.outcome, 'event_queued');
    assert.equal(queued.wakeup.deadlineAt, '2026-07-11T19:00:00.000Z');
    assert.equal(run(event).command.outcome, 'ignored_duplicate');
  });
});

test('requeues a terminal workflow when the PR receives a new SHA', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    const queued = run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(queued.coordination.status, 'queued');
    assert.equal(queued.coordination.codeAttempt, 0);
    assert.equal(queued.stop.requested, false);
  });
});

test('supersedes an in-progress review when GitHub reports a newer SHA', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    const newer = run([...CLAIM.slice(0, 4), 'sha-b', ...CLAIM.slice(5)]);
    assert.equal(newer.command.outcome, 'claimed');
    assert.equal(newer.coordination.headSha, 'sha-b');
    assert.equal(newer.history.at(-1).event, 'review_superseded');
  });
});

test('dispatches one correction and waits for a synchronize event', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    const fixing = run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement, test, commit, and push.',
    ]);
    assert.equal(fixing.coordination.status, 'fixing');
    assert.equal(fixing.coordination.codeAttempt, 1);
    assert.equal(fixing.coordination.expectedEvent, 'pull_request.synchronize');
    assert.equal(fixing.runner.status, 'starting');
  });
});

test('does not let Brien take over while Claude may still be running', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
    assert.throws(
      () => run(['takeover', '--pr', '103', '--worker', 'brien', '--reason', 'Timeout.', '--next', 'Resume.', '--deadline-at', '2026-07-11T20:00:00.000Z']),
      /still running/,
    );
  });
});

test('lets Brien recover a failed Claude run without consuming another code attempt', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'failed', '--reason', 'Quota exhausted.']);
    const recovered = run([
      'takeover', '--pr', '103', '--worker', 'brien', '--reason', 'Claude unavailable.',
      '--next', 'Resume partial work.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(recovered.command.outcome, 'taken_over');
    assert.equal(recovered.coordination.codeAttempt, 1);
    assert.equal(recovered.coordination.worker, 'brien');
  });
});

test('claims a new SHA after the correction push', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    const review = run([
      'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
      '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(review.command.outcome, 'claimed');
    assert.equal(review.coordination.status, 'reviewing');
    assert.equal(review.coordination.headSha, 'sha-b');
  });
});

test('passes only the SHA currently under review and exposes the next issue', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    assert.throws(
      () => run(['pass', '--pr', '103', '--sha', 'stale', '--reason', 'Looks good.']),
      /Cannot pass stale SHA/,
    );
    const passed = run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    assert.equal(passed.coordination.status, 'passed');
    assert.match(passed.coordination.next.action, /issue #104/);
  });
});

test('records a guardian wakeup without changing workflow ownership', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    const woken = run(['wake', '--pr', '103', '--reason', 'Review lease expired'], '2026-07-11T19:01:00.000Z');
    assert.equal(woken.command.outcome, 'wakeup_recorded');
    assert.equal(woken.coordination.status, 'reviewing');
    assert.equal(woken.wakeup.lastTriggeredAt, '2026-07-11T19:01:00.000Z');
  });
});

test('recovers a dead local lock but preserves a live owner lock', () => {
  withState((path) => {
    run(START);
    writeFileSync(`${path}.lock`, JSON.stringify({ hostname: hostname(), pid: 2_147_483_647 }));
    assert.equal(run(['wake', '--pr', '103']).command.outcome, 'wakeup_recorded');

    writeFileSync(`${path}.lock`, JSON.stringify({ hostname: hostname(), pid: process.pid }));
    assert.throws(() => run(['wake', '--pr', '103']), /Another orchestrator may be updating it/);
  });
});

test('rejects malformed numeric options instead of truncating them', () => {
  for (const [name, value] of [['--max-attempts', '1.5'], ['--issue', '102x'], ['--pr', '10 3']]) {
    withState(() => {
      const args = START.filter((_, index) => ![START.indexOf(name), START.indexOf(name) + 1].includes(index));
      assert.throws(() => run([...args, name, value]), /must be a positive integer/);
    });
  }
});