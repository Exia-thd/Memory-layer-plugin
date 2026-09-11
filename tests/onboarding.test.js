/**
 * Installing into a codebase that already exists.
 *
 * That is the case this layer is for, and it used to take three commands to
 * reach a usable state: init, then ingest with paths you had to guess, then ui.
 * Anything left to a second step is a step somebody does not take.
 *
 * And the store has to survive being kept up to date. Chunk ids come from
 * content, so editing a file yields new ids -- one file edited four times became
 * four nodes, every one of them still indexed and answering the same query.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_DIR_NAME } from '@memory-layer/core';
import { makeRepo, cli } from './helpers.js';

const CHARGE = [
  'export function chargeInvoice(invoice) {',
  '  return psp.capture(invoice.amount);',
  '}',
].join('\n');

function brownfield(extra = {}) {
  return makeRepo(Object.assign({
    'README.md': '# Du an\n\nHe thong thanh toan.\n',
    'docs/architecture.md': '# Kien truc\n\n## Thanh toan\n\nQuyet dinh: thu lai hai lan.\n',
    'src/billing/charge.js': CHARGE,
    // Vendored code must not be swept in. A first run that fills the store with
    // dependencies is worse than one that finds nothing.
    'node_modules/left-pad/index.js': 'module.exports = function leftPad() {};\n',
    'dist/bundle.js': 'export function builtOutput() {}\n',
  }, extra));
}

test('init scans the project and leaves it usable in one command', async () => {
  const repo = brownfield();
  try {
    const out = cli(repo, ['init']);

    assert.match(out, /scanning the whole repository/, 'init did not report what it was going to scan');
    assert.match(out, /\d+ memories, \d+ declarations from \d+ files/, 'init did not scan');

    // The code graph is there without a second command.
    const map = JSON.parse(cli(repo, ['map', '--json']));
    assert.ok(map.symbols > 0, 'no declarations after init');
    assert.ok(
      map.files.some((file) => file.file.includes('charge.js')),
      `charge.js missing: ${JSON.stringify(map.files.map((f) => f.file))}`,
    );

    // And so is the page.
    const page = path.join(repo.dir, PLUGIN_DIR_NAME, 'ui.html');
    assert.ok(fs.existsSync(page), 'init did not write the viewer');
    assert.match(out, /open .*ui\.html/, 'init did not say where the page is');
  } finally {
    repo.cleanup();
  }
});

test('init does not sweep in vendored code or build output', async () => {
  const repo = brownfield();
  try {
    cli(repo, ['init']);
    const map = JSON.parse(cli(repo, ['map', '--json']));
    const files = map.files.map((file) => file.file);

    for (const unwanted of ['node_modules', 'dist']) {
      assert.ok(
        !files.some((file) => file.includes(unwanted)),
        `${unwanted} was scanned: ${JSON.stringify(files)}`,
      );
    }
  } finally {
    repo.cleanup();
  }
});

test('init with explicit paths scans only those', async () => {
  const repo = brownfield();
  try {
    const out = cli(repo, ['init', 'docs']);
    assert.match(out, /scanning docs/);

    const map = JSON.parse(cli(repo, ['map', '--json']));
    assert.equal(map.symbols, 0, 'src was scanned despite an explicit path');
  } finally {
    repo.cleanup();
  }
});

test('--no-scan leaves the store empty, as asked', async () => {
  const repo = brownfield();
  try {
    const out = cli(repo, ['init', '--no-scan']);
    assert.ok(!/scanning/.test(out), 'it scanned anyway');

    const map = JSON.parse(cli(repo, ['map', '--json']));
    assert.equal(map.symbols, 0);
  } finally {
    repo.cleanup();
  }
});

test('re-ingesting an edited file replaces it rather than piling up copies', async () => {
  const repo = brownfield();
  try {
    cli(repo, ['init', '--no-scan']);

    const doc = path.join(repo.dir, 'docs/architecture.md');
    const counts = [];
    for (const version of ['hai', 'ba', 'bon', 'nam']) {
      fs.writeFileSync(doc, `# Kien truc\n\n## Thanh toan\n\nQuyet dinh: thu lai ${version} lan.\n`);
      cli(repo, ['ingest', 'docs', '--no-ui']);
      const health = JSON.parse(cli(repo, ['doctor', '--json']));
      counts.push(Number(/^(\d+) nodes/.exec(health.checks[0].detail)[1]));
    }

    assert.deepEqual(
      counts, [counts[0], counts[0], counts[0], counts[0]],
      `editing one file four times changed the node count: ${JSON.stringify(counts)}`,
    );

    // The current text is what answers; the old versions do not.
    const now = JSON.parse(cli(repo, ['search', 'nam', '--json']));
    assert.ok(now.results.length > 0, 'the current version is not searchable');

    const before = JSON.parse(cli(repo, ['search', 'hai', '--json']));
    assert.equal(before.results.length, 0, 'a replaced version still answers queries');
  } finally {
    repo.cleanup();
  }
});

test('a replaced chunk something points at is retired, not deleted', async () => {
  const repo = brownfield();
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs', '--no-ui']);

    const chunk = JSON.parse(cli(repo, ['search', 'thu lai', '--json'])).results[0];
    assert.ok(chunk, 'nothing to link to');

    const decision = JSON.parse(cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Retry twice',
      '--body', 'Chosen over backoff.', '--source-ref', 'docs/architecture.md#L1-L5', '--json',
    ])).id;
    cli(repo, ['link', decision, chunk.id, 'DERIVED_FROM', '--json']);

    // Rewrite the file so the chunk it derived from is no longer produced.
    fs.writeFileSync(
      path.join(repo.dir, 'docs/architecture.md'),
      '# Kien truc\n\n## Thanh toan\n\nQuyet dinh: doi hoan toan.\n',
    );
    cli(repo, ['ingest', 'docs', '--no-ui']);

    // The edge still resolves: a decision whose provenance leads nowhere is
    // worse than a stale chunk.
    const graph = JSON.parse(cli(repo, ['graph', decision, '--json']));
    assert.ok(
      graph.edges.some((edge) => edge.to === chunk.id),
      'the link was broken by re-ingesting',
    );
  } finally {
    repo.cleanup();
  }
});
