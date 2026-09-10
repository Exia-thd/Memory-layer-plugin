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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'packages', 'cli', 'dist', 'cli.js');
const BUDGET_MS = 7000;

const mode = process.argv[2];

try {
  const input = await readStdin();
  const payload = input ? safeParse(input) : {};
  const cwd = payload.cwd || process.cwd();

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
  const constraints = await runCli(cwd, ['constraints', '--limit', '5', '--json']);

  const lines = [];
  const found = constraints ?? [];
  if (found.length > 0) {
    lines.push('Active constraints recorded for this project:');
    for (const node of found) lines.push(`- ${node.title} (${node.sourceRef})`);
  }

  const unresolved = conflicts ?? [];
  if (unresolved.length > 0) {
    lines.push('', `${unresolved.length} unresolved contradiction(s) in project memory:`);
    for (const conflict of unresolved.slice(0, 5)) {
      lines.push(`- ${conflict.a.title}  <->  ${conflict.b.title}`);
    }
    lines.push('Run memory_conflicts for the full list before recording new decisions.');
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
  const why = await runCli(cwd, ['why', target, '--limit', '3', '--anchor-only', '--json']);
  const hits = why?.results ?? [];
  if (hits.length === 0) return;

  const lines = [`Project memory has ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} about ${target}:`];
  for (const hit of hits) {
    lines.push(`- [${hit.layer}] ${hit.title} (${hit.sourceRef})${hit.stale ? ' (recorded a while ago)' : ''}`);
  }
  lines.push('Call memory_why for the full reasoning before changing this.');

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
