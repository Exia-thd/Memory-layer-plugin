/**
 * The graph, actually retrieving.
 *
 * `search.ts` traversed zero edges. Every link recorded between decisions --
 * SUPERSEDES, CONTRADICTS, DERIVED_FROM -- affected `memory conflicts` and
 * `memory graph` and nothing else, so the edges had no bearing on what a search
 * returned. Calling that GraphRAG promised something that was not happening.
 *
 * These cover the branch that closes it, and the three things around it: a
 * cheap index tier to pick from, pages that can actually be turned, and a
 * project's own say over what gets read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli, cliRaw } from './helpers.js';

/** Writes a memory and returns its id. */
function write(repo, title, body, ref = 'docs/adr.md#L1-L4') {
  return cli(repo, [
    'write', '--layer', 'semantic', '--title', title, '--body', body, '--source-ref', ref,
  ]).trim().split('\n')[0];
}

test('a linked neighbour is retrieved even when its wording does not match', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);

    // The hit and the neighbour share no vocabulary at all. Only the edge
    // connects them, so if the neighbour comes back, it came back through the
    // graph and nothing else.
    const hit = write(repo, 'Retry twice on quebecpayment', 'The quebecpayment gateway counts attempts.');
    const neighbour = write(repo, 'Ledger holds sierrafunds twice', 'Backoff would hold sierrafunds twice.');
    cli(repo, ['link', hit, neighbour, 'DERIVED_FROM']);

    const found = JSON.parse(cli(repo, ['search', 'quebecpayment', '--limit', '5', '--json']));
    const titles = found.results.map((r) => r.title);
    assert.ok(
      titles.some((t) => t.includes('sierrafunds')),
      `the linked neighbour was not retrieved: ${JSON.stringify(titles)}`,
    );
    assert.ok(found.fusion.branches.graph >= 1, `graph branch contributed nothing: ${JSON.stringify(found.fusion)}`);
  } finally {
    repo.cleanup();
  }
});

test('a superseding decision surfaces when the superseded one matches', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);

    // The direction that matters most. Matching the old decision and not being
    // shown the one that replaced it is the case where a stale answer does the
    // most damage, so the walk ignores direction on purpose.
    const old = write(repo, 'Use tangoqueue for retries', 'tangoqueue holds the retry state.');
    const replacement = write(repo, 'Moved to uniformstream', 'uniformstream replaces the queue.');
    cli(repo, ['link', replacement, old, 'SUPERSEDES']);

    const found = JSON.parse(cli(repo, ['search', 'tangoqueue', '--limit', '5', '--json']));
    const titles = found.results.map((r) => r.title);
    assert.ok(
      titles.some((t) => t.includes('uniformstream')),
      `the replacement was not surfaced: ${JSON.stringify(titles)}`,
    );
  } finally {
    repo.cleanup();
  }
});

test('the graph branch says why it contributed nothing, rather than looking empty', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    write(repo, 'A lone decision about victorcache', 'Nothing links to this one.');

    const found = JSON.parse(cli(repo, ['search', 'victorcache', '--limit', '5', '--json']));
    // Ran and found nothing is not the same as could not run, and a store where
    // nobody has linked anything is a normal state rather than a fault.
    assert.equal(found.fusion.branches.graph, 0);
    assert.ok(
      found.fusion.degraded.includes('graph'),
      `no reason recorded: ${JSON.stringify(found.fusion)}`,
    );
    assert.match(found.fusion.reasons.graph, /link/i, found.fusion.reasons.graph);
  } finally {
    repo.cleanup();
  }
});

test('doctor declares the graph branch, separately from the database engine', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const report = cli(repo, ['doctor']);
    // Two different things. One name for both would hide a failure in either
    // behind a healthy line about the other.
    assert.match(report, /graph\s+ok\s+ladybugdb/, report);
    assert.match(report, /graphWalk\s+ok\s+one-hop-neighbours/, report);
  } finally {
    repo.cleanup();
  }
});

test('the index tier returns the same ranking without the snippets', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    for (let i = 0; i < 5; i++) {
      write(repo, `Decision ${i} about whiskeybilling`, `Body ${i} `.repeat(40));
    }

    const search = JSON.parse(cli(repo, ['search', 'whiskeybilling', '--limit', '5', '--json']));
    const index = JSON.parse(cli(repo, ['index', 'whiskeybilling', '--limit', '5', '--json']));

    assert.deepEqual(
      index.results.map((r) => r.id),
      search.results.map((r) => r.id),
      'the index tier reordered the results',
    );
    // The whole point is the cost. A snippet is most of a hit.
    const size = (o) => JSON.stringify(o).length;
    assert.ok(
      size(index.results) * 2 < size(search.results),
      `index is not materially cheaper: ${size(index.results)} vs ${size(search.results)}`,
    );
    assert.ok(index.results.every((r) => r.title && r.sourceRef), 'an index entry lost its anchor');
  } finally {
    repo.cleanup();
  }
});

test('offset turns a page rather than reshuffling', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    for (let i = 0; i < 8; i++) write(repo, `Decision ${i} about xraybilling`, `xraybilling note ${i}.`);

    const all = JSON.parse(cli(repo, ['index', 'xraybilling', '--limit', '8', '--json']));
    const first = JSON.parse(cli(repo, ['index', 'xraybilling', '--limit', '3', '--json']));
    const second = JSON.parse(cli(repo, ['index', 'xraybilling', '--limit', '3', '--offset', '3', '--json']));

    assert.deepEqual(first.results.map((r) => r.id), all.results.slice(0, 3).map((r) => r.id));
    assert.deepEqual(second.results.map((r) => r.id), all.results.slice(3, 6).map((r) => r.id));
    assert.equal(second.offset, 3);
    // "6 more not shown" with no way to see them was half a message.
    assert.ok(second.omitted >= 1, `no tail reported: ${JSON.stringify(second)}`);
  } finally {
    repo.cleanup();
  }
});

test('the omitted count accounts for the page already turned', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    for (let i = 0; i < 6; i++) write(repo, `Decision ${i} about yankeebilling`, `yankeebilling ${i}.`);

    const page = JSON.parse(cli(repo, ['index', 'yankeebilling', '--limit', '2', '--offset', '2', '--json']));
    // Counting from zero here would report the first page as still unseen and
    // send a reader round in circles.
    assert.equal(page.omitted, page.total - 4, JSON.stringify(page));
  } finally {
    repo.cleanup();
  }
});

test('.memignore keeps a project out of its own store', async () => {
  const repo = makeRepo({
    'docs/keep.md': '# Keep\n\nalphakeep.\n',
    'docs/exports/big.md': '# Export\n\nbravodrop.\n',
    'docs/scratch.md': '# Scratch\n\ncharliedrop.\n',
    'src/real.js': 'export function deltakeep() {}\n',
    'src/generated/client.js': 'export function echodrop() {}\n',
    '.memignore': [
      '# exports are regenerated, and nobody decides anything in them',
      'exports/',
      'scratch.md',
      'src/generated/',
      '',
    ].join('\n'),
  });
  try {
    cli(repo, ['init', '--no-scan']);
    const out = cli(repo, ['ingest', 'docs', 'src']);

    for (const dropped of ['bravodrop', 'charliedrop', 'echodrop']) {
      assert.doesNotMatch(cli(repo, ['search', dropped]), /#L/, `${dropped} was indexed`);
    }
    for (const kept of ['alphakeep', 'deltakeep']) {
      assert.match(cli(repo, ['search', kept]), /#L/, `${kept} was dropped`);
    }

    // A rule the user wrote is still a skip, and skips are never silent.
    assert.match(out, /\.memignore/, `no reason reported: ${out}`);
  } finally {
    repo.cleanup();
  }
});

test('.memignore does not overrule a path named outright', async () => {
  const repo = makeRepo({
    'docs/note.md': '# N\n\nplaceholder.\n',
    'docs/exports/one.md': '# E\n\nfoxtrotexport.\n',
    '.memignore': 'exports/\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);
    assert.doesNotMatch(cli(repo, ['search', 'foxtrotexport']), /#L/, 'the rule did not apply');

    // A standing rule written earlier loses to an instruction given now.
    cli(repo, ['ingest', 'docs/exports']);
    assert.match(cli(repo, ['search', 'foxtrotexport']), /one\.md/, 'naming it did not overrule');
  } finally {
    repo.cleanup();
  }
});

test('a negation undoes a broader rule, in the order written', async () => {
  const repo = makeRepo({
    'docs/a.bak': 'golfdrop\n',
    'docs/keep.bak': 'hotelkeep\n',
    '.memignore': '*.bak\n!keep.bak\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);
    assert.doesNotMatch(cli(repo, ['search', 'golfdrop']), /#L/, 'the broad rule did not apply');
    assert.match(cli(repo, ['search', 'hotelkeep']), /keep\.bak/, 'the negation was ignored');
  } finally {
    repo.cleanup();
  }
});

test('every markdown at the root is scanned, CLAUDE.md included', async () => {
  const repo = makeRepo({
    'README.md': '# R\n\nindiaroot.\n',
    // The file holding this project's own constraints was outside the scan
    // because the list named five files and this was not one of them. Any list
    // of filenames has that failure waiting in it.
    'CLAUDE.md': '# Claude\n\njuliettclaude.\n',
    'AGENTS.md': '# Agents\n\nkiloagents.\n',
    'NOTES-FOR-ME.md': '# Notes\n\nlimanotes.\n',
    'src/x.js': 'export function srcFn() {}\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest']);

    for (const term of ['indiaroot', 'juliettclaude', 'kiloagents', 'limanotes']) {
      assert.match(cli(repo, ['search', term]), /#L/, `${term} not indexed`);
    }
  } finally {
    repo.cleanup();
  }
});

test('what a layer is worth decides what prune may forget', async () => {
  // One number doing two jobs. Holding "rank this highly" and "keep this" as
  // separate settings is how a store ends up forgetting its decisions and
  // keeping its logs.
  const { LAYER_WEIGHTS } = await import('@memory-layer/core');

  assert.ok(LAYER_WEIGHTS.semantic > LAYER_WEIGHTS.procedural, 'a decision is worth less than a procedure');
  assert.ok(LAYER_WEIGHTS.procedural > LAYER_WEIGHTS.artifact, 'a procedure is worth less than a derived chunk');
  assert.ok(LAYER_WEIGHTS.artifact > LAYER_WEIGHTS.episodic, 'a derived chunk is worth less than a one-off note');

  // The default prune ceiling is 3, so decisions and procedures sit above it
  // and cannot be reached however old they get. Age is not evidence that a
  // decision stopped applying.
  assert.ok(LAYER_WEIGHTS.semantic > 3, 'decisions are prunable by age');
  assert.ok(LAYER_WEIGHTS.procedural > 3, 'procedures are prunable by age');
  assert.ok(LAYER_WEIGHTS.episodic <= 3, 'one-off notes are never collected');
});

test('prune refuses a window that would match everything', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const result = cliRaw(repo, ['prune', '--older-than', '0', '--dry-run']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /greater than 0/, result.stderr);
  } finally {
    repo.cleanup();
  }
});

test('a plain search uses the symbol anchors, not only why', async () => {
  const repo = makeRepo({
    'src/charge.js': 'export function chargeInvoice(inv) {\n  return psp.capture(inv);\n}\n',
    'docs/adr.md': '# ADR\n\nplaceholder.\n',
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src', 'docs']);

    // The decision never contains the symbol's name. Three text branches over
    // prose cannot reach it; the ABOUT edge can, and the store held that edge
    // while only `why` consulted it.
    cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Ledger holds sierrafunds twice',
      '--body', 'Backoff would hold sierrafunds twice on the customer account.',
      '--source-ref', 'src/charge.js#L1-L3',
    ]);

    const found = JSON.parse(cli(repo, ['search', 'chargeInvoice', '--limit', '5', '--json']));
    assert.ok(
      found.results.some((r) => r.title.includes('sierrafunds')),
      `the anchor was not used by search: ${JSON.stringify(found.results.map((r) => r.title))}`,
    );
    assert.ok(found.fusion.branches.entity >= 1, JSON.stringify(found.fusion));
  } finally {
    repo.cleanup();
  }
});

test('the entity branch says why it found nothing, and how to fix it', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder about romeoterm.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'docs']);

    const found = JSON.parse(cli(repo, ['search', 'romeoterm', '--limit', '5', '--json']));
    assert.equal(found.fusion.branches.entity, 0);
    // A store with no anchors is ordinary, not broken -- but a reader deserves
    // to know the branch had nothing to work with rather than assume it ran.
    assert.match(found.fusion.reasons.entity, /source_ref|anchor/i, found.fusion.reasons.entity);
  } finally {
    repo.cleanup();
  }
});

test('doctor declares the entity branch', async () => {
  const repo = makeRepo({ 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    assert.match(cli(repo, ['doctor']), /entity\s+ok\s+symbol-anchors/, cli(repo, ['doctor']));
  } finally {
    repo.cleanup();
  }
});
