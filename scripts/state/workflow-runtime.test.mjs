import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const START_CLAUDE = new URL('./start-claude.mjs', import.meta.url).pathname;
const GUARDIAN = new URL('./workflow-guardian.py', import.meta.url).pathname;

function temporaryDirectory(prefix, testFunction) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return testFunction(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('does not launch systemd runner when canonical dispatch is refused', () => {
  temporaryDirectory('omxterm-start-claude-', (directory) => {
    const statePath = join(directory, '103.json');
    const lockPath = join(directory, 'claude.lock');
    const systemdCapture = join(directory, 'systemd-run-called');
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'systemd-run'), `#!/bin/sh\ntouch "${systemdCapture}"\n`);
    chmodSync(join(fakeBin, 'systemd-run'), 0o700);
    writeFileSync(join(directory, 'prompt.md'), 'unused');
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      task: { description: 'test', issue: 104, pullRequest: 103, repository: 'luizomf/omxterm' },
      queue: { nextIssue: null, end: true, continueOnFailure: false },
      coordination: { status: 'queued', codeAttempt: 0, maxCodeAttempts: 3, worker: 'webhook', headSha: 'sha-a', expectedEvent: 'pull_request', next: { owner: 'brien', action: 'Review.' } },
      lease: null, runner: null, wakeup: { deadlineAt: null, lastTriggeredAt: null },
      stop: { requested: false, reason: null }, createdAt: 'now', updatedAt: 'now', history: [],
    }));

    const result = spawnSync(process.execPath, [START_CLAUDE,
      '--pr', '103', '--sha', 'sha-a', '--runner-id', 'runner-a1',
      '--prompt-file', join(directory, 'prompt.md'), '--deadline-at', 'later',
      '--reason', 'finding', '--workdir', directory,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, OMXTERM_AGENT_STATE_PATH: statePath, OMXTERM_CLAUDE_LOCK_PATH: lockPath } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Correction dispatch requires status/);
    assert.throws(() => readFileSync(systemdCapture), /ENOENT/);
    assert.throws(() => readFileSync(lockPath), /ENOENT/);
  });
});

test('guardian discovers workflows under XDG_STATE_HOME', () => {
  temporaryDirectory('omxterm-guardian-', (directory) => {
    const stateDirectory = join(directory, 'omxterm-agent', 'pr');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, '103.json'), 'invalid-json');
    const result = spawnSync('python3', [GUARDIAN], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: directory },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSONDecodeError/);
  });
});
