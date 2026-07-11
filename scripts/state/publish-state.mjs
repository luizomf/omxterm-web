#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import { run } from './workflow.mjs';

const COMMENT_MARKER = '<!-- agent-workflow-state -->';
const RESPONSE_MARKER = '<!-- brien-webhook-response -->';
const STATUS_STATES = { passed: 'success', completed: 'success', failed: 'failure', blocked: 'error', stopped: 'error' };

function ghApi(args, input) {
  const result = spawnSync('gh', ['api', ...args], { encoding: 'utf8', input: input ? `${JSON.stringify(input)}\n` : undefined });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `gh api exited with status ${result.status}.`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function commentBody(state) {
  const queue = state.queue.nextIssue ? `next issue #${state.queue.nextIssue}` : 'explicit queue end';
  const runner = state.runner ? `${state.runner.id} (${state.runner.status})` : 'none';
  return [
    COMMENT_MARKER,
    '## Agent workflow state',
    '',
    `- Phase: **${state.coordination.status}**`,
    `- Code attempt: **${state.coordination.codeAttempt}/${state.coordination.maxCodeAttempts}**`,
    `- Worker: **${state.coordination.worker}**`,
    `- Head SHA: \`${state.coordination.headSha}\``,
    `- Runner: **${runner}**`,
    `- Expected event: **${state.coordination.expectedEvent || 'none'}**`,
    `- Queue: **${queue}**`,
    `- Next: ${state.coordination.next.action}`,
    '',
    `_Updated: ${state.updatedAt}_`,
    '',
    RESPONSE_MARKER,
  ].join('\n');
}

function publishCommitStatus(state, owner, repository) {
  const status = STATUS_STATES[state.coordination.status] || 'pending';
  const description = `${state.coordination.status} · attempt ${state.coordination.codeAttempt}/${state.coordination.maxCodeAttempts} · worker ${state.coordination.worker}`.slice(0, 140);
  return ghApi([
    `repos/${owner}/${repository}/statuses/${state.coordination.headSha}`,
    '-X', 'POST', '--input', '-',
  ], {
    state: status,
    context: 'agent-workflow',
    description,
    target_url: `https://github.com/${state.task.repository}/pull/${state.task.pullRequest}`,
  });
}

function publishStickyComment(state, owner, repository) {
  const viewer = ghApi(['user']);
  const commentPages = ghApi([`repos/${owner}/${repository}/issues/${state.task.pullRequest}/comments?per_page=100`, '--paginate', '--slurp']);
  const comments = commentPages.flat();
  const existing = comments.find((comment) => comment.user?.login === viewer.login && comment.body?.includes(COMMENT_MARKER));
  const endpoint = existing
    ? `repos/${owner}/${repository}/issues/comments/${existing.id}`
    : `repos/${owner}/${repository}/issues/${state.task.pullRequest}/comments`;
  return ghApi([endpoint, '-X', existing ? 'PATCH' : 'POST', '--input', '-'], { body: commentBody(state) });
}

function main() {
  const prIndex = process.argv.indexOf('--pr');
  if (prIndex < 0 || !process.argv[prIndex + 1]) throw new Error('Usage: publish-state.mjs --pr <number>');
  const state = run(['show', '--pr', process.argv[prIndex + 1]]);
  const [owner, repository] = state.task.repository.split('/');
  const status = publishCommitStatus(state, owner, repository);
  const comment = publishStickyComment(state, owner, repository);
  console.log(JSON.stringify({ statusId: status.id, commentId: comment.id, phase: state.coordination.status }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`publish-state: ${error.message}`);
  process.exitCode = 1;
}