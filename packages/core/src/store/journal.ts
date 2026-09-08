import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MemoryEdge, MemoryNode } from '../types.js';
import { log } from '../util/log.js';

/**
 * The write path for anything that cannot be sure it owns the store.
 *
 * Writes to LadybugDB are exclusive, and a session hook has no way to know
 * whether another session is mid-write. Rather than probe for the lock -- which
 * is where the multi-platform process-inspection rabbit hole starts -- each
 * session appends to its own file and a later merge folds them in.
 *
 * The trade-off is real and is stated plainly: a write is not visible to search
 * until it merges. `memory doctor` reports pending entries so the lag is never
 * invisible.
 */
export interface JournalEntry {
  kind: 'node' | 'edge';
  at: number;
  node?: MemoryNode;
  edge?: MemoryEdge;
}

function journalDir(storeDir: string): string {
  return path.join(storeDir, 'journal');
}

function sessionFile(storeDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return path.join(journalDir(storeDir), `${safe}.jsonl`);
}

export function currentSessionId(): string {
  return (
    process.env.MEMORY_LAYER_SESSION_ID ??
    process.env.CLAUDE_SESSION_ID ??
    `pid-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
}

export function appendNode(storeDir: string, node: MemoryNode, sessionId = currentSessionId()): void {
  append(storeDir, sessionId, { kind: 'node', at: Date.now(), node });
}

export function appendEdge(storeDir: string, edge: MemoryEdge, sessionId = currentSessionId()): void {
  append(storeDir, sessionId, { kind: 'edge', at: Date.now(), edge });
}

function append(storeDir: string, sessionId: string, entry: JournalEntry): void {
  fs.mkdirSync(journalDir(storeDir), { recursive: true });
  fs.appendFileSync(sessionFile(storeDir, sessionId), `${JSON.stringify(entry)}\n`);
}

export function pendingFiles(storeDir: string): string[] {
  const dir = journalDir(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

export function pendingCount(storeDir: string): number {
  let total = 0;
  for (const file of pendingFiles(storeDir)) {
    total += readEntries(file).length;
  }
  return total;
}

/**
 * A malformed line is skipped and reported rather than aborting the merge: one
 * bad append should not strand every other memory in the file.
 */
export function readEntries(file: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch (err) {
      log('warn', `skipping malformed journal line ${file}:${index + 1}`, err);
    }
  }
  return entries;
}

export function discard(file: string): void {
  fs.rmSync(file, { force: true });
}
