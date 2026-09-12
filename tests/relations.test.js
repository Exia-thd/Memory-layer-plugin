/**
 * The code graph beyond containment: what calls what, what inherits what, what
 * imports what.
 *
 * The rule this file exists to hold: a name is not an edge. Resolution here has
 * no type checker, so where a name could mean two declarations nothing is
 * written and the call is counted as ambiguous. An impact report built on a
 * guess is worse than one that admits the gap, and the only way that stays true
 * is a test that fails when a guess sneaks in.
 *
 * The second rule: a call into a framework is not a gap. Counted together with
 * the ambiguous ones, a working graph over a real C# service read as 5%
 * complete, because most call sites in it are EF Core and ASP.NET.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { relationsIn } from '@memory-layer/core';
import { RELATION_SAMPLES } from './fixtures/relation-samples.js';
import { makeRepo, cli } from './helpers.js';

/**
 * Every code language in the fixture reads calls. Dart was the exception until
 * its rule learned to read the name backwards from the argument list, since its
 * grammar has no call node of its own.
 */
const NO_CALLS = new Set();

test('every language reads its calls, imports and base types', async () => {
  const failures = [];
  for (const [file, source] of Object.entries(RELATION_SAMPLES)) {
    const found = await relationsIn(file, source);
    const problems = [];
    if (!NO_CALLS.has(file) && found.calls.length === 0) problems.push('no calls');
    // Zig imports with a builtin (`@import`), which is not an import statement.
    if (found.imports.length === 0 && !['a.zig', 'a.tla'].includes(file)) problems.push('no imports');
    // A call must name a declaration, not a keyword or a receiver.
    for (const call of found.calls) {
      // One token, in any of these languages' shapes: `repo-find-by-id` in
      // Lisp and Elm, `save!` and `valid?` in Ruby.
      if (!/^[A-Za-z_$][\w$-]*[?!]?$/.test(call.name)) problems.push(`odd call name ${JSON.stringify(call.name)}`);
      if (call.line < 1) problems.push('call with no line');
    }
    if (problems.length > 0) failures.push(`${file}: ${problems.join(', ')}`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('a call is attributed to the declaration it was written in, and to the innermost one', async () => {
  const found = await relationsIn('a.py', RELATION_SAMPLES['a.py']);
  const inGet = found.calls.filter((call) => call.fromQualified === 'Service.get');
  assert.equal(inGet.length, found.calls.length, `attributed elsewhere: ${JSON.stringify(found.calls)}`);
  assert.ok(inGet.length >= 3, `calls were not attributed: ${JSON.stringify(found.calls)}`);

  // The method, not the class around it: a decision recorded against `get` has
  // to be reachable from what `get` calls, not from everything the class does.
  assert.ok(!found.calls.some((call) => call.fromQualified === 'Service'));
});

const CSHARP_SERVICE = `using System;
using Billing.Domain;

namespace Billing.Api
{
    public class OrderService
    {
        private readonly OrderRepository _repo;
        public Order Get(int id)
        {
            var order = _repo.FindById(id);
            Validate(order);
            return OrderMapper.ToDto(order);
        }
        private void Validate(Order o) { }
    }
}
`;
const CSHARP_DOMAIN = `namespace Billing.Domain
{
    public class OrderRepository
    {
        public Order FindById(int id) { return null; }
    }
    public class OrderMapper
    {
        public static Order ToDto(Order o) { return o; }
    }
}
`;

function seeded(extra = {}) {
  const repo = makeRepo({
    'src/OrderService.cs': CSHARP_SERVICE,
    'src/OrderRepository.cs': CSHARP_DOMAIN,
    ...extra,
  });
  cli(repo, ['init', '--no-scan']);
  return repo;
}

test('ingest resolves calls across files and says how sure it is', () => {
  const repo = seeded();
  try {
    const report = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.equal(report.relations.calls, 3, JSON.stringify(report.relations));
    assert.equal(report.relations.imports, 1, 'the using directive did not resolve to the file');
    assert.equal(report.relations.ambiguous, 0, 'a call this repository declares was left unplaced');
    assert.equal(report.relations.external, 0, 'a call into this repository was counted as external');

    // Each confidence is a different claim, and three are used here: `Validate`
    // is declared in the calling file, `ToDto` is reached through its owner,
    // and `FindById` through the type `_repo` was declared with. The namespace
    // rule has a test of its own below.
    assert.deepEqual(
      Object.keys(report.relations.byConfidence).sort(),
      ['file', 'receiver', 'type'],
      JSON.stringify(report.relations.byConfidence),
    );
  } finally {
    repo.cleanup();
  }
});

test('a name two declarations share is left unresolved rather than guessed', () => {
  // Two `Save` methods, nothing to tell them apart: no import, no receiver
  // type, and the caller declares neither.
  const repo = seeded({
    'src/A.cs': 'namespace P { public class A { public void Save() { } } }\n',
    'src/B.cs': 'namespace P { public class B { public void Save() { } } }\n',
    'src/Caller.cs': 'namespace Q { public class Caller { public void Run(dynamic x) { x.Save(); } } }\n',
  });
  try {
    const report = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.ok(
      report.relations.ambiguous >= 1,
      `the ambiguous call was resolved anyway: ${JSON.stringify(report.relations)}`,
    );

    const doctor = cli(repo, ['doctor']);
    assert.match(doctor, /code graph\s+(ok|WARN)/, 'doctor does not report the code graph');
    assert.match(doctor, /ambiguous/, 'doctor hides the calls it could not place');
    // A framework call is not a gap in the graph, and must not be counted as one.
    assert.match(doctor, /go outside it/, 'doctor does not separate calls that leave the repository');
  } finally {
    repo.cleanup();
  }
});

test('re-reading a file replaces its relations instead of adding to them', () => {
  const repo = seeded();
  try {
    const first = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    const again = JSON.parse(cli(repo, ['ingest', 'src', '--force', '--json']));
    assert.equal(again.relations.calls, first.relations.calls, 'a second read changed the call count');

    // A call that the code no longer makes must not survive in the graph.
    fs.writeFileSync(
      path.join(repo.dir, 'src', 'OrderService.cs'),
      CSHARP_SERVICE.replace('            Validate(order);\n', ''),
    );
    const third = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.equal(third.relations.calls, first.relations.calls - 1, 'the removed call kept its edge');
  } finally {
    repo.cleanup();
  }
});

test('the viewer draws the calls, and a click follows them', () => {
  const repo = seeded();
  try {
    cli(repo, ['ingest', 'src']);
    const out = path.join(repo.dir, 'view.html');
    cli(repo, ['ui', '--out', out]);
    const html = fs.readFileSync(out, 'utf8');
    const payload = JSON.parse(html.match(/window\.__MEMORY__ = (.*?);<\/script>/s)[1].replace(/</g, '<'));

    const kinds = payload.graph.links.map((link) => link.kind);
    assert.ok(kinds.includes('CALLS'), 'no call edges in the picture');
    assert.ok(kinds.includes('IMPORTS'), 'no import edges in the picture');
    assert.ok(payload.stats.calls >= 3, `stats do not carry the code graph: ${JSON.stringify(payload.stats)}`);

    // Both directions are carried, whether or not the node was drawn.
    const relations = payload.graph.relations;
    assert.ok(Object.keys(relations.calls).length > 0, 'no outgoing calls recorded for clicks');
    assert.ok(Object.keys(relations.calledBy).length > 0, 'no incoming calls recorded for clicks');
  } finally {
    repo.cleanup();
  }
});

test('a store written before the code graph gains it instead of being refused', () => {
  const repo = seeded();
  try {
    cli(repo, ['ingest', 'src']);

    // Put the store back to the schema version that had no code-graph tables.
    const metaFile = path.join(repo.dir, '.memory', 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.schemaVersion = 4;
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));

    const report = JSON.parse(cli(repo, ['ingest', 'src', '--force', '--json']));
    assert.ok(report.relations.calls > 0, 'the migrated store recorded no calls');
    const after = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.ok(after.schemaVersion > 4, `the store was not brought forward: ${after.schemaVersion}`);
  } finally {
    repo.cleanup();
  }
});

test('a receiver declared with a type resolves a name many classes share', () => {
  // Two classes declare `Save`, so the name alone is ambiguous and the
  // namespace does not separate them either. The field's declared type does.
  const repo = seeded({
    'src/OrderRepo.cs': 'namespace P { public class OrderRepository { public void Save() { } } }\n',
    'src/AuditRepo.cs': 'namespace P { public class AuditRepository { public void Save() { } } }\n',
    'src/Caller.cs': [
      'namespace P',
      '{',
      '    public class Service',
      '    {',
      '        private readonly OrderRepository _repo;',
      '        public void Run() { _repo.Save(); }',
      '    }',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const report = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.equal(
      report.relations.byConfidence.type, 1,
      `the declared type did not resolve the call: ${JSON.stringify(report.relations)}`,
    );
    assert.equal(report.relations.ambiguous, 0, 'the call stayed ambiguous');
  } finally {
    repo.cleanup();
  }
});

test('a namespace the file imports picks between two declarations of a name', () => {
  // Nothing else can separate these: same name, no receiver to type, both
  // outside the calling file. The `using` is the only evidence, and it is
  // enough because only one of them is in the namespace it names.
  const repo = seeded({
    'src/Tools.cs': 'namespace Billing.Domain { public static class Tools { public static void Compute() { } } }\n',
    'src/Other.cs': 'namespace Other.Place { public static class Helpers { public static void Compute() { } } }\n',
    'src/Caller.cs': [
      'using Billing.Domain;',
      '',
      'namespace Billing.Callers',
      '{',
      '    public class Runner',
      '    {',
      '        public void Run() { Compute(); }',
      '    }',
      '}',
      '',
    ].join('\n'),
  });
  try {
    const report = JSON.parse(cli(repo, ['ingest', 'src', '--json']));
    assert.ok(
      report.relations.byConfidence.import >= 1,
      `the namespace did not decide it: ${JSON.stringify(report.relations)}`,
    );
  } finally {
    repo.cleanup();
  }
});
