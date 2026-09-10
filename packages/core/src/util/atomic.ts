import fs from 'node:fs';

/**
 * Write-then-rename, with the retry Windows requires.
 *
 * POSIX rename over an existing file is atomic and cannot fail because someone
 * else has the destination open. Windows can: `MoveFileEx` fails with EPERM
 * while any process holds a handle on the target, and on a developer machine
 * something always might -- a virus scanner reading the file it just saw
 * created, the search indexer, a previous handle the runtime has not released.
 *
 * It is brief. Retrying a few times with a short backoff turns a hard failure
 * into a pause nobody notices, which is the right trade for a lock that is
 * measured in milliseconds and held by a process that is not ours.
 *
 * Not silent, and not infinite: after the last attempt the original error is
 * thrown. A store that could not record its own metadata must say so -- callers
 * of `writeMeta` warn that readers will not see the write, and that warning is
 * only true if this actually failed.
 *
 * Observed in this project four times in one test run, on `meta.json` and
 * `registry.json`, each time surfacing as an unrelated test failing: the error
 * appears at whatever command happened to trigger the write, so the failing
 * test name points away from the cause.
 */
export function writeFileAtomic(target: string, contents: string, attempts = 5): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      // Only a transient holder is worth waiting for. A missing directory or a
      // bad path will not become true by trying again.
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') break;
      if (attempt < attempts - 1) sleep(10 * 2 ** attempt);
    }
  }

  // Leave no half-written temporary behind for the next run to trip over.
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // Nothing useful to do; the rename failure below is the real news.
  }
  throw lastError;
}

/**
 * Blocks the thread briefly.
 *
 * These writes are synchronous by design -- callers treat metadata as written
 * once the call returns -- so the wait has to be synchronous too. It is tens of
 * milliseconds at most, and only on a path that has already failed once.
 */
function sleep(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Intentionally empty: Atomics.wait needs a SharedArrayBuffer and a worker,
    // which is a lot of machinery for a 10ms pause on an error path.
  }
}
