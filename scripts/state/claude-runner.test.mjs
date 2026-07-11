import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { run } from './workflow.mjs';

const RUNNER = new URL('./claude-runner.mjs', import.meta.url).pathname;

function prepareState(statePath) {
  process.env.OMXTERM_AGENT_STATE_PATH = statePath;
  run([
    'start', '--task', 'Runner test', '--issue', '102', '--pr', '103',
    '--worker', 'webhook', '--next', 'Review.', '--sha', 'sha-a', '--queue-end', 'true',
  ]);
  run([
    'claim-review', '--pr', '103', '--sha', 'sha-a', '--worker', 'brien',
    '--next', 'Review.', '--deadline-at', '2026-07-11T20:00:00.000Z',
  ]);
  run([
    'dispatch-fix', '--pr', '103', '--sha', 'sha-a', '--worker', 'claude',
    '--runner-id', 'runner-test', '--deadline-at', '2026-07-11T20:00:00.000Z',
    '--reason', 'Test correction.', '--next', 'Implement.',
  ]);
  delete process.env.OMXTERM_AGENT_STATE_PATH;
}

test('runs Claude with Sonnet/high, passes prompt on stdin, and records success', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-claude-runner-'));
  const statePath = join(directory, '103.json');
  const promptPath = join(directory, 'prompt.md');
  const capturePath = join(directory, 'capture.json');
  const fakeClaude = join(directory, 'claude');
  const lockPath = join(directory, 'claude.lock');
  const logPath = join(directory, 'runner.log');
  try {
    prepareState(statePath);
    writeFileSync(promptPath, 'Fix the verified blocker.');
    writeFileSync(fakeClaude, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nlet input='';process.stdin.on('data',d=>input+=d).on('end',()=>writeFileSync(process.env.CAPTURE_PATH,JSON.stringify({args:process.argv.slice(2),input})));\n`);
    chmodSync(fakeClaude, 0o700);
    writeFileSync(lockPath, 'runner-test\n');

    const result = spawnSync(process.execPath, [
      RUNNER, '--pr', '103', '--runner-id', 'runner-test', '--prompt-file', promptPath,
      '--workdir', directory, '--log-file', logPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMXTERM_AGENT_STATE_PATH: statePath,
        OMXTERM_CLAUDE_PATH: fakeClaude,
        OMXTERM_CLAUDE_LOCK_PATH: lockPath,
        CAPTURE_PATH: capturePath,
      },
    });

    const diagnostics = [result.stderr, result.stdout, readFileSync(logPath, 'utf8')].filter(Boolean).join('\n');
    assert.equal(result.status, 0, diagnostics);
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.args, [
      '--dangerously-skip-permissions', '--model', 'sonnet', '--effort', 'high',
      '--no-session-persistence', '-p',
    ]);
    assert.equal(capture.input, 'Fix the verified blocker.');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.runner.status, 'succeeded');
    assert.equal(state.coordination.status, 'fixing');
    assert.equal(state.coordination.codeAttempt, 1);
    assert.throws(() => readFileSync(lockPath), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('records runner failure and releases its lock when prompt loading fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-claude-runner-failure-'));
  const statePath = join(directory, '103.json');
  const lockPath = join(directory, 'claude.lock');
  try {
    prepareState(statePath);
    writeFileSync(lockPath, 'runner-test\n');
    const result = spawnSync(process.execPath, [
      RUNNER, '--pr', '103', '--runner-id', 'runner-test',
      '--prompt-file', join(directory, 'missing.md'), '--workdir', directory,
      '--log-file', join(directory, 'runner.log'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMXTERM_AGENT_STATE_PATH: statePath,
        OMXTERM_CLAUDE_PATH: '/bin/true',
        OMXTERM_CLAUDE_LOCK_PATH: lockPath,
      },
    });

    assert.equal(result.status, 1);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.runner.status, 'failed');
    assert.match(state.runner.reason, /ENOENT/);
    assert.throws(() => readFileSync(lockPath), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
