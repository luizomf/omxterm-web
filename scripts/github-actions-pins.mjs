#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScalar, LineCounter, parseDocument, visit } from 'yaml';

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const RELEASE_TAG = /^[^\s#]+$/u;

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

function lineNumber(lineCounter, offset) {
  return lineCounter.linePos(offset).line;
}

function releaseTagAfter(source, endOffset) {
  const nextLine = source.indexOf('\n', endOffset);
  const lineEnd = nextLine === -1 ? source.length : nextLine;
  const trailingSource = source.slice(endOffset, lineEnd);
  const match = /^[\s,}\]]*#\s*([^\s#]+)\s*$/u.exec(trailingSource);
  return match?.[1];
}

export function validateWorkflow(source, fileName = '<workflow>') {
  const errors = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
  });

  for (const error of document.errors) {
    const offset = error.pos[0] ?? 0;
    errors.push(
      `${fileName}:${lineNumber(lineCounter, offset)}: invalid YAML: ${error.message}`,
    );
  }

  if (errors.length > 0) return errors;

  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'uses') return;

      const offset = pair.key.range?.[0] ?? 0;
      const line = lineNumber(lineCounter, offset);
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
        errors.push(`${fileName}:${line}: unable to parse uses reference`);
        return;
      }

      const reference = pair.value.value;
      if (reference.startsWith('./') || reference.startsWith('docker://')) return;

      const endOffset = pair.value.range?.[1] ?? offset;
      const releaseTag = releaseTagAfter(source, endOffset);
      const error = validateExternalReference(reference, releaseTag);
      if (error) errors.push(`${fileName}:${line}: ${error}`);
    },
  });

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
