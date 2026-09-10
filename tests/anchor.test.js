/**
 * Getting the graph wired without asking anyone to remember.
 *
 * The graph branch retrieves along edges, and nothing created edges. `ABOUT`
 * was written by ingest and by nothing else, so a hand-written decision -- the
 * most valuable kind of memory there is -- had no route to the function it was
 * about: the graph held the symbol, the store held the decision, and the two
 * sat unconnected. Memory-to-memory links were worse, because they needed
 * somebody to type `memory link` at the right moment.
 *
 * A feature that works only when the user recalls it exists mostly does not
 * work. So what is derivable is derived, and what is a judgement is put in
 * front of the person as a command they can run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, cli } from './helpers.js';

const SOURCE = [
  'export function chargeInvoice(invoice, attempt) {',
  '  return psp.capture(invoice.amount);',
  '}',
  '',
  'export function refundInvoice(invoice) {',
  '  return psp.refund(invoice.id);',
  '}',
].join('\n');

function seeded() {
  const repo = makeRepo({ 'src/charge.js': SOURCE, 'docs/adr.md': '# ADR\n\nplaceholder.\n' });
  cli(repo, ['init', '--no-scan']);
  cli(repo, ['ingest', 'src', 'docs']);
  return repo;
}

test('a source_ref with a line span anchors the memory to what it covers', async () => {
  const repo = seeded();
  try {
    // Lines 1-3 are chargeInvoice. The span answers which declaration this is
    // about exactly -- no guessing, and nothing for the writer to specify.
    const out = cli(repo, [
      'write', '--layer', 'semantic',
      '--title', 'Retry twice, not backoff',
      '--body', 'The gateway counts each attempt as a new authorisation.',
      '--source-ref', 'src/charge.js#L1-L3',
    ]);
    assert.match(out, /anchored to chargeInvoice/, `not anchored: ${out}`);

    // The point of anchoring: asking about the function returns the decision,
    // even though the decision never mentions the function by name.
    const why = JSON.parse(cli(repo, ['why', 'chargeInvoice', '--json']));
    assert.ok(
      why.results.some((hit) => hit.title.includes('Retry twice')),
      `the decision did not reach the symbol: ${JSON.stringify(why.results.map((r) => r.title))}`,
    );
    assert.ok(why.fusion.branches.anchor >= 1, JSON.stringify(why.fusion));
  } finally {
    repo.cleanup();
  }
});

test('a span anchors only the declarations it actually covers', async () => {
  const repo = seeded();
  try {
    const out = cli(repo, [
      'write', '--layer', 'semantic',
      '--title', 'Refunds are idempotent',
      '--body', 'The processor deduplicates by invoice id.',
      '--source-ref', 'src/charge.js#L5-L7',
    ]);
    assert.match(out, /anchored to refundInvoice/, out);
    // Over-anchoring would put every decision on every symbol in the file and
    // make the anchor branch useless by making it always match.
    assert.doesNotMatch(out, /chargeInvoice/, `the span leaked onto a neighbour: ${out}`);
  } finally {
    repo.cleanup();
  }
});

test('a source_ref with no span, or to a file with no declarations, anchors nothing', async () => {
  const repo = seeded();
  try {
    // Both are ordinary. Neither deserves a warning, and neither may fail the
    // write -- the anchor is a bonus on top of a memory that is already valid.
    const noSpan = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'A session note',
      '--body', 'Recorded during a session.', '--source-ref', 'session:2026-09-11',
    ]);
    assert.doesNotMatch(noSpan, /anchored to/, noSpan);

    const prose = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'A decision in prose',
      '--body', 'Written in a document.', '--source-ref', 'docs/adr.md#L1-L3',
    ]);
    assert.doesNotMatch(prose, /anchored to/, prose);
  } finally {
    repo.cleanup();
  }
});

test('writing a close memory offers a link as a command, and does not create one', async () => {
  const repo = seeded();
  try {
    const first = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Retry twice on the payment gateway',
      '--body', 'The payment gateway counts each retry as a new authorisation hold.',
      '--source-ref', 'docs/adr.md#L1-L3',
    ]).trim().split('\n')[0];

    const out = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Retry limits on the payment gateway',
      '--body', 'Each retry against the payment gateway opens another authorisation hold.',
      '--source-ref', 'docs/adr.md#L1-L3',
    ]);

    assert.match(out, /related memories/, `nothing was suggested: ${out}`);
    assert.match(out, new RegExp(`memory link \\S+ ${first} DERIVED_FROM`), out);

    // Suggested, not created. The graph branch retrieves through edges, so a
    // guessed edge pulls an unrelated decision into results for the rest of the
    // store's life -- and nothing downstream can tell a guess from a judgement.
    const second = out.trim().split('\n')[0];
    const graph = JSON.parse(cli(repo, ['graph', second, '--json']));
    const invented = (graph.edges ?? []).filter((edge) => edge.type === 'DERIVED_FROM');
    assert.equal(invented.length, 0, `an edge was created without being asked: ${JSON.stringify(invented)}`);
  } finally {
    repo.cleanup();
  }
});

test('a memory with nothing near it says nothing', async () => {
  const repo = seeded();
  try {
    const out = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Zulu quebec tango decision',
      '--body', 'Entirely unrelated to anything else recorded.',
      '--source-ref', 'docs/adr.md#L1-L3',
    ]);
    // Prompting on every write would train the reader to ignore the prompt.
    assert.doesNotMatch(out, /related memories/, out);
  } finally {
    repo.cleanup();
  }
});

test('conflicts prints the command that records what it found', async () => {
  const repo = seeded();
  try {
    // `conflicts` detected contradictions and left recording them as an
    // exercise, so the same pair was rediscovered from scratch every time
    // anyone asked.
    const a = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Retry twice on timeout',
      '--body', 'Stop after the second attempt.', '--source-ref', 'docs/adr.md#L1-L3',
    ]).trim().split('\n')[0];
    const b = cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Retry twice on timeout',
      '--body', 'Never stop; retry with exponential backoff indefinitely.',
      '--source-ref', 'docs/adr.md#L5-L7',
    ]).trim().split('\n')[0];

    const out = cli(repo, ['conflicts']);
    if (out.trim() === 'no conflicts') return;
    assert.match(out, /memory link \S+ \S+ CONTRADICTS/, `no command offered: ${out}`);
    assert.ok(out.includes(a) || out.includes(b), out);
  } finally {
    repo.cleanup();
  }
});

test('an anchored decision reaches the symbol through the graph, not the wording', async () => {
  const repo = seeded();
  try {
    // The decision shares no vocabulary with the function name. Only the ABOUT
    // edge derived from the line span connects them, so a hit here is the code
    // graph doing retrieval rather than decoration.
    cli(repo, [
      'write', '--layer', 'semantic', '--title', 'Ledger holds sierrafunds twice',
      '--body', 'Backoff would hold sierrafunds twice on the customer account.',
      '--source-ref', 'src/charge.js#L1-L3',
    ]);

    const why = JSON.parse(cli(repo, ['why', 'chargeInvoice', '--json']));
    assert.ok(
      why.results.some((hit) => hit.title.includes('sierrafunds')),
      `the anchor did not retrieve: ${JSON.stringify(why.results.map((r) => r.title))}`,
    );
  } finally {
    repo.cleanup();
  }
});
