/**
 * Failures are surfaced, never swallowed (C3).
 *
 * Hooks are fail-open — a broken memory layer must not break the session — but
 * fail-open is not fail-silent: everything lands in a log a person can read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { globalDir } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.MEMORY_LAYER_LOG_LEVEL ?? 'info').toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

export function logFilePath(): string {
  return path.join(globalDir(), 'memory.log');
}

/**
 * Writes to the log file and, for warn/error, to stderr.
 *
 * stdout is reserved for MCP stdio framing; nothing here may ever write to it.
 */
export function log(level: LogLevel, message: string, detail?: unknown): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(detail === undefined ? {} : { detail: serialize(detail) }),
  });
  try {
    fs.mkdirSync(globalDir(), { recursive: true });
    fs.appendFileSync(logFilePath(), line + '\n');
  } catch {
    // The log itself must never be the thing that breaks a session.
  }
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
}

function serialize(detail: unknown): unknown {
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message, stack: detail.stack };
  }
  return detail;
}

/**
 * Runs `fn`, reporting any failure instead of hiding it, and returns `fallback`.
 *
 * Use only where continuing is genuinely correct. Anywhere a caller needs to know
 * the operation failed, let the error propagate.
 */
export async function failOpen<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log('error', `${what} failed (continuing)`, err);
    return fallback;
  }
}
