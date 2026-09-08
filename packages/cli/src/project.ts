import { execFileSync } from 'node:child_process';
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
    throw new Error(`No memory store found at or above ${from}. Run \`memory init\` first.`);
  }
  return new MemoryStore(dir, { readOnly: options.readOnly ?? false });
}

export function storeDirOrThrow(from: string = process.cwd()): string {
  const dir = locateStore(from);
  if (!dir) throw new Error(`No memory store found at or above ${from}. Run \`memory init\` first.`);
  return dir;
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
