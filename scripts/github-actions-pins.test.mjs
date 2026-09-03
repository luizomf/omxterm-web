#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  validateWorkflow,
  validateWorkflowDirectory,
} from './github-actions-pins.mjs';

const PIN = '0123456789abcdef0123456789abcdef01234567';

const accepted = `
steps:
  - uses: actions/checkout@${PIN} # v4.4.0
  - uses: './.github/actions/local'
  - uses: docker://alpine:3.22
jobs:
  delegated:
    uses: organization/repository/.github/workflows/build.yml@${PIN} # v2.1.3
`;

assert.deepEqual(validateWorkflow(accepted), []);

const rejectedCases = [
  {
    source: '  - uses: actions/checkout@v4 # v4.4.0',
    message: /full 40-character commit SHA/u,
  },
  {
    source: '  - uses: actions/checkout@0123456 # v4.4.0',
    message: /full 40-character commit SHA/u,
  },
  {
    source: '  - uses: actions/checkout@main # v4.4.0',
    message: /full 40-character commit SHA/u,
  },
  {
    source: `  - uses: actions/checkout@${PIN}`,
    message: /adjacent release tag comment/u,
  },
  {
    source: `  - uses: actions/checkout@${PIN} # checkout release`,
    message: /adjacent release tag comment/u,
  },
  {
    source:
      '    uses: organization/repository/.github/workflows/build.yml@feature',
    message: /full 40-character commit SHA/u,
  },
  {
    source: '  - uses: ${{ matrix.action }}',
    message: /unable to parse uses reference/u,
  },
];

for (const testCase of rejectedCases) {
  const errors = validateWorkflow(testCase.source, 'fixture.yml');
  assert.equal(errors.length, 1, testCase.source);
  assert.match(errors[0] ?? '', testCase.message);
}

const repositoryRoot = new URL('..', import.meta.url);
const workflowDirectory = fileURLToPath(
  new URL('.github/workflows/', repositoryRoot),
);
assert.deepEqual(await validateWorkflowDirectory(workflowDirectory), []);
assert.equal(
  await readFile(new URL('.github/dependabot.yml', repositoryRoot), 'utf8'),
  `version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
`,
);

console.log(
  'github-actions-pins.test.mjs: external actions and reusable workflows require annotated full commit SHA pins; local actions remain exempt',
);
