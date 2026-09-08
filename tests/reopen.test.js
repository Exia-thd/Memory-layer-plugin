import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { awaitHandleRelease, HandleStillLockedError } from '@memory-layer/core';

/**
 * R2 -- reopening after a write, on Windows.
 *
 * The behaviour is Windows-specific and this suite runs on Linux, so the probe
 * is injected rather than provoked with a real lock. That tests the retry policy
 * and the platform gate honestly; it does not prove the race is gone on Windows,
 * and nothing here claims it does.
 */

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-'));
  const dbPath = path.join(dir, 'store.lbug');
  fs.writeFileSync(dbPath, 'db');
  fs.writeFileSync(`${dbPath}.wal`, 'wal');
  return { dir, dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const noSleep = async () => {};

test('R2-a: a handle that is still releasing is waited for, not reported', async () => {
  const f = fixture();
  try {
    let busyLeft = 3;
    const seen = [];
    const result = await awaitHandleRelease(f.dbPath, {
      platform: 'win32',
      sleep: noSleep,
      probe: (file) => {
        seen.push(file);
        if (busyLeft-- > 0) {
          const err = new Error('EBUSY: resource busy or locked');
          err.code = 'EBUSY';
          throw err;
        }
      },
    });

    assert.equal(result.skipped, false);
    assert.ok(result.attempts > 3, 'the probe did not retry');
    // Both files are probed: the write-ahead log is released after the main file,
    // so checking only the main file reports success too early.
    assert.ok(seen.includes(f.dbPath));
    assert.ok(seen.includes(`${f.dbPath}.wal`));
  } finally {
    f.cleanup();
  }
});

test('R2-b: a lock that never clears fails within budget, naming the likely cause', async () => {
  const f = fixture();
  try {
    let clock = 0;
    await assert.rejects(
      awaitHandleRelease(f.dbPath, {
        platform: 'win32',
        budgetMs: 250,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        probe: () => {
          const err = new Error('EBUSY');
          err.code = 'EBUSY';
          throw err;
        },
      }),
      (err) => {
        assert.ok(err instanceof HandleStillLockedError);
        // A permanently locked file on Windows is usually a scanner, and saying
        // so is the difference between a fixable report and a mystery.
        assert.match(err.message, /Defender|antivirus/i);
        return true;
      },
    );
    assert.ok(clock <= 250, `waited past the budget: ${clock}ms`);
  } finally {
    f.cleanup();
  }
});

test('R2-b2: a retry budget is spent on retries, not on one long sleep', async () => {
  const f = fixture();
  try {
    const sleeps = [];
    let clock = 0;
    await assert.rejects(
      awaitHandleRelease(f.dbPath, {
        platform: 'win32',
        budgetMs: 250,
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
        now: () => clock,
        probe: () => {
          const err = new Error('EBUSY');
          err.code = 'EBUSY';
          throw err;
        },
      }),
      HandleStillLockedError,
    );

    assert.ok(sleeps.length >= 4, `too few retries before giving up: ${sleeps.length}`);
    assert.ok(sleeps[1] >= sleeps[0], 'the backoff does not back off');
    assert.equal(sleeps.reduce((a, b) => a + b, 0) <= 250, true);
  } finally {
    f.cleanup();
  }
});

test('R2-c: an error that is not a lock is reported as itself', async () => {
  const f = fixture();
  try {
    // A missing file or a bad path must not be dressed up as a lock, or the
    // reader goes looking for an antivirus exclusion that was never the problem.
    await assert.rejects(
      awaitHandleRelease(f.dbPath, {
        platform: 'win32',
        sleep: noSleep,
        probe: () => {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        },
      }),
      /ENOENT/,
    );
  } finally {
    f.cleanup();
  }
});

test('R2-d: on Linux and macOS the probe never runs', async () => {
  const f = fixture();
  try {
    for (const platform of ['linux', 'darwin']) {
      let probed = 0;
      const result = await awaitHandleRelease(f.dbPath, {
        platform,
        probe: () => { probed += 1; },
      });
      assert.equal(result.skipped, true, `${platform} entered the Windows path`);
      assert.equal(probed, 0, `${platform} probed a handle it did not need to`);
    }
  } finally {
    f.cleanup();
  }
});

test('R2-e: a store with no write-ahead log yet is not a failure', async () => {
  const f = fixture();
  try {
    fs.rmSync(`${f.dbPath}.wal`);
    const seen = [];
    const result = await awaitHandleRelease(f.dbPath, {
      platform: 'win32',
      sleep: noSleep,
      probe: (file) => { seen.push(file); },
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(seen, [f.dbPath]);
  } finally {
    f.cleanup();
  }
});

test('R2-f: the real probe asks for write access, not read access', async () => {
  const f = fixture();
  try {
    // 'r' would be granted on Windows while an exclusive write lock is still in
    // flight. Guard the choice here so it cannot be relaxed to 'r' unnoticed.
    const source = fs.readFileSync(
      new URL('../packages/core/src/store/reopen.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /openSync\(file, 'r\+'\)/, 'the probe no longer requests write access');
  } finally {
    f.cleanup();
  }
});
