import fs from 'node:fs';
import { log } from '../util/log.js';

/**
 * Waiting for a previous database handle to actually let go, on Windows.
 *
 * This exists because of how the read-only design works. Readers take a shared
 * lock and never block a writer, which is what removes the need for any
 * cross-platform process probing -- but it also means a reader must reopen when
 * the store moves on, and reopen is a close followed by an open. On Windows that
 * sequence races:
 *
 *   - A read-only probe is not enough to detect the race. Windows grants read
 *     access while a previous exclusive write lock is still in flight, so the
 *     probe says "free" and the next statement fails anyway. The probe has to
 *     ask for write access to learn the truth.
 *
 *   - The two files are released separately. The main database file lets go
 *     first; the write-ahead log lingers, and the first statement after reopen
 *     fails with "Could not set lock on file". Both have to be probed.
 *
 * On Linux and macOS none of this applies and the whole path is skipped.
 */
export class HandleStillLockedError extends Error {
  constructor(file: string, waitedMs: number) {
    super(
      `A previous handle on ${file} was still locked after ${waitedMs}ms. ` +
        `If this repeats, exclude the store directory from antivirus or Windows ` +
        `Defender scanning -- a scanner holding the file looks exactly like this.`,
    );
    this.name = 'HandleStillLockedError';
  }
}

/** Errors that mean "someone still has it", as opposed to a real problem. */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

export const DEFAULT_RELEASE_BUDGET_MS = 250;

export interface ReleaseOptions {
  budgetMs?: number;
  platform?: NodeJS.Platform;
  /** Injectable so the retry behaviour can be tested without a real lock. */
  probe?: (file: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReleaseResult {
  skipped: boolean;
  attempts: number;
  waitedMs: number;
}

/**
 * Opens each file for writing until it succeeds, or the budget runs out.
 *
 * Read-write, not read-only: a read probe on Windows succeeds against a handle
 * that has not finished releasing its write lock, which is the failure this is
 * here to catch.
 */
export async function awaitHandleRelease(
  dbPath: string,
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { skipped: true, attempts: 0, waitedMs: 0 };

  const budgetMs = options.budgetMs ?? DEFAULT_RELEASE_BUDGET_MS;
  const probe = options.probe ?? defaultProbe;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  const started = now();
  let attempts = 0;
  let delay = 5;

  // The write-ahead log is released after the main file, so checking only the
  // main file reports success while the next write is still going to fail.
  for (const file of [dbPath, `${dbPath}.wal`]) {
    if (!fs.existsSync(file)) continue;

    for (;;) {
      attempts += 1;
      try {
        probe(file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (!RETRYABLE.has(code)) {
          // Not a lock. Reporting it as one would send the reader chasing a
          // Defender exclusion for a missing file or a bad path.
          throw err;
        }

        const waited = now() - started;
        if (waited >= budgetMs) throw new HandleStillLockedError(file, waited);

        await sleep(Math.min(delay, budgetMs - waited));
        delay = Math.min(delay * 2, 40);
      }
    }
  }

  const waitedMs = now() - started;
  if (waitedMs > 0) {
    log('debug', `waited ${waitedMs}ms over ${attempts} probes for handles on ${dbPath}`);
  }
  return { skipped: false, attempts, waitedMs };
}

function defaultProbe(file: string): void {
  // 'r+' asks for write access without truncating. 'r' would be granted while an
  // exclusive write lock is still outstanding, which is precisely the case here.
  const handle = fs.openSync(file, 'r+');
  fs.closeSync(handle);
}
