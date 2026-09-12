/**
 * Every grammar the package ships is a language the code graph reads.
 *
 * Each test here pins a failure that was real, found by running a sample in
 * each of the thirty-six grammars rather than by reading the rule table:
 *   - methods were never recorded in any language (the walk stopped at the top)
 *   - C# recorded `public Order Get()` as `Order`, the return type
 *   - a C# file declared nothing, being one namespace
 *   - loading PHP before Lua made Lua parse into ERROR nodes (shared runtime)
 *   - loading ~24 grammars, or Swift alone, aborted the process (V8 "Zone" OOM)
 *   - a class over 1200 characters was cut mid-method by character windows
 *   - three grammars in tree-sitter-wasms could not be loaded at all, and its
 *     Lua grammar parsed correctly only once per process
 *
 * All samples run in one process on purpose: the abort and the cross-grammar
 * corruption only show up when many grammars share a process, which is what
 * ingesting a polyglot repository does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chunk, declarations, probeAstChunking, DEFAULT_CHUNK_SIZE } from '@memory-layer/core';
import { SAMPLES } from './fixtures/language-samples.js';
import { REPO_ROOT } from './helpers.js';

test('every packaged grammar has a language rule, and every rule loads', async () => {
  const require = createRequire(path.join(REPO_ROOT, 'packages', 'core', 'package.json'));
  const out = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
  const packaged = fs.readdirSync(out)
    .filter((name) => name.endsWith('.wasm'))
    .map((name) => name.replace(/^tree-sitter-/, '').replace(/\.wasm$/, ''))
    .sort();

  const capability = await probeAstChunking();
  assert.equal(capability.status, 'available', capability.reason);
  const loaded = [...capability.languages].sort();
  const missing = packaged.filter((label) => !loaded.includes(label));
  assert.deepEqual(missing, [], `grammars in tree-sitter-wasms with no working rule: ${missing.join(', ')}`);
  assert.equal(loaded.length, packaged.length, `loaded ${loaded.join(', ')}`);
});

test('each language records exactly its declarations, qualified by what encloses them', async () => {
  const failures = [];
  for (const [label, [file, source, expected]] of Object.entries(SAMPLES)) {
    const got = (await declarations(file, source)).map((item) => item.qualifiedName);
    const missing = expected.filter((name) => !got.includes(name));
    const extra = got.filter((name) => !expected.includes(name));
    if (missing.length || extra.length) {
      failures.push(`${label}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('a C# method is named by its name, not its return type', async () => {
  const [file, source] = SAMPLES.c_sharp;
  const found = await declarations(file, source);
  const get = found.find((item) => item.qualifiedName === 'OrderService.Get');
  assert.ok(get, `OrderService.Get not found in ${found.map((item) => item.qualifiedName).join(', ')}`);
  assert.equal(get.name, 'Get');
  assert.equal(get.kind, 'method_declaration');
  assert.ok(!found.some((item) => item.name === 'Order'), 'the return type was recorded as a declaration');
});

test('a file parses the same the second time as the first', async () => {
  // tree-sitter-wasms' Lua grammar read its first file correctly and every
  // later one into ERROR nodes: in an ingest, only the first Lua file counted.
  const unstable = [];
  for (const [label, [file, source]] of Object.entries(SAMPLES)) {
    const first = JSON.stringify(await declarations(file, source));
    for (let round = 0; round < 3; round++) {
      if (JSON.stringify(await declarations(file, source)) !== first) {
        unstable.push(label);
        break;
      }
    }
  }
  assert.deepEqual(unstable, [], `declarations change between parses: ${unstable.join(', ')}`);
});

test('a grammar loaded after another still parses correctly', async () => {
  // PHP then Lua in one shared runtime: Lua's scanner called PHP's helper of
  // the same name and `function charge() end` became ERROR nodes.
  await declarations(...SAMPLES.php.slice(0, 2));
  const [file, source] = SAMPLES.lua;
  const names = (await declarations(file, source)).map((item) => item.qualifiedName);
  assert.deepEqual(names.sort(), ['M.total', 'charge', 'helper']);
});

test('a class bigger than one chunk is cut between its members, with doc comments kept', async () => {
  const methods = Array.from({ length: 14 }, (_, i) => [
    `        /// <summary>Loads order ${i}.</summary>`,
    `        public async Task<Order> GetOrder${i}Async(int id, CancellationToken ct)`,
    '        {',
    '            var order = await _repo.FindAsync(id, ct);',
    `            if (order is null) throw new NotFoundException($"order {id}");`,
    `            return order with { Version = ${i} };`,
    '        }',
    '',
  ].join('\n')).join('\n');
  const source = [
    'using System;',
    '',
    'namespace Billing.Api.Services',
    '{',
    '    public sealed class OrderService : IOrderService',
    '    {',
    '        public OrderService(IRepository repo) { _repo = repo; }',
    '',
    methods,
    '    }',
    '}',
    '',
  ].join('\n');
  const lines = source.split('\n');

  const pieces = await chunk('src/OrderService.cs', source);
  assert.ok(pieces.length > 1, 'a class of several kilobytes was not cut');
  for (const piece of pieces) {
    assert.equal(piece.mode, 'AST_DECLARATION', `cut by characters at line ${piece.startLine}`);
    assert.ok(piece.text.length <= DEFAULT_CHUNK_SIZE, `chunk at line ${piece.startLine} is over budget`);
    const first = lines[piece.startLine - 1].trim();
    assert.match(first, /^(using |\/\/\/ <summary>)/, `chunk starts mid-member: ${first}`);
  }
  // The file header travels with the class, not alone.
  assert.match(pieces[0].text, /public sealed class OrderService/);
});

test('data formats are cut on their own structure, losing and repeating no line', async () => {
  const json = JSON.stringify({
    name: 'web-client',
    scripts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`task${i}`, `node scripts/task${i}.js --flag ${i}`])),
    dependencies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pkg-${i}`, `^${i}.0.0`])),
  }, null, 2);
  const yaml = 'name: ci\njobs:\n' + Array.from({ length: 25 }, (_, i) =>
    `  job${i}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm run task${i}\n`).join('');
  const css = Array.from({ length: 60 }, (_, i) => `.card-${i} {\n  color: red;\n  padding: ${i}px;\n}\n`).join('\n');

  const cases = [
    ['package.json', json, /^\s*("[^"]+":|[{[])/],
    ['ci.yml', yaml, /^(\s{0,2}[\w-]+:)/],
    ['site.css', css, /^(\.|@)/],
  ];
  for (const [file, source, boundary] of cases) {
    const lines = source.split('\n');
    const pieces = await chunk(file, source);
    const seen = new Map();
    for (const piece of pieces) {
      assert.equal(piece.mode, 'AST_DECLARATION', `${file}: cut by characters at line ${piece.startLine}`);
      assert.match(lines[piece.startLine - 1], boundary, `${file}: chunk starts mid-structure at line ${piece.startLine}`);
      for (let line = piece.startLine; line <= piece.endLine; line++) seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    const lost = lines.map((text, index) => [text, index + 1]).filter(([text, n]) => text.trim() && !seen.has(n));
    assert.deepEqual(lost.map(([, n]) => n), [], `${file}: lines in no chunk`);
    assert.deepEqual([...seen].filter(([, count]) => count > 1).map(([n]) => n), [], `${file}: lines in two chunks`);
  }
});

test('a Vue component is read through its script, with honest line numbers', async () => {
  const script = Array.from({ length: 25 }, (_, i) =>
    `function handler${i}(value: number): number {\n  const doubled = value * 2;\n  return doubled + ${i};\n}\n`).join('\n');
  const source = `<template>\n${Array.from({ length: 30 }, (_, i) => `  <div>{{ rows[${i}] }}</div>`).join('\n')}\n</template>\n\n` +
    `<script setup lang="ts">\nimport { ref } from 'vue';\n${script}const total = ref(0);\n</script>\n\n<style scoped>\n${'.r { color: blue; }\n'.repeat(15)}</style>\n`;
  const lines = source.split('\n');

  const found = await declarations('src/Rows.vue', source);
  assert.equal(found.length, 26, found.map((item) => item.name).join(', '));
  for (const item of found) {
    assert.ok(lines[item.startLine - 1].includes(item.name), `${item.name} points at line ${item.startLine}: ${lines[item.startLine - 1]}`);
  }

  const pieces = await chunk('src/Rows.vue', source);
  const covered = new Set(pieces.flatMap((piece) =>
    Array.from({ length: piece.endLine - piece.startLine + 1 }, (_, i) => piece.startLine + i)));
  const lost = lines.map((text, index) => [text, index + 1]).filter(([text, n]) => text.trim() && !covered.has(n));
  assert.deepEqual(lost.map(([, n]) => n), [], 'the <script> or </script> line fell out of every chunk');
  for (const piece of pieces) {
    assert.ok(!/^\s+(const doubled|return doubled)/.test(lines[piece.startLine - 1]), `script cut mid-function at line ${piece.startLine}`);
  }
});
