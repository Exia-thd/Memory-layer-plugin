/**
 * Without the model, commands refuse. They do not degrade.
 *
 * The embedder used to return null when the model could not be had, and every
 * caller carried on: search ran with the semantic branch marked degraded, a
 * written memory was stored without a vector, ingest indexed a whole tree into
 * a store nothing could search by meaning. Each of those was reported somewhere
 * and none was an error, so a machine without the model looked like a machine
 * where search was merely not very good.
 *
 * Nothing here needs the network. The model is made absent by pointing the
 * cache at an empty directory, and the refusal has to happen before anything
 * tries to download -- a search that quietly spends a minute fetching 130 MB is
 * not a search, and on a machine with no network it is a hang.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

/** The environment of a machine where the plugin is built but the model never arrived. */
function noModel() {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'memnomodel-'));
  return {
    env: { MEMORY_LAYER_EMBEDDINGS: '', MEMORY_LAYER_TEST: '', MEMORY_LAYER_MODEL_CACHE: cache },
    cleanup: () => fs.rmSync(cache, { recursive: true, force: true }),
  };
}

function seeded() {
  const repo = makeRepo({ 'docs/billing.md': '# Billing\n\nRetry a declined card at most twice.\n' });
  cli(repo, ['init']);
  return repo;
}

function titles(repo, query) {
  return JSON.parse(cli(repo, ['search', query, '--json'])).results.map((hit) => hit.title);
}

test('search refuses without the model, quickly, and says what to run', () => {
  const repo = seeded();
  const machine = noModel();
  try {
    const started = Date.now();
    const result = cliRaw(repo, ['search', 'declined card'], { env: machine.env });
    const elapsed = Date.now() - started;

    assert.notEqual(result.status, 0, `search ran without the model:\n${result.stdout}`);
    assert.match(result.stderr, /not downloaded/, result.stderr);
    assert.match(result.stderr, /setup\.mjs/, result.stderr);
    // Refused before any attempt to fetch. A download would take far longer than
    // this, and would not be possible at all on the machines this protects.
    assert.ok(elapsed < 20_000, `took ${elapsed}ms -- it may have tried to download`);
  } finally {
    machine.cleanup();
    repo.cleanup();
  }
});

test('a memory is not written without a vector', () => {
  const repo = seeded();
  const machine = noModel();
  try {
    const title = 'Settlement runs nightly at two';
    const result = cliRaw(repo, [
      'write', '--layer', 'semantic', '--title', title,
      '--body', 'Chosen because the processor closes its batch at one.',
      '--source-ref', 'session:test',
    ], { env: machine.env });

    assert.notEqual(result.status, 0, 'the write succeeded with no model to embed it');
    assert.match(result.stderr, /not downloaded/, result.stderr);
    // And nothing half-landed: a node stored without its vector is exactly the
    // record that is found by wording and never by meaning.
    assert.ok(!titles(repo, 'settlement nightly').includes(title), 'the write left a node behind');
  } finally {
    machine.cleanup();
    repo.cleanup();
  }
});

test('ingest refuses without the model rather than indexing unsearchable nodes', () => {
  const repo = seeded();
  const machine = noModel();
  try {
    fs.writeFileSync(path.join(repo.dir, 'docs', 'refunds.md'), '# Refunds\n\nRefunds settle within five days.\n');
    const result = cliRaw(repo, ['ingest', 'docs'], { env: machine.env });

    assert.notEqual(result.status, 0, 'ingest ran with no model');
    assert.match(result.stderr, /not downloaded/, result.stderr);
    assert.ok(!titles(repo, 'refunds settle').some((t) => /refunds/i.test(t)), 'ingest indexed the file anyway');
  } finally {
    machine.cleanup();
    repo.cleanup();
  }
});

test('the lexical fallback cannot be selected outside the test suite', () => {
  const repo = seeded();
  try {
    const result = cliRaw(repo, ['search', 'declined card'], {
      env: { MEMORY_LAYER_EMBEDDINGS: 'hash', MEMORY_LAYER_TEST: '' },
    });
    assert.notEqual(result.status, 0, 'hash was honoured without MEMORY_LAYER_TEST');
    assert.match(result.stderr, /test suite only/, result.stderr);
  } finally {
    repo.cleanup();
  }
});

test('doctor still runs without the model, and fails on it', () => {
  // Doctor is what somebody runs on exactly this machine. It must not be one
  // more command that needs the model before it can say the model is missing.
  const repo = seeded();
  const machine = noModel();
  try {
    const result = cliRaw(repo, ['doctor', '--json'], { env: machine.env });
    const report = JSON.parse(result.stdout);
    const check = report.checks.find((c) => c.name === 'embedding model');
    assert.ok(check, JSON.stringify(report.checks.map((c) => c.name)));
    assert.equal(check.status, 'fail', check.detail);
    assert.match(check.detail, /setup\.mjs/, check.detail);
    assert.equal(report.failed, true);
  } finally {
    machine.cleanup();
    repo.cleanup();
  }
});
