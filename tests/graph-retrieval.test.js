/**
 * The code graph answering questions, not just drawing pictures.
 *
 * Building the graph was the easy half. The half that matters is that a
 * decision recorded one edge away can be found: the reason a function returns
 * null instead of throwing is usually written down where somebody relied on
 * it, which is the caller -- and before this, editing the callee or asking
 * about it surfaced nothing at all.
 *
 * Both checks below deliberately word the recorded decision so that no
 * keyword in it matches the query or the changed file. If the text matched,
 * the lexical branch would find it and these tests would pass with the graph
 * switched off entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, cli } from './helpers.js';

const CALLEE = [
  'namespace Billing.Domain',
  '{',
  '    public class OrderRepository',
  '    {',
  '        public Order FindById(int id) { return null; }',
  '    }',
  '}',
  '',
].join('\n');

const CALLER = [
  'using Billing.Domain;',
  '',
  'namespace Billing.Api',
  '{',
  '    public class OrderService',
  '    {',
  '        private readonly OrderRepository _repo;',
  '        public Order Get(int id)',
  '        {',
  '            return _repo.FindById(id);',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function seeded() {
  const repo = makeRepo({ 'src/OrderRepository.cs': CALLEE, 'src/OrderService.cs': CALLER });
  cli(repo, ['init', '--no-scan']);
  cli(repo, ['ingest', 'src']);

  // Recorded against the caller, and worded so nothing in it repeats a word
  // from the callee, its file name or the query below.
  cli(repo, [
    'write',
    '--layer', 'semantic',
    '--title', 'Missing rows are an empty result, never an exception',
    '--body', 'The page renders an empty table for a missing row, so the lookup must not raise.',
    '--source-ref', 'src/OrderService.cs#L8-L11',
  ]);
  return repo;
}

test('asking about a declaration finds the decision recorded on its caller', () => {
  const repo = seeded();
  try {
    const found = JSON.parse(cli(repo, ['search', 'FindById', '--json']));
    const titles = found.results.map((result) => result.title ?? result.node?.title ?? '');
    assert.ok(
      titles.some((title) => title.includes('empty result')),
      `the decision one call away was not found: ${JSON.stringify(titles)}`,
    );

    // And it is the graph that found it: with the entity branch switched off,
    // nothing in the text matches the query.
    const without = JSON.parse(cli(repo, ['search', 'FindById', '--disable', 'entity', '--json']));
    const withoutTitles = without.results.map((result) => result.title ?? result.node?.title ?? '');
    assert.ok(
      !withoutTitles.some((title) => title.includes('empty result')),
      'the decision was found without the entity branch, so this proves nothing',
    );
  } finally {
    repo.cleanup();
  }
});

test('changing a declaration surfaces what its callers decided', () => {
  const repo = seeded();
  try {
    fs.writeFileSync(
      path.join(repo.dir, 'src', 'OrderRepository.cs'),
      CALLEE.replace('return null;', 'throw new NotFoundException();'),
    );

    const report = JSON.parse(cli(repo, ['changes', '--scope', 'working', '--json']));
    const entry = report.covered.find((item) => item.file.endsWith('OrderRepository.cs'));
    assert.ok(entry, `the changed file is not in the report: ${JSON.stringify(report.changed)}`);

    const reached = entry.viaCalls ?? [];
    assert.ok(
      reached.some((memory) => memory.title.includes('empty result')),
      `the caller's decision was not reported: ${JSON.stringify(reached)}`,
    );
    // It says where it came from, because "recorded about this file" and
    // "recorded about something that calls it" are different claims.
    assert.ok(reached[0].reaches.length > 0, 'the report does not say which declaration was reached');

    const text = cli(repo, ['changes', '--scope', 'working']);
    assert.match(text, /via a call into/, 'the text report hides how it was reached');
  } finally {
    repo.cleanup();
  }
});

test('each reached decision names the declaration its own code calls', () => {
  // Two callers, two different declarations in the changed file. The label has
  // to follow each memory to its own target: taking whichever target came
  // first made it right half the time and wrong the other half.
  const repo = makeRepo({
    'src/Domain.cs': [
      'namespace Billing.Domain',
      '{',
      '    public class Domain',
      '    {',
      '        public int Alpha() { return 1; }',
      '        public int Beta() { return 2; }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/CallsAlpha.cs': [
      'using Billing.Domain;',
      '',
      'namespace Billing.Api',
      '{',
      '    public class CallsAlpha',
      '    {',
      '        private readonly Domain _domain;',
      '        public int Run() { return _domain.Alpha(); }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/CallsBeta.cs': [
      'using Billing.Domain;',
      '',
      'namespace Billing.Api',
      '{',
      '    public class CallsBeta',
      '    {',
      '        private readonly Domain _domain;',
      '        public int Run() { return _domain.Beta(); }',
      '    }',
      '}',
      '',
    ].join('\n'),
  });
  try {
    cli(repo, ['init', '--no-scan']);
    cli(repo, ['ingest', 'src']);
    cli(repo, ['write', '--layer', 'semantic', '--title', 'First caller keeps its own contract',
      '--body', 'Recorded where the first one is written.', '--source-ref', 'src/CallsAlpha.cs#L8-L8']);
    cli(repo, ['write', '--layer', 'semantic', '--title', 'Second caller keeps its own contract',
      '--body', 'Recorded where the second one is written.', '--source-ref', 'src/CallsBeta.cs#L8-L8']);

    fs.writeFileSync(
      path.join(repo.dir, 'src', 'Domain.cs'),
      fs.readFileSync(path.join(repo.dir, 'src', 'Domain.cs'), 'utf8').replace('return 1;', 'return 11;'),
    );
    const report = JSON.parse(cli(repo, ['changes', '--scope', 'working', '--json']));
    const entry = report.covered.find((item) => item.file.endsWith('Domain.cs'));
    const reached = entry?.viaCalls ?? [];
    assert.ok(reached.length >= 2, `both callers were not reported: ${JSON.stringify(reached)}`);

    for (const memory of reached) {
      const expected = memory.title.startsWith('First') ? 'Domain.Alpha' : 'Domain.Beta';
      assert.equal(memory.reaches, expected, `${memory.title} says it reaches ${memory.reaches}`);
    }
  } finally {
    repo.cleanup();
  }
});
