import fs from 'node:fs';
import path from 'node:path';
import { canonicalizePath, globalDir, registryPath, storeDirFor } from '../util/paths.js';

/** One registered project. The file itself is a bare JSON array of these. */
export interface RegistryEntry {
  name: string;
  path: string;
  storagePath: string;
  remoteUrl?: string | null;
  branch?: string | null;
  lastCommit?: string | null;
  indexedAt?: string;
  stats?: { nodes: number; edges: number; embedded: number };
}

export function readRegistry(): RegistryEntry[] {
  const file = registryPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as RegistryEntry[]) : [];
  } catch {
    // A corrupt registry must not take the CLI down with it; it is a cache of
    // locations, and every entry can be rebuilt by re-registering.
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  fs.mkdirSync(globalDir(), { recursive: true });
  const tmp = `${registryPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, registryPath());
}

/** Registers a project, or updates the entry already holding that path. */
export function upsertProject(entry: RegistryEntry): RegistryEntry[] {
  const entries = readRegistry();
  const key = canonicalizePath(entry.path);
  const index = entries.findIndex((e) => canonicalizePath(e.path) === key);
  if (index >= 0) entries[index] = { ...entries[index], ...entry };
  else entries.push(entry);
  writeRegistry(entries);
  return entries;
}

export function forgetProject(projectPath: string): boolean {
  const key = canonicalizePath(projectPath);
  const entries = readRegistry();
  const kept = entries.filter((e) => canonicalizePath(e.path) !== key);
  if (kept.length === entries.length) return false;
  writeRegistry(kept);
  return true;
}

export function findProject(projectPath: string): RegistryEntry | undefined {
  const key = canonicalizePath(projectPath);
  return readRegistry().find((e) => canonicalizePath(e.path) === key);
}

export function findProjectByName(name: string): RegistryEntry | undefined {
  return readRegistry().find((e) => e.name === name);
}

/** Walks up from `start` to the nearest directory holding a store. */
export function locateStore(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(storeDirFor(dir), 'meta.json'))) return storeDirFor(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
