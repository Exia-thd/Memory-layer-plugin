import fs from 'node:fs';
import path from 'node:path';
import type { MemoryStore } from './store/store.js';
import { pendingCount } from './store/journal.js';
import { summarizeCapability } from './store/capabilities.js';
import { identityLabel, type EmbeddingIdentity } from './embed/types.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: Check[];
  failed: boolean;
}

/**
 * The answer to "is this thing actually working".
 *
 * It exists because the failure mode that matters here is not a crash, it is a
 * store that looks fine and holds one node and no edges. Every check reports a
 * number rather than a reassurance.
 */
export async function doctor(
  store: MemoryStore,
  activeIdentity: EmbeddingIdentity | null,
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const meta = store.getMeta();

  let stats: Awaited<ReturnType<MemoryStore['stats']>> | null = null;
  try {
    stats = await store.stats();
    const bytes = directorySize(store.dir);
    checks.push({
      name: 'store',
      status: stats.nodes === 0 ? 'warn' : 'ok',
      detail:
        `${stats.nodes.toLocaleString()} nodes / ${stats.edges.toLocaleString()} edges / ` +
        `${(bytes / 1e6).toFixed(1)} MB` +
        (stats.nodes === 0 ? ' -- store is empty; run `memory ingest`' : ''),
    });
  } catch (err) {
    checks.push({
      name: 'store',
      status: 'fail',
      detail: `Cannot read the store: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const [name, capability] of Object.entries(meta.capabilities ?? {})) {
    checks.push({
      name,
      status: capability.status === 'available' ? 'ok' : capability.status === 'degraded' ? 'warn' : 'fail',
      detail: summarizeCapability(capability),
    });
  }

  if (stats) {
    const missing = stats.nodes - stats.embedded;
    checks.push({
      name: 'vectors',
      status: stats.nodes === 0 ? 'ok' : missing > 0 ? 'warn' : 'ok',
      detail:
        `${stats.embedded.toLocaleString()}/${stats.nodes.toLocaleString()} embedded` +
        (activeIdentity ? ` - active space ${identityLabel(activeIdentity)}` : ' - no active provider'),
    });

    // Two vector spaces in one store is the failure that costs recall while
    // looking completely healthy, so it is checked explicitly.
    const spaces = await vectorSpaces(store);
    if (spaces.size > 1) {
      checks.push({
        name: 'model drift',
        status: 'warn',
        detail:
          `${spaces.size} vector spaces present (${[...spaces.entries()]
            .map(([space, n]) => `${space}: ${n}`)
            .join(', ')}). Re-embed so one space covers the store.`,
      });
    } else if (activeIdentity && spaces.size === 1) {
      const [[space]] = [...spaces.entries()] as [[string, number]];
      checks.push({
        name: 'model drift',
        status: space === identityLabel(activeIdentity) ? 'ok' : 'warn',
        detail:
          space === identityLabel(activeIdentity)
            ? 'stored vectors match the active provider'
            : `stored vectors are ${space}, active provider is ${identityLabel(activeIdentity)}`,
      });
    }

    const orphans = await orphanCount(store);
    checks.push({
      name: 'orphans',
      status: orphans > 0 ? 'warn' : 'ok',
      detail: orphans > 0 ? `${orphans} nodes with no edges` : 'every node is connected',
    });
  }

  const pending = pendingCount(store.dir);
  checks.push({
    name: 'journal',
    status: pending > 0 ? 'warn' : 'ok',
    detail:
      pending > 0
        ? `${pending} writes queued and not yet searchable -- run \`memory merge\``
        : 'no queued writes',
  });

  return { checks, failed: checks.some((check) => check.status === 'fail') };
}

async function vectorSpaces(store: MemoryStore): Promise<Map<string, number>> {
  const rows = await store.query(
    `MATCH (m:Memory) WHERE m.embedding_model <> ''
     RETURN m.embedding_model AS model, m.embedding_dims AS dims,
            m.embedding_provider AS provider, count(*) AS n`,
  );
  const spaces = new Map<string, number>();
  for (const row of rows) {
    spaces.set(`${row.model}@${row.dims}/${row.provider}`, Number(row.n));
  }
  return spaces;
}

async function orphanCount(store: MemoryStore): Promise<number> {
  const nodes = await store.allNodes();
  const connected = new Set<string>();
  for (const edge of await store.allEdges()) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return nodes.filter((node) => !connected.has(node.id)).length;
}

function directorySize(dir: string): number {
  let total = 0;
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

export function formatReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.name.length)) + 2;
  return report.checks
    .map((check) => {
      const status = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'WARN' : 'FAIL';
      return `${check.name.padEnd(width)}${status}    ${check.detail}`;
    })
    .join('\n');
}
