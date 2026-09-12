/**
 * Every language, end to end, in one repository.
 *
 * The per-language tests elsewhere check that a rule extracts a name. This one
 * checks the thing that actually matters: after an ingest, the store holds an
 * edge from the caller to the declaration it names. Those are different claims,
 * and the gap between them is where a language quietly contributes nothing --
 * the rule reads `loadDart`, resolution finds no candidate, and the graph for
 * that language is empty while every unit test still passes.
 *
 * All thirty pairs live in one repository on purpose. A language that only
 * works when it is alone is not working: the runtime is shared, the resolver
 * sees every declaration at once, and a name that collides across languages is
 * exactly the case a real polyglot repository presents.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, relationLanguages } from '@memory-layer/core';
import { PAIRS } from './fixtures/polyglot-pairs.js';
import { makeRepo, cli } from './helpers.js';

test('every language resolves a call to the declaration in the other file', async () => {
  const files = {};
  for (const [calleeFile, calleeSource, callerFile, callerSource] of Object.values(PAIRS)) {
    files[`src/${calleeFile}`] = calleeSource;
    files[`src/${callerFile}`] = callerSource;
  }

  const repo = makeRepo(files);
  try {
    cli(repo, ['init', '--no-scan']);
    const report = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.ok(report.relations.calls >= Object.keys(PAIRS).length, JSON.stringify(report.relations));

    const store = new MemoryStore(`${repo.dir}/.memory`, { readOnly: true });
    try {
      const calls = await store.allCalls();
      const missing = [];
      const misdirected = [];
      for (const [label, [calleeFile, , callerFile, , expected]] of Object.entries(PAIRS)) {
        const edge = calls.find((call) => call.from.includes(`/${callerFile}:`) && call.name === expected);
        if (!edge) {
          missing.push(`${label}: no edge for ${expected}`);
          continue;
        }
        if (!edge.to.includes(`/${calleeFile}:`)) {
          misdirected.push(`${label}: ${expected} landed on ${edge.to}`);
        }
      }
      assert.deepEqual(missing, [], missing.join('\n'));
      // Worse than a missing edge: one that points at the wrong declaration.
      assert.deepEqual(misdirected, [], misdirected.join('\n'));
    } finally {
      await store.close();
    }
  } finally {
    repo.cleanup();
  }
});

test('the fixture covers every language that claims to read calls', () => {
  // Adding a language without adding it here would leave it unmeasured, which
  // is how a rule that extracts nothing survives: its unit test passes on a
  // sample and nothing ever asks whether an edge came out the other end.
  const claimed = relationLanguages().with;
  const covered = new Set(Object.keys(PAIRS));
  const unmeasured = claimed.filter((label) => !covered.has(label));
  assert.deepEqual(unmeasured, [], `languages with no end-to-end pair: ${unmeasured.join(', ')}`);
});
