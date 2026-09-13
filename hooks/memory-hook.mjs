#!/usr/bin/env node
/**
 * Hooks into the session so memory is consulted without anyone remembering to.
 *
 * Two rules govern everything here:
 *
 *   Fail open.   A broken memory layer must never break the session. Every path
 *                ends in exit 0 with no output rather than an error.
 *   Never fail silent. Whatever went wrong is written to the log file, so a hook
 *                that has been quietly doing nothing for a week is discoverable.
 *
 * Reads are automatic. Writes are not: recording into a project's store without
 * the user having asked is a decision they should make deliberately, so the
 * write path stays off unless MEMORY_LAYER_AUTO_RECORD=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { CLI_PATH: CLI, readiness, setupMessage } = await import(
  pathToFileURL(path.join(HERE, '..', 'bin', 'resolve-cli.mjs')).href
);
const BUDGET_MS = 7000;

/**
 * How much of the context window a hook may spend, in tokens.
 *
 * The limit used to be a count of entries -- three. Three entries is 60 tokens
 * or 6,000 depending on how much somebody wrote, so the same number bought a
 * hundredfold difference in cost, and the knob was measuring the wrong thing.
 *
 * A budget in tokens has the property a count does not: what fits is decided by
 * what is actually there. Small entries all get through; one long one does not
 * crowd out the rest silently, because whatever did not fit is counted and said.
 */
const TOKEN_BUDGET = Number(process.env.MEMORY_LAYER_HOOK_TOKENS ?? 400);
const SESSION_TOKEN_BUDGET = Number(process.env.MEMORY_LAYER_SESSION_TOKENS ?? 700);

/**
 * A hook entry is a title and a source_ref, not a snippet.
 *
 * A full search hit carries 220 characters of body and runs about sixty tokens,
 * so a 400-token budget showed six of them and apologised for the rest. Without
 * the snippet an entry is roughly fifteen, and the same budget covers more than
 * twenty -- which is the difference between handing the agent a few entries and
 * handing it the shape of what is recorded, to choose from.
 *
 * The snippets are not lost. `dai_memory_get` and `dai_memory_why` fetch them for the
 * entries worth opening, which is the point: pick from a list, then read.
 */

/** Four characters per token: rough, and on the safe side for prose and code. */
function tokensOf(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Fills a budget in order and reports what did not fit.
 *
 * Truncating is fine. Truncating without saying so is how a reader concludes
 * that three entries is all there was -- the same failure as a walk that skips
 * nine files under a line reading like success.
 */
function fitToBudget(lines, budget) {
  const kept = [];
  let spent = 0;
  for (const line of lines) {
    const cost = tokensOf(line);
    // Always take the first, however long: a budget that can return nothing
    // turns one oversized entry into silence.
    if (kept.length > 0 && spent + cost > budget) break;
    kept.push(line);
    spent += cost;
  }
  return { kept, dropped: lines.length - kept.length, spent };
}

const mode = process.argv[2];

try {
  const input = await readStdin();
  const payload = input ? safeParse(input) : {};
  const cwd = payload.cwd || process.cwd();

  // Said before the store check, not after it.
  //
  // An incomplete install cannot run `init`, so there is never a store, so a
  // notice placed after that check would never be reached -- which is precisely
  // how this failure stayed invisible: the one condition that needs reporting is
  // the one that skips the report. Only session start says it; a notice on
  // every Read and Grep would be noise about the same thing.
  //
  // The model counts as part of the install. Without it every command the other
  // hooks run refuses, so staying quiet here would leave them failing one by one
  // into a log file, which is the silence this check exists to end.
  const state = await readiness();
  if (!state.ready) {
    if (mode === 'session-start') {
      emit({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: setupMessage(state),
        },
      });
    }
    exitQuiet();
  }

  if (!hasStore(cwd)) exitQuiet();

  switch (mode) {
    case 'session-start':
      await sessionStart(cwd);
      break;
    case 'pre-commit':
      await preCommit(cwd, payload);
      break;

    case 'pre-tool':
      await preTool(cwd, payload);
      break;
    case 'post-tool':
      await postTool(cwd, payload);
      break;
    default:
      exitQuiet();
  }
} catch (err) {
  logFailure(err);
}
exitQuiet();

/** Constraints in force and unresolved contradictions, added to the session context. */
async function sessionStart(cwd) {
  const conflicts = await runCli(cwd, ['conflicts', '--json']);
  const constraints = await runCli(cwd, ['constraints', '--limit', '20', '--json']);

  const lines = [];
  const found = constraints ?? [];
  if (found.length > 0) {
    // Constraints are ordered by importance, so a budget keeps the ones that
    // matter and reports the tail rather than choosing a number in advance.
    const entries = found.map((node) => `- ${node.title} (${node.sourceRef})`);
    const { kept, dropped } = fitToBudget(entries, SESSION_TOKEN_BUDGET);
    lines.push(
      dropped > 0
        ? `Active constraints recorded for this project (${kept.length} of ${found.length}):`
        : 'Active constraints recorded for this project:',
    );
    lines.push(...kept);
    if (dropped > 0) lines.push(`${dropped} more: dai_memory_constraints`);
  }

  const unresolved = conflicts ?? [];
  if (unresolved.length > 0) {
    lines.push('', `${unresolved.length} unresolved contradiction(s) in project memory:`);
    for (const conflict of unresolved.slice(0, 5)) {
      lines.push(`- ${conflict.a.title}  <->  ${conflict.b.title}`);
    }
    lines.push('Run dai_memory_conflicts for the full list before recording new decisions.');
  }

  if (lines.length === 0) return;
  lines.push('', 'These describe what was true when recorded. Re-verify against the working tree.');
  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  });
}

/**
 * When the agent reaches for raw search, tell it what memory already holds.
 *
 * This is the layer that does not rely on the agent remembering a tool exists:
 * it fires at the moment the question is being asked.
 */
async function preTool(cwd, payload) {
  const target = payload?.tool_input?.file_path || payload?.tool_input?.pattern;
  if (!target || typeof target !== 'string') return;

  // --anchor-only: this hook fires on every Read, Grep and Glob, and only needs
  // the provenance anchor. Loading the embedding model here cost 2.5s of the
  // 10s budget on every file the agent touched.
  // Ask for more than will fit and let the budget decide, rather than letting a
  // count decide and never learning what it cost.
  const why = await runCli(cwd, ['why', target, '--limit', '10', '--anchor-only', '--json']);
  const hits = why?.results ?? [];
  if (hits.length === 0) return;

  const entries = hits.map(
    (hit) => `- [${hit.layer}] ${hit.title} (${hit.sourceRef})${hit.stale ? ' (recorded a while ago)' : ''}`,
  );
  const { kept, dropped } = fitToBudget(entries, TOKEN_BUDGET);

  // `omitted` is what the query itself left behind; `dropped` is what the budget
  // did. Both are things the reader has not seen, so both are counted.
  const unseen = dropped + (why?.omitted ?? 0);
  const total = (why?.total ?? hits.length) + 0;

  const lines = [
    unseen > 0
      ? `Project memory has ${total} entries about ${target}, showing ${kept.length}:`
      : `Project memory has ${kept.length} entr${kept.length === 1 ? 'y' : 'ies'} about ${target}:`,
    ...kept,
  ];
  if (unseen > 0) lines.push(`${unseen} more not shown: dai_memory_why ${target}`);
  lines.push('Call dai_memory_why for the full reasoning before changing this.');

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n'),
    },
  });
}

/**
 * The one moment memory is worth the most.
 *
 * Not while exploring -- just before a change lands that may contradict a
 * decision somebody already made and wrote down. This fires on the `git commit`
 * itself, so it does not depend on the agent remembering that `memory changes`
 * exists.
 */
async function preCommit(cwd, payload) {
  const command = String(payload?.tool_input?.command ?? '');
  if (!/\bgit\b[^\n]*\bcommit\b/.test(command)) return;

  const report = await runCli(cwd, ['changes', '--scope', 'staged', '--json']);
  if (!report || report.covered?.length === 0) return;

  const lines = ['Project memory covers files in this commit:'];
  for (const entry of report.covered ?? []) {
    lines.push(`  ${entry.file}`);
    for (const memory of (entry.viaCalls ?? []).slice(0, 2)) {
      lines.push(`  [${memory.layer}] ${memory.title} (via a call into ${memory.reaches})`);
    }
    for (const memory of entry.memories.slice(0, 3)) {
      lines.push(`    - [${memory.layer}] ${memory.title}${memory.contested ? ' (CONTESTED)' : ''}`);
    }
  }
  if (report.contested > 0) {
    lines.push(
      `${report.contested} of these are contested. A person settles a contradiction, not the agent -- ` +
        'surface it before committing.',
    );
  }
  if ((report.uncovered ?? []).length > 0) {
    lines.push(`${report.uncovered.length} changed file(s) have nothing recorded.`);
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n'),
    },
  });
}

/** A failed command is the raw material for a RESOLVES edge later. */
async function postTool(cwd, payload) {
  if (process.env.MEMORY_LAYER_AUTO_RECORD !== '1') return;

  const response = payload?.tool_response ?? {};
  const failed = response.interrupted || (typeof response.exit_code === 'number' && response.exit_code !== 0);
  if (!failed) return;

  const command = String(payload?.tool_input?.command ?? '').slice(0, 200);
  const stderr = String(response.stderr ?? '').slice(0, 600);
  if (!command) return;

  const stamp = new Date().toISOString().slice(0, 10);
  await runCli(cwd, [
    'write',
    '--layer', 'episodic',
    '--title', `Command failed: ${command.split('\n')[0].slice(0, 80)}`,
    '--body', `Command: ${command}\n\nStderr:\n${stderr}`,
    '--source-ref', `session:${stamp}`,
  ]);
}

function hasStore(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.memory', 'meta.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Runs the CLI with a hard time budget.
 *
 * The child is killed on timeout and no grandchild is spawned, so a hook that
 * runs out of time cannot leave a process behind.
 */
async function runCli(cwd, args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, MEMORY_LAYER_LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      logFailure(new Error(`memory ${args[0]} exceeded ${BUDGET_MS}ms and was killed`));
    }, BUDGET_MS);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); logFailure(error); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logFailure(new Error(`memory ${args.join(' ')} exited ${code}: ${err.trim()}`));
        resolve(null);
        return;
      }
      resolve(safeParse(out));
    });
  });
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function exitQuiet() {
  process.exit(0);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Fail-open still writes it down; a hook that has been dead for a week must be findable. */
function logFailure(err) {
  try {
    const dir = process.env.MEMORY_LAYER_HOME || path.join(os.homedir(), '.memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'memory.log'),
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'error', message: `hook ${mode} failed`, detail: String(err?.stack ?? err) })}\n`,
    );
  } catch {
    // Nothing left to do; the session must continue regardless.
  }
}
