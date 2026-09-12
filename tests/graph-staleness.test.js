/**
 * What happens to the graph when the code moves.
 *
 * Ingest re-reads the files that changed. Moving a declaration to another file
 * changes two files, but the file that *calls* it is not one of them -- and the
 * old declaration is deleted, taking every edge pointing at it. The caller was
 * then recorded as calling nothing, which is not a gap in the graph but a wrong
 * answer in it: the code plainly calls something, and `map` said it did not.
 *
 * The fix hands those call sites back to the resolver instead of dropping them,
 * so the second pass either finds the declaration in its new home or reports it
 * unresolved. These tests hold both outcomes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryStore } from '@memory-layer/core';
import { makeRepo, cli } from './helpers.js';

const CALLER = [
  'import { settle } from "./ledger.js";',
  '',
  'export function chargeInvoice(invoice) {',
  '  return settle(invoice.amount);',
  '}',
].join('\n');

const LEDGER = 'export function settle(amount) {\n  return amount;\n}\n';

function write(repo, relative, content) {
  const full = path.join(repo.dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function callsFrom(repo, callerFile) {
  const store = new MemoryStore(path.join(repo.dir, '.memory'), { readOnly: true });
  try {
    const calls = await store.allCalls();
    return calls.filter((call) => call.from.includes(`/${callerFile}:`));
  } finally {
    await store.close();
  }
}

test('a declaration that moves file keeps the edges pointing at it', async () => {
  const repo = makeRepo({ 'src/billing.js': CALLER, 'src/ledger.js': LEDGER });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    const before = await callsFrom(repo, 'billing.js');
    assert.ok(
      before.some((call) => call.name === 'settle'),
      `the call was never recorded: ${JSON.stringify(before)}`,
    );

    // settle moves to a new file. billing.js is untouched, so nothing re-reads
    // the call site -- which is the whole point of the case.
    fs.rmSync(path.join(repo.dir, 'src', 'ledger.js'));
    write(repo, 'src/accounts.js', LEDGER);
    cli(repo, ['ingest', 'src']);

    const after = await callsFrom(repo, 'billing.js');
    const edge = after.find((call) => call.name === 'settle');
    assert.ok(edge, `the call vanished after the move: ${JSON.stringify(after)}`);
    assert.match(edge.to, /accounts\.js/, `it still points at the old file: ${edge.to}`);
  } finally {
    repo.cleanup();
  }
});

test('a declaration that is deleted outright leaves the call unresolved, not unrecorded', async () => {
  const repo = makeRepo({ 'src/billing.js': CALLER, 'src/ledger.js': LEDGER });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);

    fs.rmSync(path.join(repo.dir, 'src', 'ledger.js'));
    cli(repo, ['ingest', 'src']);

    // No edge: there is nothing to point at, and inventing one would be worse.
    const after = await callsFrom(repo, 'billing.js');
    assert.ok(!after.some((call) => call.name === 'settle'), JSON.stringify(after));

    // But the call site is still on the books as a question, not forgotten.
    const store = new MemoryStore(path.join(repo.dir, '.memory'), { readOnly: true });
    try {
      const pending = await store.pendingCallsNamed(['settle']);
      assert.ok(
        pending.some((row) => row.filePath.endsWith('billing.js')),
        `the call to a deleted function was forgotten: ${JSON.stringify(pending)}`,
      );
    } finally {
      await store.close();
    }
  } finally {
    repo.cleanup();
  }
});
