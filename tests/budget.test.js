/**
 * What the hooks spend, and what they admit to leaving out.
 *
 * The limit was a count of entries -- three. Three entries is 60 tokens or
 * 6,000 depending on how much somebody wrote, so the same number bought a
 * hundredfold difference in cost. The knob measured the wrong thing.
 *
 * Worse, it said nothing. Nine memories about a file, three shown, six gone
 * without a mark -- in the hook that runs on every Read, Grep and Glob, which
 * is the most-executed path in the whole layer. `memory changes` had reported
 * an `omitted` count for exactly this reason since it was written; search and
 * why had not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeRepo, cli, env, REPO_ROOT } from './helpers.js';

const HOOK = path.join(REPO_ROOT, 'hooks', 'memory-hook.mjs');

/** Runs a hook the way the harness does: JSON on stdin, JSON on stdout. */
function hook(repo, mode, payload, extraEnv = {}) {
  const out = execFileSync(process.execPath, [HOOK, mode], {
    cwd: repo.dir,
    input: JSON.stringify({ cwd: repo.dir, ...payload }),
    env: env(repo, extraEnv),
    encoding: 'utf8',
  });
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function context(result) {
  return result?.hookSpecificOutput?.additionalContext ?? '';
}

/** Records `count` memories against one file, each with a body of `bodyChars`. */
function seed(repo, count, bodyChars) {
  for (let i = 0; i < count; i++) {
    cli(repo, [
      'write',
      '--layer', 'semantic',
      '--title', `Decision number ${i} about charging`,
      '--body', 'x'.repeat(bodyChars),
      '--source-ref', `src/charge.js#L${i + 1}-L${i + 2}`,
    ]);
  }
}

test('search reports how many hits the limit cut', async () => {
  const repo = makeRepo({ 'docs/note.md': '# N\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    seed(repo, 6, 40);

    const found = JSON.parse(cli(repo, ['search', 'charging', '--limit', '2', '--json']));
    assert.equal(found.results.length, 2);
    assert.ok(found.total >= 6, `total not reported: ${JSON.stringify(found.total)}`);
    assert.ok(found.omitted >= 4, `omitted not reported: ${JSON.stringify(found.omitted)}`);
  } finally {
    repo.cleanup();
  }
});

test('why reports the same, counting the anchored hits it adds itself', async () => {
  const repo = makeRepo({ 'src/charge.js': 'export function chargeInvoice() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    seed(repo, 8, 40);

    const why = JSON.parse(cli(repo, ['why', 'src/charge.js', '--limit', '3', '--json']));
    assert.equal(why.results.length, 3);
    // Anchored hits are merged in after `search` returns, so a total taken from
    // search alone would undercount exactly where it matters: a file carrying a
    // lot of recorded reasoning.
    assert.ok(why.total >= 8, `total undercounts anchored hits: ${why.total}`);
    assert.equal(why.omitted, why.total - 3);
  } finally {
    repo.cleanup();
  }
});

test('the pre-tool hook spends a token budget, not a number of entries', async () => {
  const repo = makeRepo({ 'src/charge.js': 'export function chargeInvoice() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    seed(repo, 8, 40);

    const generous = context(
      hook(repo, 'pre-tool', { tool_input: { file_path: 'src/charge.js' } },
        { MEMORY_LAYER_HOOK_TOKENS: '4000' }),
    );
    const tight = context(
      hook(repo, 'pre-tool', { tool_input: { file_path: 'src/charge.js' } },
        { MEMORY_LAYER_HOOK_TOKENS: '40' }),
    );

    const count = (text) => text.split('\n').filter((line) => line.startsWith('- [')).length;
    assert.ok(count(generous) > count(tight), `budget had no effect: ${count(generous)} vs ${count(tight)}`);
    assert.ok(count(tight) >= 1, 'a tight budget returned nothing at all');
  } finally {
    repo.cleanup();
  }
});

test('the pre-tool hook says how many entries it did not show', async () => {
  const repo = makeRepo({ 'src/charge.js': 'export function chargeInvoice() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    seed(repo, 9, 40);

    const text = context(
      hook(repo, 'pre-tool', { tool_input: { file_path: 'src/charge.js' } },
        { MEMORY_LAYER_HOOK_TOKENS: '60' }),
    );
    assert.match(text, /Project memory has \d+ entries about src\/charge\.js, showing \d+:/, text);
    assert.match(text, /\d+ more not shown: memory_why src\/charge\.js/, text);
  } finally {
    repo.cleanup();
  }
});

test('one oversized entry does not turn the hook into silence', async () => {
  const repo = makeRepo({ 'src/charge.js': 'export function chargeInvoice() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    // A single memory far larger than any sensible budget. Returning nothing
    // here would be the worst outcome: the file has recorded reasoning and the
    // agent would be told it has none.
    seed(repo, 1, 8000);

    const text = context(
      hook(repo, 'pre-tool', { tool_input: { file_path: 'src/charge.js' } },
        { MEMORY_LAYER_HOOK_TOKENS: '40' }),
    );
    assert.match(text, /Project memory has/, `an oversized entry produced silence: ${JSON.stringify(text)}`);
  } finally {
    repo.cleanup();
  }
});

test('the session-start hook budgets constraints and names the tail', async () => {
  const repo = makeRepo({ 'docs/note.md': '# N\n\nplaceholder.\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    seed(repo, 12, 40);

    const text = context(hook(repo, 'session-start', {}, { MEMORY_LAYER_SESSION_TOKENS: '60' }));
    assert.match(text, /Active constraints recorded for this project \(\d+ of \d+\):/, text);
    assert.match(text, /\d+ more: memory_constraints/, text);
  } finally {
    repo.cleanup();
  }
});

test('a file with nothing recorded still produces no output at all', async () => {
  const repo = makeRepo({ 'src/quiet.js': 'export function quiet() {}\n' });
  try {
    cli(repo, ['init', '--no-scan']);
    // Silence when there is nothing to say is what keeps the cost proportional
    // to the usefulness. A budget must not turn that into a header with nothing
    // under it.
    const result = hook(repo, 'pre-tool', { tool_input: { file_path: 'src/quiet.js' } });
    assert.equal(context(result), '', `the hook spoke about an unrecorded file: ${JSON.stringify(result)}`);
  } finally {
    repo.cleanup();
  }
});
