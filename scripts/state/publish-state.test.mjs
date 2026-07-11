import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { run } from './workflow.mjs';

const PUBLISH_STATE = new URL('./publish-state.mjs', import.meta.url).pathname;

// Simulates `gh api ... --paginate`: real gh already merges every REST array page into
// one JSON array on stdout, so the fake returns a single array long enough to span what
// would be several 100-per-page requests. It rejects --slurp so a regression that
// reintroduces the unsupported flag fails immediately, matching the installed gh CLI
// (2.45.0) that has no --slurp support.
function writeFakeGh(path, { commentCount, markerIndex, viewerLogin, logPath }) {
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const [, , subcommand, endpoint, ...rest] = process.argv;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

if (subcommand !== 'api') { console.error(\`fake-gh: unsupported subcommand "\${subcommand}"\`); process.exit(1); }
if (rest.includes('--slurp')) { console.error('unknown flag: --slurp'); process.exit(1); }

appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ endpoint, rest }) + '\\n');

if (endpoint === 'user') {
  console.log(JSON.stringify({ login: ${JSON.stringify(viewerLogin)} }));
  process.exit(0);
}

if (endpoint.includes('/comments?') && rest.includes('--paginate')) {
  const comments = Array.from({ length: ${commentCount} }, (_, index) => ({
    id: 1000 + index,
    user: { login: index === ${markerIndex} ? ${JSON.stringify(viewerLogin)} : \`other-\${index}\` },
    body: index === ${markerIndex} ? '<!-- agent-workflow-state -->\\nstale state' : \`comment \${index}\`,
  }));
  console.log(JSON.stringify(comments));
  process.exit(0);
}

if (endpoint.includes('/statuses/')) {
  readStdin();
  console.log(JSON.stringify({ id: 'status-1' }));
  process.exit(0);
}

if (rest.includes('PATCH')) {
  readStdin();
  console.log(JSON.stringify({ id: Number(endpoint.split('/').pop()) }));
  process.exit(0);
}

if (endpoint.includes('/comments') && rest.includes('POST')) {
  readStdin();
  console.log(JSON.stringify({ id: 9999 }));
  process.exit(0);
}

console.error(\`fake-gh: unhandled endpoint "\${endpoint}" rest=\${JSON.stringify(rest)}\`);
process.exit(1);
`);
  chmodSync(path, 0o700);
}

function prepareState(statePath) {
  process.env.OMXTERM_AGENT_STATE_PATH = statePath;
  run([
    'start', '--task', 'Publish state test', '--issue', '104', '--pr', '105',
    '--worker', 'webhook', '--next', 'Review.', '--sha', 'sha-a', '--queue-end', 'true',
  ]);
  delete process.env.OMXTERM_AGENT_STATE_PATH;
}

function runPublishState(env) {
  return spawnSync(process.execPath, [PUBLISH_STATE, '--pr', '105'], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('finds the marker comment across a merged multi-page comment list and patches it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-publish-state-'));
  const statePath = join(directory, '105.json');
  const fakeGh = join(directory, 'gh');
  const logPath = join(directory, 'gh-calls.jsonl');
  try {
    prepareState(statePath);
    // 250 comments is more than two 100-per-page requests; the marker sits on what would
    // be the third page to prove the lookup scans the fully merged result, not just the
    // first page.
    writeFakeGh(fakeGh, { commentCount: 250, markerIndex: 210, viewerLogin: 'agent-bot', logPath });

    const result = runPublishState({ OMXTERM_AGENT_STATE_PATH: statePath, OMXTERM_GH_BIN: fakeGh });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commentId, 1000 + 210);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commentsCall = calls.find((call) => call.endpoint.includes('/comments?'));
    assert.ok(commentsCall, 'expected a paginated comments lookup call');
    assert.ok(commentsCall.rest.includes('--paginate'));
    assert.ok(!commentsCall.rest.includes('--slurp'));

    const patchCall = calls.find((call) => call.rest.includes('PATCH'));
    assert.ok(patchCall, 'expected a PATCH call updating the existing marker comment');
    assert.equal(patchCall.endpoint, `repos/luizomf/omxterm/issues/comments/${1000 + 210}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('creates a new sticky comment when no marker comment exists yet', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omxterm-publish-state-new-'));
  const statePath = join(directory, '105.json');
  const fakeGh = join(directory, 'gh');
  const logPath = join(directory, 'gh-calls.jsonl');
  try {
    prepareState(statePath);
    writeFakeGh(fakeGh, { commentCount: 3, markerIndex: -1, viewerLogin: 'agent-bot', logPath });

    const result = runPublishState({ OMXTERM_AGENT_STATE_PATH: statePath, OMXTERM_GH_BIN: fakeGh });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.commentId, 9999);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const postCall = calls.find((call) => call.endpoint.endsWith('/issues/105/comments') && call.rest.includes('POST'));
    assert.ok(postCall, 'expected a POST call creating a new sticky comment');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
