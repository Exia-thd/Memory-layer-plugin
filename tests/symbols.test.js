/**
 * The smallest code graph that earns its place.
 *
 * The AST walk already visits every declaration in order to decide where to cut
 * a chunk. Recording the name it sees there costs one lookup and turns
 * `why <symbol>` from a text search into an anchored answer. Deliberately no
 * CALLS and no IMPORTS: cross-file resolution is a different project.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, declarations } from '@memory-layer/core';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

const SOURCE = [
  'export function chargeInvoice(invoice) {',
  '  // Retries twice; the third attempt was removed in 2024.',
  '  return psp.capture(invoice.amount);',
  '}',
  '',
  'export class RefundQueue {',
  '  push(item) { this.items.push(item); }',
  '}',
  '',
].join('\n');

test('declarations are found whether or not the file was cut', async () => {
  // Symbol capture used to ride on chunk boundaries, so a file small enough to
  // fit in one chunk -- most of a repository -- declared nothing at all.
  const whole = await chunk('src/charge.js', SOURCE);
  assert.deepEqual(whole.map((piece) => piece.mode), ['WHOLE'], 'expected an uncut file');

  const found = await declarations('src/charge.js', SOURCE);
  const names = found.map((item) => item.name);
  assert.ok(names.includes('chargeInvoice'), `expected chargeInvoice in ${JSON.stringify(names)}`);
  assert.ok(names.includes('RefundQueue'), `expected RefundQueue in ${JSON.stringify(names)}`);
  for (const item of found) {
    assert.ok(item.startLine >= 1 && item.endLine >= item.startLine, 'line range is not honest');
  }
});

test('an unnamed declaration produces no symbol rather than a guessed one', async () => {
  const found = await declarations('src/anon.js', ['export default function () {', '  return 1;', '}'].join('\n'));
  for (const item of found) {
    assert.ok(item.name.length > 0, 'a declaration was recorded with an empty name');
  }
});

test('a file the grammar cannot read declares nothing rather than throwing', async () => {
  const found = await declarations('src/notes.txt', 'this is not code at all');
  assert.deepEqual(found, []);
});

test('ingest records symbols and why anchors on a bare name', async () => {
  const repo = makeRepo({ 'src/charge.js': SOURCE });
  try {
    cli(repo, ['init', '--no-scan']);
    const report = JSON.parse(cli(repo, ['ingest', 'src/charge.js', '--json']));
    assert.ok(report.symbols > 0, `no symbols recorded: ${JSON.stringify(report)}`);

    const why = JSON.parse(cli(repo, ['why', 'chargeInvoice', '--json']));
    // The anchor branch is what changed: it used to report that a bare symbol
    // could not be anchored at all.
    assert.ok(why.fusion.branches.anchor > 0, `nothing anchored: ${JSON.stringify(why.fusion)}`);
    assert.ok(!why.fusion.degraded.includes('anchor'), 'anchor reported itself degraded');
    assert.ok(why.results.length > 0, 'no results');
  } finally {
    repo.cleanup();
  }
});

test('a name nothing declares still reports the anchor branch as empty', async () => {
  const repo = makeRepo({ 'src/charge.js': SOURCE });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src/charge.js']);

    const why = JSON.parse(cli(repo, ['why', 'noSuchSymbol', '--json']));
    assert.equal(why.fusion.branches.anchor, 0);
    assert.ok(why.fusion.degraded.includes('anchor'), 'an empty branch went unreported');
    assert.match(why.fusion.reasons.anchor, /No declaration named noSuchSymbol/);
  } finally {
    repo.cleanup();
  }
});

test('re-ingesting the same file does not duplicate symbols', async () => {
  const repo = makeRepo({ 'src/charge.js': SOURCE });
  try {
    cli(repo, ['init', '--no-scan']);
    const first = JSON.parse(cli(repo, ['ingest', 'src/charge.js', '--json']));
    const second = JSON.parse(cli(repo, ['ingest', 'src/charge.js', '--force', '--json']));
    assert.equal(second.symbols, first.symbols, 'a forced re-ingest changed the symbol count');

    const why = JSON.parse(cli(repo, ['why', 'chargeInvoice', '--json']));
    const ids = why.results.map((hit) => hit.id);
    assert.equal(new Set(ids).size, ids.length, 'the same memory came back twice');
  } finally {
    repo.cleanup();
  }
});

test('a file read by an older code reader is read again, not skipped as unchanged', () => {
  // Unchanged content used to mean skip. A C# repository ingested before C#
  // had a code graph kept its empty graph forever: every file was unchanged.
  const source = [
    'namespace Billing.Api',
    '{',
    '    public class OrderService',
    '    {',
    '        public Order Get(int id) { return null; }',
    '    }',
    '}',
    '',
  ].join('\n');
  const repo = makeRepo({ 'src/OrderService.cs': source });
  try {
    cli(repo, ['init', '--no-scan']);
    const first = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.ok(first.symbols >= 2, `C# declared nothing: ${JSON.stringify(first)}`);
    const again = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.equal(again.files, 0, 'unchanged content was read again by the same reader');

    // Every store written before the reader was versioned holds the bare hash.
    const metaFile = path.join(repo.dir, '.memory', 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    for (const key of Object.keys(meta.fileHashes)) meta.fileHashes[key] = meta.fileHashes[key].replace(/^\d+:/, '');
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    const before = cliRaw(repo, ['doctor']).stdout;
    assert.match(before, /code reader\s+WARN.*older version/, `doctor did not report the stale reader:\n${before}`);

    const upgraded = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.equal(upgraded.files, 1, 'a file read by an older reader was skipped as unchanged');

    const after = cliRaw(repo, ['doctor']).stdout;
    assert.match(after, /code reader\s+ok/, `the stale reader was still reported:\n${after}`);
  } finally {
    repo.cleanup();
  }
});
