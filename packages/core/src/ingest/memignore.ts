import fs from 'node:fs';
import path from 'node:path';

/**
 * A project's own answer to what should stay out of memory.
 *
 * The built-in lists are guesses about repositories in general, and a guess
 * about repositories in general is wrong about every particular one. A layout
 * with several checkouts beside a shared docs tree, a directory of exports
 * nobody wants indexed, a generated client that is technically source -- none
 * of that is knowable from here, and all of it is obvious to the person who
 * made it.
 *
 * The syntax is gitignore's, minus the parts that mislead more than they help:
 * blank lines and `#` comments are skipped, a trailing `/` means directories
 * only, a leading `/` anchors to the repository root, `!` negates an earlier
 * pattern, and `*` `?` `**` behave as expected. Ranges (`[a-z]`) are not
 * supported and are matched literally, which is worth knowing before writing
 * one.
 *
 * It never overrules a path named outright. `dai-memory ingest docs/figma` reads
 * that directory whatever this file says -- an explicit instruction from the
 * person running the command outranks a standing one they wrote earlier.
 */
export interface IgnoreRule {
  /** The pattern as written, for reporting. */
  source: string;
  /** Compiled matcher against a repository-relative, forward-slashed path. */
  test: RegExp;
  directoryOnly: boolean;
  negated: boolean;
}

export interface MemIgnore {
  rules: IgnoreRule[];
  /** Where the rules came from, or null when there is no file. */
  file: string | null;
}

export const MEMIGNORE_FILE = '.memignore';

export function loadMemIgnore(root: string): MemIgnore {
  const file = path.join(root, MEMIGNORE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rules: [], file: null };
  }

  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    const body = negated ? line.slice(1) : line;
    if (!body) continue;

    const directoryOnly = body.endsWith('/');
    const pattern = directoryOnly ? body.slice(0, -1) : body;
    rules.push({ source: line, test: compile(pattern), directoryOnly, negated });
  }
  return { rules, file: rules.length > 0 ? file : null };
}

/**
 * Whether a repository-relative path is ignored.
 *
 * Later rules win, so a `!` line undoes an earlier match -- the ordering
 * gitignore uses, and the one people expect when they write an exception under
 * a broad pattern.
 */
export function isIgnored(ignore: MemIgnore, relative: string, isDirectory: boolean): IgnoreRule | null {
  if (ignore.rules.length === 0) return null;

  const target = relative.split(path.sep).join('/');
  let matched: IgnoreRule | null = null;
  for (const rule of ignore.rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (!rule.test.test(target)) continue;
    matched = rule.negated ? null : rule;
  }
  return matched;
}

/**
 * Turns one gitignore-style pattern into a regular expression.
 *
 * A pattern with no slash matches at any depth -- `*.log` means every log file,
 * not only the ones beside the ignore file. A pattern with a slash is anchored
 * to the root, which is why `/dist` and `dist` differ.
 */
function compile(pattern: string): RegExp {
  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  const hasSlash = body.includes('/');

  let expression = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` crosses directories; a bare `**` behaves the same here.
        expression += '.*';
        i += 1;
        if (body[i + 1] === '/') i += 1;
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      expression += '[^/]';
      continue;
    }
    expression += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  // Anything under a matched directory is matched too, which is what makes
  // `build/` exclude the tree rather than only the directory entry itself.
  const tail = '(?:/.*)?$';
  return anchored || hasSlash
    ? new RegExp(`^${expression}${tail}`)
    : new RegExp(`(?:^|/)${expression}${tail}`);
}
