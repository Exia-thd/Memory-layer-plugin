import path from 'node:path';
import os from 'node:os';

/**
 * Canonical form of a filesystem path, used as a pool/registry key.
 *
 * `C:\x` and `/c/x` name the same directory but are different strings; comparing raw
 * paths has broken a security gate before. Every keyed lookup goes through here.
 */
export function canonicalizePath(input: string): string {
  if (!input) return '';
  let p = input.trim();

  // Git-Bash / MSYS style: /c/Users/... -> C:/Users/...
  //
  // Only on Windows. On a POSIX system /c/Users is an ordinary directory and
  // rewriting it to a drive letter would collapse unrelated paths onto one key --
  // and every path whose first segment is a single letter, such as /a/project,
  // would be caught by it.
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])\/(.*)$/.exec(p);
    if (msys) p = `${msys[1]!.toUpperCase()}:/${msys[2]}`;
  }

  // Windows extended-length prefix.
  p = p.replace(/^\\\\\?\\/, '');

  p = p.replace(/\\/g, '/');

  // Drive letters are case-insensitive; normalise to upper.
  p = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);

  p = path.posix.normalize(p);

  // Trailing separator carries no meaning, except for a bare root.
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (/^[A-Z]:$/.test(p)) p = `${p}/`;

  return p;
}

/** Two paths naming the same location. */
export function samePath(a: string, b: string): boolean {
  return canonicalizePath(a) === canonicalizePath(b);
}

export const PLUGIN_DIR_NAME = '.memory';

/** Per-repo store directory. */
export function storeDirFor(projectRoot: string): string {
  return path.join(projectRoot, PLUGIN_DIR_NAME);
}

/** Global registry lives outside any repo. */
export function globalDir(): string {
  return process.env.MEMORY_LAYER_HOME
    ? path.resolve(process.env.MEMORY_LAYER_HOME)
    : path.join(os.homedir(), PLUGIN_DIR_NAME);
}

export function registryPath(): string {
  return path.join(globalDir(), 'registry.json');
}
