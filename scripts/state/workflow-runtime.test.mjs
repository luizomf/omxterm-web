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

test('forwards a non-default XDG_STATE_HOME to the transient Claude runner', () => {
  temporaryDirectory('omxterm-start-claude-xdg-', (directory) => {
    const customStateHome = join(directory, 'custom-state-home');
    mkdirSync(customStateHome, { recursive: true });
    const statePath = join(directory, '103.json');
    const lockPath = join(directory, 'claude.lock');
    const systemdRunCapture = join(directory, 'systemd-run-argv');
    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    // Fakes let start-claude.mjs finish its startup confirmation without touching a real
    // systemd instance: systemd-run records its argv, systemctl reports the unit active
    // on the first poll so waitForRunner returns immediately.
    writeFileSync(join(fakeBin, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${systemdRunCapture}"\nexit 0\n`);
    chmodSync(join(fakeBin, 'systemd-run'), 0o700);
    writeFileSync(join(fakeBin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(fakeBin, 'systemctl'), 0o700);
    writeFileSync(join(directory, 'prompt.md'), 'unused');
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      task: { description: 'test', issue: 104, pullRequest: 103, repository: 'luizomf/omxterm' },
      queue: { nextIssue: null, end: true, continueOnFailure: false },
      coordination: { status: 'reviewing', codeAttempt: 0, maxCodeAttempts: 3, worker: 'brien', headSha: 'sha-a', expectedEvent: null, next: { owner: 'brien', action: 'Review.' } },
      lease: { owner: 'brien', expiresAt: null }, runner: null, wakeup: { deadlineAt: null, lastTriggeredAt: null },
      stop: { requested: false, reason: null }, createdAt: 'now', updatedAt: 'now', history: [],
    }));

    const result = spawnSync(process.execPath, [START_CLAUDE,
      '--pr', '103', '--sha', 'sha-a', '--runner-id', 'runner-xdg1',
      '--prompt-file', join(directory, 'prompt.md'), '--deadline-at', 'later',
      '--reason', 'finding', '--workdir', directory,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        XDG_STATE_HOME: customStateHome,
        OMXTERM_AGENT_STATE_PATH: statePath,
        OMXTERM_CLAUDE_LOCK_PATH: lockPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const argv = readFileSync(systemdRunCapture, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(
      argv.filter((arg) => arg.startsWith('--setenv=XDG_STATE_HOME=')),
      [`--setenv=XDG_STATE_HOME=${customStateHome}`],
    );
  });
});

test('guardian treats a completed workflow with a pending queue continuation as due for wakeup, but a finished one as a no-op', () => {
  const script = `
import importlib.util
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location('workflow_guardian', ${JSON.stringify(GUARDIAN)})
guardian = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardian)

now = datetime.now(timezone.utc)
past = (now - timedelta(minutes=1)).isoformat()

def state(continuation_status):
    return {
        'coordination': {'status': 'completed'},
        'queue': {'continuation': None if continuation_status is None else {'status': continuation_status}},
        'wakeup': {'deadlineAt': past, 'lastTriggeredAt': None},
    }

assert guardian.due(state('pending'), now) is True, 'a pending continuation must be recoverable after a missed session'
assert guardian.due(state('claimed'), now) is True, 'a claimed-but-unfinished continuation must remain recoverable'
assert guardian.due(state('done'), now) is False, 'a finished continuation must not keep waking the guardian'
assert guardian.due(state(None), now) is False, 'an explicit queue end must stay a true no-op'
print('ok')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
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
