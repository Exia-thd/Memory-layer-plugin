/**
 * Whether the build is of the code that is here now.
 *
 * "Built" used to mean the compiled CLI existed. That is true on a machine that
 * built last month's code, and so updating the plugin -- which replaces the
 * sources and leaves `dist/` alone -- produced a plugin that reported itself
 * installed and ran the old version. Nothing said so; setup even skipped the
 * rebuild, because the file it looked for was there.
 *
 * So every build records a stamp of what it was built from: the sources, the
 * manifests and the lockfile. A lockfile change counts, because different
 * dependencies are a different program even when no source line moved.
 *
 * Checked in two tiers, because the hook asks on every Read, Grep and Glob. Size
 * and modification time first, which is a stat per file and nothing more; only
 * when those differ are contents hashed, because a checkout or a copy can touch
 * a file without changing it. Hashing everything outright measured 15 ms here --
 * affordable once, not on every file the agent opens.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIRS = ['packages/core/src', 'packages/cli/src'];
const MANIFESTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
];

export const STAMP_RELATIVE = 'packages/cli/dist/.build-stamp.json';

/** Every build input, relative and sorted, so the same tree always lists the same way. */
function inputs(root) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  for (const file of MANIFESTS) if (fs.existsSync(path.join(root, file))) found.push(file);
  return found.sort();
}

function statSignature(root, files) {
  return files.map((file) => {
    const stat = fs.statSync(path.join(root, file));
    return `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  });
}

function contentHash(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Records what the build in `dist/` was built from. Called at the end of every build. */
export function writeStamp(root) {
  const files = inputs(root);
  const stamp = { hash: contentHash(root, files), stats: statSignature(root, files), files: files.length };
  fs.writeFileSync(path.join(root, STAMP_RELATIVE), `${JSON.stringify(stamp)}\n`);
  return stamp;
}

/**
 * `{ fresh: true }`, or `{ fresh: false, reason }` in words.
 *
 * A build with no stamp is not fresh: it came from before stamps existed or from
 * something other than the build script, and either way nothing vouches for what
 * it was built from.
 */
export function buildFreshness(root) {
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(root, STAMP_RELATIVE), 'utf8'));
  } catch {
    return { fresh: false, reason: 'the build carries no record of the code it was built from' };
  }

  const files = inputs(root);
  const stats = statSignature(root, files);
  if (stats.length === stamp.stats?.length && stats.every((line, i) => line === stamp.stats[i])) {
    return { fresh: true, reason: null };
  }
  if (contentHash(root, files) === stamp.hash) return { fresh: true, reason: null };
  return { fresh: false, reason: 'the code has changed since it was built' };
}

// Run directly, as the last step of `pnpm build`, it stamps this checkout.
//
// Compared through fileURLToPath rather than the URL's pathname: a pathname is
// percent-encoded, so under a directory with a space in its name the two never
// matched, no stamp was written, and every build would read as stale.
const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const stamp = writeStamp(path.resolve(path.dirname(here), '..'));
  process.stdout.write(`build stamped: ${stamp.files} inputs\n`);
}
