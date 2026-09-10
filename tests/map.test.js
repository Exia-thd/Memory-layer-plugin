/**
 * Looking at the code graph.
 *
 * The graph existed but there was no way to see it, which is most of why people
 * ask whether it is there at all. A tree to read and a Mermaid diagram to look
 * at cover that without a web app, and a web app is the easiest way to mistake
 * motion for progress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli } from './helpers.js';

const SOURCE = [
  'export function chargeInvoice(invoice, attempt) {',
  '  return psp.capture(invoice.amount);',
  '}',
  '',
  'export class RefundQueue {',
  '  push(item) { this.items.push(item); }',
  '}',
].join('\n');

function seeded() {
  const repo = makeRepo({ 'src/charge.js': SOURCE, 'docs/note.md': '# Note\n\nGhi chú.\n' });
  cli(repo, ['init', '--no-scan']);
  cli(repo, ['ingest', 'src', 'docs']);
  return repo;
}

test('the map lists declarations with their file and lines', async () => {
  const repo = seeded();
  try {
    const map = JSON.parse(cli(repo, ['map', '--json']));
    assert.ok(map.symbols > 0, 'no declarations in the map');

    const file = map.files.find((entry) => entry.file === 'src/charge.js');
    assert.ok(file, `src/charge.js missing: ${JSON.stringify(map.files.map((f) => f.file))}`);

    const names = file.symbols.map((symbol) => symbol.name);
    assert.ok(names.includes('chargeInvoice'), `expected chargeInvoice in ${JSON.stringify(names)}`);

    for (const symbol of file.symbols) {
      assert.ok(symbol.startLine >= 1, 'a declaration has no start line');
      assert.ok(symbol.endLine >= symbol.startLine, 'a declaration has a backwards line range');
      assert.ok(symbol.kind.length > 0, 'a declaration has no kind');
    }
  } finally {
    repo.cleanup();
  }
});

test('a path narrows the map', async () => {
  const repo = seeded();
  try {
    const all = JSON.parse(cli(repo, ['map', '--json']));
    const narrowed = JSON.parse(cli(repo, ['map', 'src', '--json']));
    assert.ok(
      narrowed.files.every((entry) => entry.file.startsWith('src')),
      'the prefix did not narrow the map',
    );
    assert.ok(narrowed.symbols <= all.symbols);
  } finally {
    repo.cleanup();
  }
});

test('the mermaid output is a diagram, and survives awkward labels', async () => {
  const repo = makeRepo({
    // Brackets and quotes end a Mermaid label early, and a label that ends early
    // takes the whole diagram with it -- it renders as nothing, with no error.
    'src/odd.js': 'export function weird_name_with(bracket) {\n  return 1;\n}\n',
    'docs/note.md': '# A "quoted" [heading] (with) {braces}\n\nGhi chú.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src', 'docs']);

    const diagram = cli(repo, ['map', '--format', 'mermaid']);
    assert.match(diagram, /^graph LR/m, 'not a mermaid graph');
    assert.match(diagram, /-->/, 'no edges in the diagram');

    for (const line of diagram.split('\n').slice(1)) {
      if (!line.trim()) continue;
      const label = line.match(/\["([^"]*)"\]|\("([^"]*)"\)/);
      if (!label) continue;
      const text = label[1] ?? label[2];
      assert.ok(
        !/["[\]{}()]/.test(text),
        `a label kept a character that ends it early: ${JSON.stringify(text)}`,
      );
    }
  } finally {
    repo.cleanup();
  }
});

test('an empty store says so rather than printing an empty diagram', async () => {
  const repo = makeRepo({ 'docs/note.md': '# Note\n' });
  try {
    cli(repo, ['init', '--no-scan']);

    const tree = cli(repo, ['map']);
    assert.match(tree, /No declarations recorded/);

    const diagram = cli(repo, ['map', '--format', 'mermaid']);
    assert.match(diagram, /No declarations recorded/);
  } finally {
    repo.cleanup();
  }
});
