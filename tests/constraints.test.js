import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw, REPO_ROOT } from './helpers.js';

/**
 * One test per design constraint.
 *
 * Each of these guards a failure that has actually been observed in a memory
 * layer, not a hypothetical one. If a constraint has no test, it drifts.
 */

const DOC = `# Billing service

## Retry policy

We retry a declined card exactly twice, with a three second gap. Three or more
retries tripped the processor fraud heuristic and flagged the merchant account.
`;

test('C1: what is ingested is searchable, with no step in between', async () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    // No import, no migrate, no rebuild: straight from ingest to search.
    const output = cli(repo, ['search', 'declined card retry', '--json']);
    const { results } = JSON.parse(output);
    assert.ok(results.length > 0, 'ingested content was not searchable');
    assert.match(results[0].sourceRef, /docs\/billing\.md#L\d+-L\d+/);
  } finally {
    repo.cleanup();
  }
});

test('C2: no capability is implemented twice', () => {
  // Two modules exporting the same operation is how a fix lands in one of them
  // and the other keeps being called.
  const exported = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/^export (?:async )?function (\w+)/gm)) {
          const name = match[1];
          if (name.startsWith('format') || name.startsWith('parse')) continue;
          const seen = exported.get(name);
          if (seen) exported.set(name, [...seen, full]);
          else exported.set(name, [full]);
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, 'packages'));

  const duplicated = [...exported.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(duplicated, [], `these names are exported from more than one module: ${JSON.stringify(duplicated)}`);
});

test('C3: a broken store exits non-zero and says why', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    // Searching with no store at all must fail loudly, not return an empty list
    // that reads like "nothing has been recorded".
    const result = cliRaw(repo, ['search', 'anything']);
    assert.notEqual(result.status, 0, 'a missing store exited zero');
    assert.match(result.stderr, /memory init/);

    cli(repo, ['init']);
    fs.writeFileSync(path.join(repo.dir, '.memory', 'meta.json'), '{ this is not json');
    const corrupted = cliRaw(repo, ['doctor']);
    assert.notEqual(corrupted.status, 0, 'a corrupt store exited zero');
    assert.ok(corrupted.stderr.trim().length > 0, 'failed with no explanation');
  } finally {
    repo.cleanup();
  }
});

test('C4: a branch that contributes nothing is named in the result', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    const healthy = JSON.parse(cli(repo, ['search', 'declined card retry', '--json']));
    assert.ok(!healthy.fusion.degraded.includes('bm25'), 'bm25 should have contributed');

    // With the keyword branch switched off, fusion silently becomes semantic-only
    // unless it says otherwise. Saying otherwise is the whole point.
    const degraded = JSON.parse(cli(repo, ['search', 'declined card retry', '--no-bm25', '--json']));
    assert.ok(degraded.fusion.degraded.includes('bm25'), 'a dead branch was not reported');
    assert.ok(degraded.fusion.reasons.bm25, 'a degraded branch was reported with no reason');
    assert.equal(degraded.fusion.branches.bm25, 0);
  } finally {
    repo.cleanup();
  }
});

test('C5: queries are matched by term, not as one substring', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);
    cli(repo, ['ingest', 'docs']);

    // These words never appear in this order or adjacency in the document. A
    // substring match returns nothing; a term match finds it.
    const { results } = JSON.parse(cli(repo, ['search', 'retry declined card', '--json']));
    assert.ok(results.length > 0, 'reordered query terms found nothing');

    const reworded = JSON.parse(cli(repo, ['search', 'retries of declined cards', '--json']));
    assert.ok(reworded.results.length > 0, 'a reworded query found nothing');
  } finally {
    repo.cleanup();
  }
});

test('C6: depth actually changes the traversal', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);

    const error = write(repo, 'episodic', 'Merchant account flagged', 'Three retries tripped the fraud heuristic.', 'session:1');
    const decision = write(repo, 'semantic', 'Cap retries at two', 'Chosen over backoff because attempts are counted, not elapsed time.', 'docs/billing.md#L3-L8');
    const adr = write(repo, 'semantic', 'Processor selection', 'The processor was chosen for its settlement window.', 'docs/adr/1.md#L1-L5');

    cli(repo, ['link', decision, error, 'RESOLVES']);
    cli(repo, ['link', adr, decision, 'CONSTRAINS']);

    const shallow = JSON.parse(cli(repo, ['graph', error, '--depth', '1', '--json']));
    const deep = JSON.parse(cli(repo, ['graph', error, '--depth', '2', '--json']));

    assert.equal(shallow.neighbors.length, 1, 'depth 1 should reach only the decision');
    assert.ok(deep.neighbors.length > shallow.neighbors.length, 'depth was parsed and then ignored');
  } finally {
    repo.cleanup();
  }
});

test('C6b: traversal is bidirectional, so an error reaches the decision that fixed it', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);
    const error = write(repo, 'episodic', 'Merchant account flagged', 'Three retries tripped the fraud heuristic.', 'session:1');
    const decision = write(repo, 'semantic', 'Cap retries at two', 'Chosen over backoff.', 'docs/billing.md#L3-L8');

    // The edge points decision -> error. Asking from the error must still find it.
    cli(repo, ['link', decision, error, 'RESOLVES']);

    const fromError = JSON.parse(cli(repo, ['graph', error, '--depth', '1', '--json']));
    assert.equal(fromError.neighbors.length, 1);
    assert.equal(fromError.neighbors[0].node.id, decision);
    assert.equal(fromError.neighbors[0].via[0].direction, 'in');
  } finally {
    repo.cleanup();
  }
});

test('C7: everything writable is readable back through a path that is exercised', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);

    const a = write(repo, 'semantic', 'Cap retries at two', 'Chosen over exponential backoff.', 'docs/billing.md#L3-L8');
    const b = write(repo, 'episodic', 'Merchant account flagged', 'Three retries tripped the heuristic.', 'session:1');
    cli(repo, ['link', a, b, 'RESOLVES']);

    // memory_write -> memory_get / memory_search
    const got = JSON.parse(cli(repo, ['get', a, '--json']));
    assert.equal(got.node.id, a);

    // memory_link -> memory_neighbors
    const graph = JSON.parse(cli(repo, ['graph', a, '--json']));
    assert.equal(graph.neighbors.length, 1);

    // Every declared edge type reachable through conflicts / clusters as well.
    cli(repo, ['link', a, b, 'CONTRADICTS']);
    const conflicts = JSON.parse(cli(repo, ['conflicts', '--json']));
    assert.ok(conflicts.some((c) => c.kind === 'declared'), 'a declared contradiction was not readable');
  } finally {
    repo.cleanup();
  }
});

test('C8: every import is a declared dependency', () => {
  // A module imported but never declared works on the author's machine and
  // nowhere else, taking a whole retrieval branch down with it.
  const declared = new Set();
  for (const pkg of ['core', 'cli']) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
    );
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[key] ?? {})) declared.add(name);
    }
  }

  const missing = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const source = fs.readFileSync(full, 'utf8');
      const specifiers = [
        ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
        ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        // Prose containing the word "from" ahead of a quote is not an import.
        if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/.+)?$/.test(specifier)) continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!declared.has(name)) missing.add(`${name} (in ${path.relative(REPO_ROOT, full)})`);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'packages'));

  assert.deepEqual([...missing], [], 'imported but not declared in any manifest');
});

test('C9: the README does not claim GraphRAG without cluster summarisation', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const claimsGraphRag = /\bGraphRAG\b/i.test(readme);
  if (!claimsGraphRag) return;

  // Claiming the name is only allowed once the summarisation stage exists.
  const summariser = fs.existsSync(path.join(REPO_ROOT, 'packages', 'core', 'src', 'graph', 'summarize.ts'));
  assert.ok(
    summariser,
    'README says GraphRAG but there is no cluster summarisation step; community detection alone is not GraphRAG',
  );
});

test('C10: a reader never serves a snapshot from before the last write', () => {
  const repo = makeRepo({ 'docs/billing.md': DOC });
  try {
    cli(repo, ['init']);
    write(repo, 'semantic', 'First decision', 'Recorded before the reader opened.', 'docs/a.md#L1-L2');

    const before = JSON.parse(cli(repo, ['search', 'decision recorded', '--json']));
    write(repo, 'semantic', 'Second decision', 'Recorded after the reader opened.', 'docs/b.md#L1-L2');
    const after = JSON.parse(cli(repo, ['search', 'decision recorded', '--json']));

    // A read-only LadybugDB handle is frozen at its open point and reports no
    // error when it goes out of date, so the store tracks a write counter and
    // reopens. Without that, this second search silently misses the new node.
    assert.ok(
      after.results.length > before.results.length,
      'a write committed after the reader opened was invisible to it',
    );
  } finally {
    repo.cleanup();
  }
});

function write(repo, layer, title, body, sourceRef) {
  return cli(repo, [
    'write', '--layer', layer, '--title', title, '--body', body, '--source-ref', sourceRef,
  ]).trim().split('\n')[0];
}
