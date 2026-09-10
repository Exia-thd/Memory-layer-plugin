import { createRequire } from 'node:module';

/**
 * The native binding, loaded on first use rather than on import.
 *
 * `@ladybugdb/core` pulls a platform binary in at require time, and that alone
 * was 500ms of every command -- including `memory --help`, which never opens a
 * database. Argument parsing, help text and configuration errors have no reason
 * to pay for it.
 */
const require = createRequire(import.meta.url);

type LbugModule = typeof import('@ladybugdb/core');

let lbug: LbugModule | null = null;

export function nativeLbug(): LbugModule {
  if (!lbug) lbug = require('@ladybugdb/core') as LbugModule;
  return lbug;
}
