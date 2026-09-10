/**
 * The viewer.
 *
 * A generated page is easy to get wrong in a way nothing notices: it opens, it
 * is blank, and blank reads as "the graph is empty" rather than "the script did
 * not load". So these check the data is really in the file, and that the failure
 * path says which of the two happened.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli } from './helpers.js';

function built(repo, args = []) {
  const out = path.join(repo.dir, 'view.html');
  cli(repo, ['ui', ...args, '--out', out]);
  return { out, html: fs.readFileSync(out, 'utf8') };
}

function payloadOf(html) {
  const match = html.match(/window\.__MEMORY__ = (.*?);<\/script>/s);
  assert.ok(match, 'the page carries no embedded data');
  return JSON.parse(match[1].replace(/\u003c/g, '<'));
}

function seeded() {
  const repo = makeRepo({
    'src/charge.js': 'export function chargeInvoice(invoice) {\n  return psp.capture(invoice.amount);\n}\n',
    'docs/adr.md': '# Thanh toan\n\n## Retry\n\nQuyet dinh: thu lai hai lan.\n',
  });
  cli(repo, ['init']);
  cli(repo, ['ingest', 'src', 'docs']);
  return repo;
}

test('the page carries its data rather than fetching it', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    const payload = payloadOf(html);

    assert.ok(payload.graph.nodes.length > 0, 'no nodes in the graph');
    assert.ok(payload.memories.length > 0, 'no memories listed');
    assert.ok(payload.health.length > 0, 'no health report');

    // Every link must point at a node that is present, or the graph draws edges
    // into nothing and the layout collapses.
    const present = new Set(payload.graph.nodes.map((node) => node.id));
    for (const link of payload.graph.links) {
      assert.ok(present.has(link.source), `link from a missing node: ${link.source}`);
      assert.ok(present.has(link.target), `link to a missing node: ${link.target}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the graph carries files, declarations and memories', async () => {
  const repo = seeded();
  try {
    const payload = payloadOf(built(repo).html);
    const groups = new Set(payload.graph.nodes.map((node) => node.group));
    assert.ok(groups.has('file'), 'no file nodes');
    assert.ok(groups.has('symbol'), 'no declaration nodes');

    const kinds = new Set(payload.graph.links.map((link) => link.kind));
    assert.ok(kinds.has('DECLARES'), 'files are not linked to what they declare');
    assert.ok(kinds.has('ABOUT'), 'memories are not linked to declarations');
  } finally {
    repo.cleanup();
  }
});

test('a missing script says so instead of showing an empty graph', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    // The failure path has to exist in the file, not in a comment about it.
    assert.match(html, /__GRAPH_FAILED__/, 'no load-failure detection');
    assert.match(html, /could not load/i, 'no message for a failed load');
    assert.match(html, /mermaid/, 'the fallback does not point anywhere useful');
    // Pinned, so the diagram cannot change shape on its own later.
    assert.match(html, /3d-force-graph@\d+\.\d+\.\d+/, 'the library version is not pinned');
  } finally {
    repo.cleanup();
  }
});

test('a path narrows what the page shows', async () => {
  const repo = seeded();
  try {
    const all = payloadOf(built(repo).html);
    const narrowed = payloadOf(built(repo, ['src']).html);
    assert.ok(
      narrowed.graph.nodes.length <= all.graph.nodes.length,
      'the prefix did not narrow anything',
    );
    for (const memory of narrowed.memories) {
      assert.match(memory.sourceRef, /^src/, `${memory.sourceRef} is outside the prefix`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the page states that it is read-only and a snapshot', async () => {
  const repo = seeded();
  try {
    const { html } = built(repo);
    assert.match(html, /read-only/i, 'the page does not say it cannot write');
    assert.match(html, /snapshot/i, 'the page does not say it is a snapshot');
  } finally {
    repo.cleanup();
  }
});
