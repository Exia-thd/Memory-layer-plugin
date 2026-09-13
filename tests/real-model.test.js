/**
 * The suite's blind spot: the embedder people actually run.
 *
 * Every other test sets MEMORY_LAYER_EMBEDDINGS=hash, because the hash embedder
 * needs no model and no network. That is a reasonable default for a test suite
 * and it left one whole half of the product unexercised -- and the half that
 * ships.
 *
 * What lived in that gap: loading the real model made the process crash on the
 * way out. Not during the work. `init` created the store, `search` printed its
 * results, and then the native runtime tore down and the process exited
 * 0xC0000409, which a POSIX shell reports as 127. Every command "failed" while
 * doing exactly what it was asked.
 *
 * That is not cosmetic, because the hooks read a non-zero exit as "the memory
 * layer did not answer" and then, by design, stay silent about it. So on every
 * machine where the model worked, every hook did nothing and said nothing --
 * the exact failure this project was built to refuse, sitting in the project
 * itself, invisible because the tests never loaded the thing that caused it.
 *
 * These tests need the real model. That is deliberate: the model is part of the
 * install now, so a suite that cannot get one is a suite on a machine where the
 * plugin would not work either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EMBEDDING_CONFIG } from '@memory-layer/core';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, cliRaw } from './helpers.js';

// The machine's own model cache, not one per fixture. Every fixture gets a fresh
// MEMORY_LAYER_HOME, and the cache defaults to living inside it -- so each test
// downloaded 130 MB into a directory it then deleted. An explicit cache setting
// is honoured over the default location; an existing one is reused.
const SHARED_CACHE = process.env.MEMORY_LAYER_MODEL_CACHE
  ?? path.join(os.homedir(), '.memory', 'models');

const REAL = { MEMORY_LAYER_EMBEDDINGS: '', MEMORY_LAYER_TEST: '', MEMORY_LAYER_MODEL_CACHE: SHARED_CACHE };

test('the default device is the one that does not crash on the way out', () => {
  // `auto` and `cpu` both end up running the same CPU session here; the
  // difference is that `auto` tries DirectML first, fails, and leaves the
  // native runtime unable to tear down. Measured, both ways, before this
  // changed -- see the note on DEFAULT_EMBEDDING_CONFIG.device.
  assert.equal(DEFAULT_EMBEDDING_CONFIG.device, 'cpu');
});

test('a command that succeeds with the real model exits zero', () => {
  const repo = makeRepo({
    'docs/billing.md': '# Billing\n\nRetry a declined card at most twice.\n',
  });
  try {
    const init = cliRaw(repo, ['init'], { env: REAL });
    assert.equal(
      init.status,
      0,
      `init exited ${init.status} having done the work. ` +
        `If this is a "could not load embedding model" failure, the machine cannot ` +
        `reach the model and the plugin would not work on it either.\n${init.stderr}`,
    );

    const search = cliRaw(repo, ['search', 'declined card retry', '--json'], { env: REAL });
    assert.equal(search.status, 0, `search exited ${search.status}\n${search.stderr}`);

    // The exit code alone could be right for the wrong reason -- a run that
    // never loaded the model would also exit zero. This says the real one ran.
    const result = JSON.parse(search.stdout);
    assert.ok(
      !result.fusion.degraded.includes('semantic'),
      `the semantic branch did not run: ${JSON.stringify(result.fusion)}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('the store records which model embedded it, not merely that something did', () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n\nSomething worth remembering.\n' });
  try {
    cliRaw(repo, ['init'], { env: REAL });
    const doctor = cliRaw(repo, ['doctor', '--json'], { env: REAL });
    assert.equal(doctor.status, 0, doctor.stderr);

    const report = JSON.parse(doctor.stdout);
    const embeddings = report.checks.find((check) => check.name === 'vectors');
    assert.ok(embeddings, JSON.stringify(report.checks.map((c) => c.name)));
    // A store embedded by the fallback must never be reported as one embedded
    // by the model: they are different vector spaces and the difference is only
    // visible here.
    assert.match(embeddings.detail, /local/, embeddings.detail);
    assert.ok(
      !/hashed-token-features/.test(embeddings.detail),
      `asked for the real model and got the fallback: ${embeddings.detail}`,
    );
  } finally {
    repo.cleanup();
  }
});
