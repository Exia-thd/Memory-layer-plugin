import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { locateStore, storeDirFor, MemoryStore, readMeta } from '@memory-layer/core';

export interface ProjectInfo {
  root: string;
  name: string;
  remoteUrl: string | null;
  branch: string | null;
  lastCommit: string | null;
}

/**
 * Every git invocation checks its exit status.
 *
 * A subprocess whose result is never inspected is how an index ends up with one
 * node and no edges while every command reports success.
 */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Which files the working tree has changed, relative to the repository root.
 *
 * Three scopes, because the useful question changes with the moment: what is
 * about to be committed, everything touched since the last commit, or how this
 * branch differs from where it started.
 */
export function changedFiles(root: string, scope: 'staged' | 'working' | 'compare', baseRef?: string): string[] | null {
  const args =
    scope === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
      : scope === 'compare'
        ? ['diff', '--name-only', '--diff-filter=ACMR', `${baseRef ?? 'HEAD'}...HEAD`]
        : ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'];

  const out = git(args, root);
  // null means git itself failed -- an unborn branch, a bad ref, not a repo.
  // That is not the same as "nothing changed", and the caller must not read it
  // as an all-clear.
  if (out === null) return null;

  const tracked = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (scope !== 'working') return unique(tracked);

  // Untracked files carry no history, so a decision recorded against one is the
  // only record that exists. Leaving them out is exactly the wrong bias.
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root) ?? '';
  return unique([...tracked, ...untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)]);
}

function unique(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/**
 * Where a project keeps the things worth remembering.
 *
 * Installing into a codebase that already exists is the case this layer is for,
 * and asking somebody to guess which paths to feed it is asking them to do the
 * work twice. These are the conventional homes for documentation, decisions and
 * source; whatever exists gets scanned, and `init` reports what it found so the
 * guess is visible rather than silent.
 *
 * Deliberately no bare '.': scanning a whole repository picks up vendored code,
 * build output and anything else the ignore rules did not anticipate, and the
 * first thing a new user would see is a store full of noise.
 */
const SCAN_CANDIDATES = [
  'docs', 'doc', 'documentation', 'adr', 'adrs', 'rfc', 'rfcs',
  // Both spellings, everywhere. `app` was here without `apps`, so the more
  // common of the two was the one the scan could not see.
  'src', 'lib', 'libs', 'app', 'apps', 'packages', 'package',
  'internal', 'pkg', 'cmd', 'service', 'services',
  'README.rst',
];

/** What a directory holds when it is a project rather than a pile of files. */
const PROJECT_MARKERS = [
  '.git', 'package.json', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'pom.xml', 'build.gradle', 'Cargo.toml', 'composer.json', 'Gemfile',
  '*.csproj', 'src', 'lib', 'app',
];

/** Directories that are never a project of the user's, whatever they contain. */
const NEVER_A_PROJECT = new Set([
  'node_modules', 'dist', 'build', 'target', 'coverage', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.cache', '.memory', '.git',
]);

function looksLikeProject(dir: string): string | null {
  for (const marker of PROJECT_MARKERS) {
    if (marker === '*.csproj') {
      const found = nodeFs
        .readdirSync(dir, { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.endsWith('.csproj'));
      if (found) return found.name;
      continue;
    }
    if (nodeFs.existsSync(nodePath.join(dir, marker))) return marker;
  }
  return null;
}

export interface ScanTarget {
  path: string;
  /** Why it was chosen, so a guess can be checked at a glance rather than trusted. */
  reason: string;
}

/**
 * What to scan when the user names nothing.
 *
 * A conventional-name list alone is blind to the layout people actually keep:
 * a working directory holding several checkouts plus one shared docs tree. The
 * names are the user's own -- `repoA`, `bestmed-core` -- and no list will ever
 * contain them. So a directory that is not recognised by name gets looked into
 * once, and is taken if it carries a marker of being a project.
 *
 * One level, and a stated reason for every choice. Scanning everything would
 * also find those repositories, and would find `backup-2024` and `vendor` and a
 * downloads folder with them -- a store full of noise on the first run, which
 * is harder to notice than a store missing something.
 */
export function scanTargets(root: string): string[] {
  return describeScanTargets(root).map((target) => target.path);
}

export function describeScanTargets(root: string): ScanTarget[] {
  const chosen = new Map<string, ScanTarget>();

  for (const candidate of SCAN_CANDIDATES) {
    if (nodeFs.existsSync(nodePath.join(root, candidate))) {
      chosen.set(candidate, { path: candidate, reason: 'conventional name' });
    }
  }

  // Every markdown file at the root, by rule rather than by name.
  //
  // The list used to name five of them, and `CLAUDE.md` was not among the five
  // -- the file holding this project's own constraints, which is close to the
  // most relevant document a memory layer could read, silently outside the
  // scan. Any list of filenames has that failure waiting in it: the next
  // convention (`AGENTS.md`, and whatever follows it) arrives already missing.
  // Markdown at the root is written by people, for people, about this project.
  // There is no version of that which is not worth reading.
  try {
    for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(md|markdown|mdx)$/i.test(entry.name)) continue;
      chosen.set(entry.name, { path: entry.name, reason: 'markdown' });
    }
  } catch {
    // An unreadable root is reported by the caller that tries to scan it.
  }

  let entries: nodeFs.Dirent[] = [];
  try {
    entries = nodeFs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [...chosen.values()];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (chosen.has(entry.name)) continue;
    if (entry.name.startsWith('.') || NEVER_A_PROJECT.has(entry.name)) continue;

    let marker: string | null = null;
    try {
      marker = looksLikeProject(nodePath.join(root, entry.name));
    } catch {
      continue;
    }
    if (marker) chosen.set(entry.name, { path: entry.name, reason: marker });
  }

  return [...chosen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolves the project from a directory, refusing to guess when it is not a repo. */
export function resolveProject(from: string = process.cwd()): ProjectInfo {
  const root = git(['rev-parse', '--show-toplevel'], from);
  if (!root) {
    throw new Error(
      `${from} is not inside a git repository. Memory is scoped to a repository; ` +
        `run this from one rather than having a directory guessed for you.`,
    );
  }
  const resolved = path.resolve(root);
  return {
    root: resolved,
    name: path.basename(resolved),
    remoteUrl: git(['remote', 'get-url', 'origin'], resolved),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], resolved),
    lastCommit: git(['rev-parse', 'HEAD'], resolved),
  };
}

export function currentCommit(root: string): string | null {
  return git(['rev-parse', 'HEAD'], root);
}

/** Opens the nearest store. Read-only handles take a shared lock and never block a writer. */
export async function openStore(options: { readOnly?: boolean; from?: string } = {}): Promise<MemoryStore> {
  const from = options.from ?? process.cwd();
  const dir = locateStore(from);
  if (!dir) {
    throw new Error(`No memory store found at or above ${from}. Run \`dai-memory init\` first.`);
  }
  return new MemoryStore(dir, { readOnly: options.readOnly ?? false });
}

export function storeDirOrThrow(from: string = process.cwd()): string {
  const dir = locateStore(from);
  if (!dir) throw new Error(`No memory store found at or above ${from}. Run \`dai-memory init\` first.`);
  return dir;
}

const execFileAsync = promisify(execFile);

/**
 * The async twin of `git`, for checking many repositories at once.
 *
 * Each check spawns a process, so doing them one after another costs the sum of
 * all of them: a registry with a couple of hundred projects turns a listing into
 * a minute of waiting. Parallel with a cap keeps it flat without forking the
 * whole registry at once.
 */
async function gitAsync(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface Staleness {
  stale: boolean;
  indexed: string | null;
  head: string | null;
  /** Set when the check could not run at all -- a moved or deleted repository. */
  unavailable?: string;
}

/** Staleness for one store, never throwing: a broken entry must not sink a listing. */
export async function isStaleAsync(storeDir: string): Promise<Staleness> {
  try {
    const meta = readMeta(storeDir);
    if (!fs.existsSync(meta.projectRoot)) {
      return { stale: false, indexed: meta.lastCommit ?? null, head: null, unavailable: 'project directory is gone' };
    }
    const head = await gitAsync(['rev-parse', 'HEAD'], meta.projectRoot);
    if (!head) {
      return { stale: false, indexed: meta.lastCommit ?? null, head: null, unavailable: 'not a git repository any more' };
    }
    return { stale: Boolean(meta.lastCommit && head !== meta.lastCommit), indexed: meta.lastCommit ?? null, head };
  } catch (err) {
    return {
      stale: false, indexed: null, head: null,
      unavailable: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
}

/** True when the store was built against a commit that is no longer HEAD. */
export function isStale(storeDir: string): { stale: boolean; indexed: string | null; head: string | null } {
  const meta = readMeta(storeDir);
  const head = currentCommit(meta.projectRoot);
  return { stale: Boolean(head && meta.lastCommit && head !== meta.lastCommit), indexed: meta.lastCommit ?? null, head };
}

export function ensureGitignore(root: string, entry: string): void {
  const file = path.join(root, '.gitignore');
  const line = `${entry}/`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split('\n').some((l) => l.trim() === line || l.trim() === entry)) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}\n# Local memory store (binary, machine-specific)\n${line}\n`);
}

export { storeDirFor };
