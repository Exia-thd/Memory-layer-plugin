import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');

/**
 * A throwaway git repository with its own registry home.
 *
 * Tests must never touch the developer's real registry, so MEMORY_LAYER_HOME is
 * redirected for every fixture.
 */
export function makeRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'));
  // Beside the repository, not inside it. A real MEMORY_LAYER_HOME lives in the
  // user's home directory; nesting it in the fixture meant a scan of the whole
  // tree indexed the registry file into every test store, which is a fixture
  // artifact no user could ever see.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memhome-'));

  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);

  return {
    dir,
    home,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function env(repo, extra = {}) {
  return {
    ...process.env,
    MEMORY_LAYER_HOME: repo.home,
    // The hash embedder is refused everywhere except a test run, and this is the
    // one place that declares one. It keeps the suite fast and off the network;
    // tests/real-model.test.js is where the shipped embedder is exercised.
    MEMORY_LAYER_EMBEDDINGS: 'hash',
    MEMORY_LAYER_TEST: '1',
    MEMORY_LAYER_LOG_LEVEL: 'error',
    ...extra,
  };
}

/** Runs the CLI, returning stdout, stderr and the exit code rather than throwing. */
export function cli(repo, args, options = {}) {
  const result = execFileSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo.dir,
    env: env(repo, options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A non-zero exit is data here, not a test failure.
    ...(options.allowFailure ? {} : {}),
  });
  return result;
}

export function cliRaw(repo, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? repo.dir,
    env: env(repo, options.env),
    encoding: 'utf8',
  });
}
