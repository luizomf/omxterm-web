import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = new URL('./omxterm-github-review-webhook.py', import.meta.url).pathname;
const WORKFLOW = new URL('./workflow.mjs', import.meta.url).pathname;

function runFilter(payload, statePath) {
  const result = spawnSync('python3', [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, OMXTERM_AGENT_STATE_PATH: statePath, OMXTERM_WORKFLOW_CLI: WORKFLOW },
  });
  return { ...result, output: result.stdout.trim() === '[SILENT]' ? null : JSON.parse(result.stdout) };
}

function withState(testFunction) {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-webhook-state-'));
  const statePath = join(directory, '103.json');
  try {
    testFunction(statePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function pullRequest(action = 'opened', sha = 'sha-a') {
  return {
    action,
    number: 103,
    repository: { full_name: 'luizomf/omxterm' },
    sender: { login: 'luizomf' },
    pull_request: {
      title: 'Workflow test', html_url: 'https://example.test/pr/103', draft: false,
      user: { login: 'luizomf' }, head: { sha }, base: { ref: 'main' },
    },
  };
}

test('persists an accepted PR event before returning it to Hermes', () => {
  withState((statePath) => {
    const result = runFilter(pullRequest(), statePath);
    assert.equal(result.status, 0);
    assert.equal(result.output.event, 'pull_request');
    assert.equal(result.output.workdir, new URL('../../', import.meta.url).pathname.replace(/\/$/, ''));
    assert.equal(result.output.state_ingest.outcome, 'event_queued');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.coordination.status, 'queued');
    assert.equal(state.coordination.headSha, 'sha-a');
    assert.ok(state.wakeup.deadlineAt);
  });
});

test('normalizes a guardian wakeup without replacing workflow state', () => {
  withState((statePath) => {
    runFilter(pullRequest(), statePath);
    const before = readFileSync(statePath, 'utf8');
    const result = runFilter({
      event: 'workflow_wakeup', action: 'deadline', pr_number: 103,
      head_sha: 'sha-a', workflow_status: 'fixing', runner: { id: 'runner-a' },
      repository: { full_name: 'luizomf/omxterm' },
    }, statePath);
    assert.equal(result.output.event, 'workflow_wakeup');
    assert.equal(readFileSync(statePath, 'utf8'), before);
  });
});

test('ignores untrusted comments and the agent response marker', () => {
  withState((statePath) => {
    const base = {
      action: 'created', repository: { full_name: 'luizomf/omxterm' },
      issue: { number: 103, pull_request: {}, title: 'PR' },
      comment: { id: 1, body: '/review this' },
    };
    assert.equal(runFilter({ ...base, sender: { login: 'outsider' } }, statePath).output, null);
    assert.equal(runFilter({ ...base, sender: { login: 'luizomf' }, comment: { body: '/review <!-- brien-webhook-response -->' } }, statePath).output, null);
  });
});

test('normalizes a trusted maintainer comment beginning with /review', () => {
  withState((statePath) => {
    const result = runFilter({
      action: 'created', repository: { full_name: 'luizomf/omxterm' },
      sender: { login: 'luizomf' },
      issue: { number: 103, pull_request: { url: 'https://example.test/pr/103' }, title: 'PR' },
      comment: { id: 1, body: '/review this please' },
    }, statePath);
    assert.equal(result.output.event, 'issue_comment');
    assert.equal(result.output.comment, '/review this please');
  });
});

test('ignores a trusted maintainer comment mentioning @brien later in prose', () => {
  withState((statePath) => {
    const result = runFilter({
      action: 'created', repository: { full_name: 'luizomf/omxterm' },
      sender: { login: 'luizomf' },
      issue: { number: 103, pull_request: { url: 'https://example.test/pr/103' }, title: 'PR' },
      comment: { id: 1, body: 'context only @brien no action' },
    }, statePath);
    assert.equal(result.output, null);
  });
});
