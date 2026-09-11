/**
 * Scores retrieval against a golden set.
 *
 * The test suite answers "does the machine do what it was built to do". This
 * answers the different question nobody has asked yet: "does it find the right
 * thing". A store can pass every test and still return the wrong document.
 *
 * Two numbers per configuration:
 *
 *   recall@k    how many questions found their answer in the top k
 *   false hits  how many results were things the question explicitly rejects
 *
 * Recall alone is easy to game -- return everything and it is perfect. The
 * pair is what makes a threshold choosable, because they move in opposite
 * directions and the useful setting is where the trade stops being worth it.
 *
 * Each question carries a second phrasing. Mem0's own benchmark analysis names
 * this as the flaw in theirs: "benchmarks often reuse almost identical wording
 * for probes", which measures how well a system matches one way of asking
 * rather than whether it understood. Asking twice separates the two.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const TOP_K = 5;

const golden = JSON.parse(fs.readFileSync(path.join(HERE, 'golden.json'), 'utf8'));

function search(query, disable) {
  const args = [CLI, 'search', query, '--limit', String(TOP_K), '--json'];
  if (disable) args.push('--disable', disable);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, MEMORY_LAYER_LOG_LEVEL: 'error' },
  });
  try {
    return JSON.parse(result.stdout).results ?? [];
  } catch {
    return [];
  }
}

/**
 * A two-sided 95% Wilson score interval for a rate.
 *
 * Borrowed from Forgewright's routing eval, which scores its corpus this way.
 * The reason to bother: "five out of six" and "seventeen out of twenty" are
 * both around 85%, and only one of them is a finding. A bare percentage hides
 * that; an interval prints it.
 *
 * At n=6 the interval runs about forty points wide, which is a polite way of
 * saying the number means almost nothing yet. It narrows as the set grows, and
 * that narrowing is the actual argument for writing twenty questions instead of
 * three -- an argument the runner can now make itself rather than leaving it as
 * an assertion in a conversation.
 *
 * Wilson rather than the textbook normal interval because it stays sane at the
 * edges: a perfect score does not produce an interval running past 100%, which
 * is exactly where a small golden set tends to land.
 */
const Z_95 = 1.959963984540054;

function wilsonInterval(successes, total) {
  if (total <= 0) return { low: 0, high: 1 };
  const p = successes / total;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const spread = (Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/** One configuration, scored over every question and both phrasings. */
function score(label, disable) {
  let asked = 0;
  let found = 0;
  let rejected = 0;

  for (const question of golden.questions) {
    for (const phrasing of [question.ask, question.also].filter(Boolean)) {
      asked += 1;
      const hits = search(phrasing, disable);
      const refs = hits.map((hit) => hit.sourceRef ?? '');

      if (question.expect.some((want) => refs.some((ref) => ref.includes(want)))) found += 1;
      if (question.reject.some((bad) => refs.some((ref) => ref.includes(bad)))) rejected += 1;
    }
  }

  const recall = ((found / asked) * 100).toFixed(0);
  const falseRate = ((rejected / asked) * 100).toFixed(0);
  const ci = wilsonInterval(found, asked);
  const width = ((ci.high - ci.low) * 100).toFixed(0);
  console.log(
    `${label.padEnd(20)} recall@${TOP_K} ${String(found).padStart(2)}/${asked} (${recall}%)` +
    `  95% CI ${(ci.low * 100).toFixed(0)}-${(ci.high * 100).toFixed(0)}%, ${width} wide` +
    `   false ${rejected}/${asked}`,
  );
  return { found, asked, rejected, ci };
}

console.log(`golden set: ${golden.questions.length} questions, 2 phrasings each\n`);

console.log('-- which branches earn their place --');
score('all branches', null);
score('without bm25', 'bm25');
score('without semantic', 'semantic');
score('without entity', 'entity');
score('without graph', 'graph');

console.log('\nA branch that changes nothing when removed is a branch paying no rent.');
console.log('Read the interval before the percentage: two configurations whose');
console.log('intervals overlap have not been shown to differ, however far apart');
console.log('their headline numbers look. That is what a wide interval is for.');
