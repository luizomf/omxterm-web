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

test('requeues a passed workflow when the PR changes before merge', () => {
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

test('does not reopen a completed workflow when a delayed event has another SHA', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', 'abcdef0123456789abcdef0123456789abcdef01']);

    const delayed = run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);

    assert.equal(delayed.command.outcome, 'ignored_terminal');
    assert.equal(delayed.coordination.status, 'completed');
    assert.equal(delayed.coordination.headSha, 'sha-a');
    assert.equal(delayed.history.at(-1).event, 'workflow_completed');
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

test('continues dispatching corrections beyond the configured diagnostic count', () => {
  withState(() => {
    run([...START.slice(0, START.indexOf('--max-attempts')), '--max-attempts', '1', '--queue-end', 'true']);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'First finding.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'succeeded']);
    run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    run([
      'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
      '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);

    const second = run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-b', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a2', '--deadline-at', '2026-07-11T21:00:00.000Z',
      '--reason', 'Second finding.', '--next', 'Implement.',
    ]);

    assert.equal(second.command.outcome, 'dispatched');
    assert.equal(second.coordination.status, 'fixing');
    assert.equal(second.coordination.codeAttempt, 2);
  });
});

test('resumes a legacy failed workflow without resetting revision history', () => {
  withState(() => {
    run(START);
    run(['stop', '--pr', '103', '--status', 'failed', '--reason', 'Legacy attempt ceiling.']);

    const resumed = run([
      'resume', '--pr', '103', '--reason', 'Attempt count no longer stops code progress.',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);

    assert.equal(resumed.command.outcome, 'resumed');
    assert.equal(resumed.coordination.status, 'queued');
    assert.equal(resumed.coordination.worker, 'webhook');
    assert.equal(resumed.stop.requested, false);
    assert.equal(resumed.history.at(-1).event, 'workflow_resumed');
  });
});

test('refuses to resume while the recorded Claude runner may still be active', () => {
  for (const runnerStatus of ['starting', 'running']) {
    withState(() => {
      run(START);
      run(CLAIM);
      run([
        'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
        '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
        '--reason', 'Review blocker.', '--next', 'Implement.',
      ]);
      if (runnerStatus === 'running') {
        run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
      }
      run(['stop', '--pr', '103', '--status', 'failed', '--reason', 'Legacy attempt ceiling.']);

      const refused = run([
        'resume', '--pr', '103', '--reason', 'Attempt count no longer stops code progress.',
        '--deadline-at', '2026-07-11T20:00:00.000Z',
      ]);

      assert.equal(refused.command.outcome, 'ignored_worker_active', runnerStatus);
      assert.equal(refused.coordination.status, 'failed', runnerStatus);
      assert.equal(refused.runner.status, runnerStatus, runnerStatus);
      assert.equal(refused.stop.requested, true, runnerStatus);
    });
  }
});

test('refuses to resume a legacy failed workflow while an abandoned runner\'s stop is unconfirmed', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    const superseded = run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(superseded.runner.status, 'abandoned');
    assert.equal(superseded.runner.stopConfirmed, false);

    run(['stop', '--pr', '103', '--status', 'failed', '--reason', 'Legacy attempt ceiling.']);

    const refused = run([
      'resume', '--pr', '103', '--reason', 'Attempt count no longer stops code progress.',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);

    assert.equal(refused.command.outcome, 'ignored_runner_stop_pending');
    assert.equal(refused.coordination.status, 'failed');
    assert.equal(refused.runner.status, 'abandoned');
    assert.equal(refused.runner.stopConfirmed, false);
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

test('refuses to revive a runner abandoned by a newer SHA before it reported running', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    const superseded = run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(superseded.runner.status, 'abandoned');

    const revived = run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
    assert.equal(revived.command.outcome, 'ignored_superseded_runner');
    assert.equal(revived.runner.status, 'abandoned');

    const stillAbandoned = run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'succeeded']);
    assert.equal(stillAbandoned.command.outcome, 'ignored_superseded_runner');
    assert.equal(stillAbandoned.runner.status, 'abandoned');
    assert.equal(run(['show', '--pr', '103']).coordination.headSha, 'sha-b');
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

test('claims a new SHA once the runner that owned the previous SHA already reported terminal', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'succeeded']);
    const review = run([
      'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
      '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(review.command.outcome, 'claimed');
    assert.equal(review.coordination.status, 'reviewing');
    assert.equal(review.coordination.headSha, 'sha-b');
  });
});

test('blocks claiming a newer SHA while the previous runner is still starting or running', () => {
  withState(() => {
    for (const runnerStatus of ['starting', 'running']) {
      run(START);
      run(CLAIM);
      run([
        'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
        '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
        '--reason', 'Review blocker.', '--next', 'Implement.',
      ]);
      if (runnerStatus === 'running') {
        run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
      }

      const blocked = run([
        'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
        '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
      ]);
      assert.equal(blocked.command.outcome, 'ignored_runner_stop_pending', runnerStatus);
      assert.equal(blocked.runner.status, 'abandoned', runnerStatus);
      assert.equal(blocked.runner.stopConfirmed, false, runnerStatus);
      // The runner id must still be claimable by the still-running Claude subprocess: proves
      // this path never lets an implementer keep going while a new SHA is under review.
      const staleSelfReport = run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'succeeded']);
      assert.equal(staleSelfReport.command.outcome, 'ignored_superseded_runner', runnerStatus);

      const retriedWhileUnconfirmed = run([
        'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
        '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
      ]);
      assert.equal(retriedWhileUnconfirmed.command.outcome, 'ignored_runner_stop_pending', runnerStatus);

      assert.throws(
        () => run(['takeover', '--pr', '103', '--worker', 'brien', '--reason', 'Stale.', '--next', 'Resume.', '--deadline-at', '2026-07-11T20:00:00.000Z']),
        /Cannot|requires status/,
        runnerStatus,
      );

      run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--unit-status', 'inactive', '--reason', 'systemctl confirmed inactive.']);
      const unblocked = run([
        'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
        '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
      ]);
      assert.equal(unblocked.command.outcome, 'claimed', runnerStatus);
      assert.equal(unblocked.coordination.headSha, 'sha-b', runnerStatus);

      run(['pass', '--pr', '103', '--sha', 'sha-b', '--reason', 'cleanup']);
    }
  });
});

test('blocks a newer SHA delivered through ingest until the abandoned runner is confirmed stopped', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
    const ingested = run([
      'ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize',
      '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(ingested.runner.stopConfirmed, false);
    assert.match(ingested.coordination.next.action, /Stop and confirm runner/);

    const blocked = run([
      'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
      '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(blocked.command.outcome, 'ignored_runner_stop_pending');

    run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--unit-status', 'inactive', '--reason', 'systemctl confirmed inactive.']);
    const claimed = run([
      'claim-review', '--pr', '103', '--sha', 'sha-b', '--worker', 'brien',
      '--next', 'Review SHA sha-b.', '--deadline-at', '2026-07-11T20:00:00.000Z',
    ]);
    assert.equal(claimed.command.outcome, 'claimed');
  });
});

test('confirm-runner-stop requires the recorded runner id and a systemd-derived inactive status', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run([
      'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
      '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T19:00:00.000Z',
      '--reason', 'Review blocker.', '--next', 'Implement.',
    ]);
    run(['runner', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--status', 'running']);
    run(['ingest', '--pr', '103', '--sha', 'sha-b', '--action', 'synchronize', '--deadline-at', '2026-07-11T20:00:00.000Z']);

    const staleId = run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'wrong-id', '--unit-status', 'inactive', '--reason', 'x']);
    assert.equal(staleId.command.outcome, 'ignored_stale_runner');

    assert.throws(
      () => run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--unit-status', 'active', '--reason', 'x']),
      /must confirm the systemd unit is inactive/,
    );

    const confirmed = run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--unit-status', 'inactive', '--reason', 'systemctl confirmed inactive.']);
    assert.equal(confirmed.command.outcome, 'runner_stop_confirmed');
    assert.equal(confirmed.runner.stopConfirmed, true);

    const alreadyConfirmed = run(['confirm-runner-stop', '--pr', '103', '--runner-id', 'omxterm-pr-103-a1', '--unit-status', 'inactive', '--reason', 'x']);
    assert.equal(alreadyConfirmed.command.outcome, 'ignored_already_confirmed');
  });
});

test('blocks review decisions until the matching asynchronous review batch completes', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    const dispatched = run([
      'dispatch-review-batch', '--pr', '103', '--sha', 'sha-a',
      '--delegation-id', 'deleg-review-a', '--deadline-at', '2026-07-11T19:30:00.000Z',
    ], '2026-07-11T18:05:00.000Z');

    assert.equal(dispatched.reviewBatch.status, 'pending');
    assert.equal(dispatched.reviewBatch.delegationId, 'deleg-review-a');
    assert.throws(
      () => run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Premature.']),
      /Cannot pass review while review batch "deleg-review-a" is pending/,
    );
    assert.throws(
      () => run([
        'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
        '--runner-id', 'omxterm-pr-103-a1', '--deadline-at', '2026-07-11T20:00:00.000Z',
        '--reason', 'Premature finding.', '--next', 'Implement.',
      ]),
      /Cannot dispatch correction while review batch "deleg-review-a" is pending/,
    );
    assert.throws(
      () => run(['complete-review-batch', '--pr', '103', '--delegation-id', 'deleg-stale']),
      /must match pending review batch "deleg-review-a"/,
    );

    const completed = run([
      'complete-review-batch', '--pr', '103', '--delegation-id', 'deleg-review-a',
    ], '2026-07-11T18:06:00.000Z');
    assert.equal(completed.reviewBatch.status, 'completed');
    assert.equal(completed.reviewBatch.completedAt, '2026-07-11T18:06:00.000Z');
    assert.equal(run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'All reviewers passed.']).command.outcome, 'passed');
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

const VALID_MERGE_SHA = 'abcdef0123456789abcdef0123456789abcdef01';

test('records merge completion after a passed review', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    const completed = run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA], '2026-07-11T21:00:00.000Z');
    assert.equal(completed.command.outcome, 'completed');
    assert.equal(completed.coordination.status, 'completed');
    assert.equal(completed.coordination.next.owner, 'none');
    assert.equal(completed.coordination.next.action, 'Queue is complete.');
    assert.deepEqual(completed.merge, { sha: VALID_MERGE_SHA, completedAt: '2026-07-11T21:00:00.000Z' });
    assert.equal(run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]).command.outcome, 'ignored_terminal');
  });
});

test('refuses merge completion before review passes', () => {
  withState(() => {
    run(START);
    assert.throws(() => run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]), /requires status "passed"/);
  });
});

test('rejects a malformed merge SHA and records no completion or merge metadata', () => {
  withState((statePath) => {
    run(START);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    assert.throws(
      () => run(['complete', '--pr', '103', '--merge-sha', 'definitely-not-a-git-sha']),
      /--merge-sha must be a full 40-character lowercase hexadecimal Git SHA, received "definitely-not-a-git-sha"/,
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.coordination.status, 'passed');
    assert.equal(state.merge, undefined);
  });
});

test('completing a passed review with a next issue records a durable pending continuation', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    const completed = run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA], '2026-07-11T21:00:00.000Z');

    assert.deepEqual(completed.queue.continuation, {
      status: 'pending', issue: 104, claimedBy: null, claimedAt: null, completedAt: null, evidence: null,
    });
    assert.equal(completed.coordination.next.owner, 'brien');
    assert.match(completed.coordination.next.action, /issue #104/);
    // A live deadline (rather than null) is what lets the guardian recover this PR's
    // queue continuation if the current session crashes before claiming it (#110).
    assert.equal(completed.wakeup.deadlineAt, '2026-07-11T21:00:00.000Z');
  });
});

test('claims and completes a queue continuation with durable evidence, in the normal case', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);

    const claimed = run([
      'claim-continuation', '--pr', '103', '--worker', 'brien',
      '--next', 'Create branch and issue draft for #104.',
      '--deadline-at', '2026-07-11T21:30:00.000Z',
    ]);
    assert.equal(claimed.command.outcome, 'continuation_claimed');
    assert.equal(claimed.queue.continuation.status, 'claimed');
    assert.equal(claimed.queue.continuation.claimedBy, 'brien');
    assert.equal(claimed.wakeup.deadlineAt, '2026-07-11T21:30:00.000Z');

    const completed = run([
      'complete-continuation', '--pr', '103', '--issue', '104',
      '--evidence', 'Created branch fix/104-x, opened PR #110, wrote 110.json.',
    ]);
    assert.equal(completed.command.outcome, 'continuation_completed');
    assert.equal(completed.queue.continuation.status, 'done');
    assert.match(completed.queue.continuation.evidence, /PR #110/);
    assert.equal(completed.coordination.next.owner, 'none');
    assert.equal(completed.wakeup.deadlineAt, null);
  });
});

test('treats a duplicate or competing continuation claim as a clean no-op', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);
    run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'Work it.', '--deadline-at', '2026-07-11T21:30:00.000Z']);

    const duplicate = run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'Work it again.', '--deadline-at', '2026-07-11T22:00:00.000Z']);
    assert.equal(duplicate.command.outcome, 'ignored_duplicate');
    assert.equal(duplicate.queue.continuation.claimedBy, 'brien');

    const competing = run(['claim-continuation', '--pr', '103', '--worker', 'hermes', '--next', 'Steal it.', '--deadline-at', '2026-07-11T22:00:00.000Z']);
    assert.equal(competing.command.outcome, 'ignored_worker_active');
    assert.equal(competing.queue.continuation.claimedBy, 'brien');
  });
});

test('recovers a missed queue continuation after an interrupted session via wakeup', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);
    // Simulate the completing session crashing before it claims or dispatches issue #104:
    // a fresh session only has the guardian-triggered `wake` to recover through.
    const woken = run(['wake', '--pr', '103', '--reason', 'guardian deadline reached'], '2026-07-11T21:05:00.000Z');
    assert.equal(woken.command.outcome, 'wakeup_recorded');
    assert.equal(woken.coordination.status, 'completed');
    assert.equal(woken.queue.continuation.status, 'pending');

    const recovered = run([
      'claim-continuation', '--pr', '103', '--worker', 'brien',
      '--next', 'Create branch and issue draft for #104.',
      '--deadline-at', '2026-07-11T21:30:00.000Z',
    ]);
    assert.equal(recovered.command.outcome, 'continuation_claimed');

    const finished = run(['complete-continuation', '--pr', '103', '--issue', '104', '--evidence', 'Verified branch and workflow state exist.']);
    assert.equal(finished.queue.continuation.status, 'done');
  });
});

test('does not resurrect a queue continuation once it is already done', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);
    run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'Work it.', '--deadline-at', '2026-07-11T21:30:00.000Z']);
    run(['complete-continuation', '--pr', '103', '--issue', '104', '--evidence', 'Done.']);

    assert.equal(run(['wake', '--pr', '103']).command.outcome, 'ignored_terminal');
    assert.equal(run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'x', '--deadline-at', '2026-07-11T22:00:00.000Z']).command.outcome, 'ignored_terminal');
    assert.equal(run(['complete-continuation', '--pr', '103', '--issue', '104', '--evidence', 'x']).command.outcome, 'ignored_terminal');
  });
});

test('rejects continuation commands outside their required state', () => {
  withState(() => {
    run(START);
    assert.throws(() => run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'x', '--deadline-at', '2026-07-11T22:00:00.000Z']), /requires status "completed"/);

    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);
    // START declared --queue-end true, so there is no nextIssue and no continuation to claim.
    assert.throws(() => run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'x', '--deadline-at', '2026-07-11T22:00:00.000Z']), /no pending queue continuation/);
    assert.throws(() => run(['complete-continuation', '--pr', '103', '--issue', '104', '--evidence', 'x']), /no pending queue continuation/);
  });
});

test('refuses to complete a continuation before it is claimed, or for the wrong issue', () => {
  withState(() => {
    run([...START.slice(0, -2), '--next-issue', '104']);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);

    assert.throws(() => run(['complete-continuation', '--pr', '103', '--issue', '104', '--evidence', 'x']), /must be "claimed"/);

    run(['claim-continuation', '--pr', '103', '--worker', 'brien', '--next', 'x', '--deadline-at', '2026-07-11T22:00:00.000Z']);
    assert.throws(() => run(['complete-continuation', '--pr', '103', '--issue', '999', '--evidence', 'x']), /must match the claimed continuation issue #104/);
  });
});

test('a completed workflow with an explicit queue end stays a true wakeup no-op', () => {
  withState(() => {
    run(START);
    run(CLAIM);
    run(['pass', '--pr', '103', '--sha', 'sha-a', '--reason', 'Looks good.']);
    run(['complete', '--pr', '103', '--merge-sha', VALID_MERGE_SHA]);

    assert.equal(run(['wake', '--pr', '103']).command.outcome, 'ignored_terminal');
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