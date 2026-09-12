/**
 * Two gaps that had the same shape as the ones this project keeps finding.
 *
 * `OCCURRED_IN` was declared as an edge type from the start with nothing that
 * could ever produce one -- an edge label with no writer, which is how a graph
 * ends up holding nodes and no relationships.
 *
 * And an MCP tool that answers with a megabyte of JSON has cost more context
 * than the grep it replaced, so results are capped -- out loud, because a
 * silently truncated list reads exactly like a complete one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgeted, OUTPUT_BUDGET_BYTES } from '../packages/cli/dist/mcp.js';
import { makeRepo, cli } from './helpers.js';

test('a memory written during a session records that it occurred in it', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n\nGhi chú.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const opened = JSON.parse(cli(repo, ['session', 'start', 'sửa retry', '--json']));
    assert.ok(opened.id, 'no session node was created');

    const written = JSON.parse(
      cli(repo, ['write', '--layer', 'episodic', '--title', 'Thử lại lần ba',
        '--body', 'Lần thử thứ ba làm PSP tính thành lượt mới.',
        '--source-ref', 'docs/a.md#L1-L3', '--json']),
    );

    const graph = JSON.parse(cli(repo, ['graph', written.id, '--json']));
    const edges = graph.edges.map((edge) => edge.type);
    assert.ok(edges.includes('OCCURRED_IN'), `no session edge: ${JSON.stringify(edges)}`);
    assert.ok(
      graph.edges.some((edge) => edge.to === opened.id),
      'the edge does not point at the open session',
    );
  } finally {
    repo.cleanup();
  }
});

test('the session node does not occur in itself', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    const opened = JSON.parse(cli(repo, ['session', 'start', 'x', '--json']));
    const graph = JSON.parse(cli(repo, ['graph', opened.id, '--json']));
    assert.ok(
      !graph.edges.some((edge) => edge.from === opened.id && edge.to === opened.id),
      'the session linked to itself',
    );
  } finally {
    repo.cleanup();
  }
});

test('closing a session stops the linking', async () => {
  const repo = makeRepo({ 'docs/a.md': '# A\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['session', 'start', 'x']);
    const closed = JSON.parse(cli(repo, ['session', 'end', '--json']));
    assert.ok(closed.closed, 'nothing was closed');

    const after = JSON.parse(
      cli(repo, ['write', '--layer', 'semantic', '--title', 'Sau phiên',
        '--body', 'Không thuộc phiên nào.', '--source-ref', 'docs/a.md#L1-L1', '--json']),
    );
    const graph = JSON.parse(cli(repo, ['graph', after.id, '--json']));
    assert.equal(
      graph.edges.filter((edge) => edge.type === 'OCCURRED_IN').length,
      0,
      'a closed session still captured a write',
    );
  } finally {
    repo.cleanup();
  }
});

test('an oversized result is trimmed and says so', () => {
  const payload = {
    scope: 'staged',
    results: Array.from({ length: 4000 }, (_, index) => ({
      id: `mem_${index}`,
      title: `A memory with a reasonably long title, number ${index}`,
      snippet: 'x'.repeat(120),
    })),
  };
  const text = budgeted('dai_memory_search', payload);

  assert.ok(text.includes('dai_memory_truncated'), 'truncation was silent');
  assert.match(text, /item\(s\) were dropped/);
  // The scalar context survives, so the agent can read what is left.
  assert.match(text, /"scope": "staged"/);

  const body = text.split('\n\ndai_memory_truncated')[0];
  assert.ok(
    body.length <= OUTPUT_BUDGET_BYTES * 1.1,
    `trimmed body is still ${body.length} bytes`,
  );
  assert.ok(JSON.parse(body).results.length > 0, 'everything was dropped');
});

test('a small result is returned whole, with no notice', () => {
  const text = budgeted('dai_memory_get', { id: 'mem_1', title: 'Short' });
  assert.equal(text, JSON.stringify({ id: 'mem_1', title: 'Short' }, null, 2));
  assert.ok(!text.includes('dai_memory_truncated'));
});

test('an oversized result with nothing to trim says that, not "0 items dropped"', () => {
  // One long string, no list. The trimmer has nothing to shorten, and the old
  // notice reported a truncation that never happened -- leaving the reader to
  // wonder which items went missing from a reply that had in fact lost nothing.
  const text = budgeted('dai_memory_get', {
    id: 'mem_1',
    body: 'x'.repeat(OUTPUT_BUDGET_BYTES + 1000),
  });

  assert.ok(text.includes('dai_memory_oversized'), text.slice(-400));
  assert.ok(!text.includes('dai_memory_truncated'), 'claimed a trim that did not happen');
  assert.ok(!/\b0 item\(s\) were dropped/.test(text), text.slice(-400));
  // Returned whole: nothing was silently removed, so the body must still parse.
  const body = text.split('\n\ndai_memory_oversized')[0];
  assert.equal(JSON.parse(body).body.length, OUTPUT_BUDGET_BYTES + 1000);
});
