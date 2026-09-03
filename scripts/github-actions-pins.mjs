#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const RELEASE_TAG = /^[^\s#]+$/u;
const USES_KEY = /^\s*(?:-\s*)?uses\s*:/u;
const USES_SCALAR =
  /^\s*(?:-\s*)?uses\s*:\s*(?:(['"])([^'"]+)\1|([^#\s]+))\s*(?:#\s*(.*?)\s*)?$/u;

function validateExternalReference(reference, releaseTag) {
  const separator = reference.lastIndexOf('@');
  const action = reference.slice(0, separator);
  const revision = reference.slice(separator + 1);

  if (separator <= 0 || action.split('/').length < 2 || !revision) {
    return `external uses reference must have the form owner/repository[/path]@<40-character commit SHA>: ${reference}`;
  }
  if (!FULL_COMMIT_SHA.test(revision)) {
    return `external uses reference must be pinned to a full 40-character commit SHA: ${reference}`;
  }
  if (!releaseTag || !RELEASE_TAG.test(releaseTag)) {
    return `external uses reference must have an adjacent release tag comment: ${reference}`;
  }

  return undefined;
}

export function validateWorkflow(source, fileName = '<workflow>') {
  const errors = [];

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!USES_KEY.test(line)) continue;

    const match = USES_SCALAR.exec(line);
    if (!match) {
      errors.push(`${fileName}:${index + 1}: unable to parse uses reference`);
      continue;
    }

    const reference = match[2] ?? match[3];
    if (reference.startsWith('./') || reference.startsWith('docker://')) {
      continue;
    }

    const error = validateExternalReference(reference, match[4]);
    if (error) errors.push(`${fileName}:${index + 1}: ${error}`);
  }

  return errors;
}

async function workflowFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workflowFiles(entryPath)));
    } else if (/\.ya?ml$/iu.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export async function validateWorkflowDirectory(directory) {
  const errors = [];

  for (const fileName of await workflowFiles(directory)) {
    const source = await readFile(fileName, 'utf8');
    errors.push(...validateWorkflow(source, path.relative(directory, fileName)));
  }

  return errors;
}

async function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const workflowDirectory = path.join(repositoryRoot, '.github', 'workflows');
  const errors = await validateWorkflowDirectory(workflowDirectory);

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
    return;
  }

  console.log('GitHub Actions external references are pinned to annotated commit SHAs');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
