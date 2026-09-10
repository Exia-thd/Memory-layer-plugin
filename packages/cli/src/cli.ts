#!/usr/bin/env node
import {
  formatReport, forgetProject, LAYERS, EDGE_TYPES,
  type Layer, type EdgeType,
} from '@memory-layer/core';
import * as api from './api.js';
import { resolveProject, storeDirOrThrow } from './project.js';
// Imported where it is used, not at the top.
//
// `mcp.js` drags in the MCP SDK, which cost 290ms on every command that is not
// `serve` -- `memory --help` included. One command needs it; the rest were
// paying for it.

/**
 * Every command returns a process exit code, and a failure exits non-zero with
 * the reason on stderr. A command that fails quietly is worse than one that
 * crashes, because the caller carries on believing the work happened.
 */

const USAGE = `memory - project memory layer

  memory init [--dims N]              create the store here and report what works
  memory ingest <paths...> [--layer L] [--force] [--no-embed]
  memory embed [--force]              embed nodes missing a current vector
  memory search <query> [--limit N] [--layer L] [--json]
  memory why <file|symbol> [--json]   decisions and constraints touching it
  memory get <id> [--json]            one node plus its direct edges
  memory graph <id> [--depth N] [--edge TYPE] [--json]
  memory constraints [--limit N]      decisions in force, most important first
  memory changes [--scope S] [--base R]  what memory records about your changed files
  memory map [path] [--format tree|mermaid]  the code graph: files, declarations, memory
  memory session start <label> | end [--summary S] | (none)   open, close or show the session
  memory summarize <clusterId> --body S   record a summary for a group of memories
  memory conflicts [--json]           contradictions needing a person
  memory clusters [--json]            communities in the memory graph
  memory write --layer L --title T --body B --source-ref R [--link ID:TYPE]
  memory link <from> <to> <TYPE> [--weight W]
  memory merge                        fold queued session writes into the store
  memory doctor [--json]              what is actually working
  memory list                         registered projects
  memory forget [path]                drop a project from the registry
  memory serve                        MCP server on stdio

layers: ${LAYERS.join(', ')}
edges:  ${EDGE_TYPES.join(', ')}`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(args: Args, name: string): number | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} expects a number, got ${JSON.stringify(value)}`);
  return parsed;
}

function layerFlag(args: Args, name = 'layer'): Layer | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  if (!LAYERS.includes(value as Layer)) {
    throw new Error(`Unknown layer ${JSON.stringify(value)}. Known: ${LAYERS.join(', ')}`);
  }
  return value as Layer;
}

function edgeType(value: string): EdgeType {
  if (!EDGE_TYPES.includes(value as EdgeType)) {
    throw new Error(`Unknown edge type ${JSON.stringify(value)}. Known: ${EDGE_TYPES.join(', ')}`);
  }
  return value as EdgeType;
}

function emit(args: Args, data: unknown, text: () => string): void {
  if (args.flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${text()}\n`);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || command === 'help' || command === '--help' || args.flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  switch (command) {
    case 'init': {
      const { storeDir, report } = await api.init({ dimensions: stringFlag(args, 'dims') });
      process.stdout.write(`store created at ${storeDir}\n\n${formatReport(report)}\n`);
      if (report.failed) {
        process.stderr.write('\ninit finished with failing checks; fix them before relying on search.\n');
        return 1;
      }
      return 0;
    }

    case 'ingest': {
      if (args.positional.length === 0) throw new Error('ingest needs at least one path');
      const report = await api.runIngest(args.positional, {
        layer: layerFlag(args),
        force: Boolean(args.flags.force),
        embed: !args.flags['no-embed'],
      });
      emit(args, report, () =>
        `ingested ${report.files} files (${report.skipped} unchanged) -> ` +
        `${report.created} new, ${report.refreshed} refreshed, ${report.embedded} embedded` +
        (report.redactions.length > 0
          ? `\nredacted: ${report.redactions.map((r) => `${r.rule} x${r.count}`).join(', ')}`
          : ''),
      );
      return 0;
    }

    case 'embed': {
      const result = await api.runEmbed({ force: Boolean(args.flags.force) });
      emit(args, result, () => `embedded ${result.embedded}, already current ${result.skipped}`);
      return 0;
    }

    case 'search': {
      const query = args.positional.join(' ');
      if (!query) throw new Error('search needs a query');
      const result = await api.runSearch(query, {
        limit: numberFlag(args, 'limit'),
        layers: layerFlag(args) ? [layerFlag(args)!] : undefined,
        disableBm25: Boolean(args.flags['no-bm25']),
      });
      emit(args, result, () => formatSearch(result));
      return 0;
    }

    case 'why': {
      const target = args.positional[0];
      if (!target) throw new Error('why needs a file path or symbol');
      const result = await api.runWhy(target, {
        limit: numberFlag(args, 'limit'),
        anchorOnly: Boolean(args.flags['anchor-only']),
      });
      emit(args, result, () => formatSearch(result));
      return 0;
    }

    case 'get': {
      const id = args.positional[0];
      if (!id) throw new Error('get needs a node id');
      const found = await api.runGet(id);
      if (!found) {
        process.stderr.write(`no such node: ${id}\n`);
        return 1;
      }
      emit(args, found, () =>
        `${found.node.title}\n${found.node.layer} - ${found.node.sourceRef}\n\n${found.node.body}\n\n` +
        `edges (${found.edges.length}):\n` +
        found.edges.map((e) => `  ${e.from} -[${e.type}]-> ${e.to}`).join('\n'),
      );
      return 0;
    }

    case 'graph': {
      const id = args.positional[0];
      if (!id) throw new Error('graph needs a node id');
      const edge = stringFlag(args, 'edge');
      const subgraph = await api.runNeighbors(id, {
        depth: numberFlag(args, 'depth'),
        edgeTypes: edge ? [edgeType(edge)] : undefined,
      });
      emit(args, subgraph, () =>
        `${subgraph.root.title}  (depth ${subgraph.depth}, ${subgraph.neighbors.length} neighbours)\n` +
        subgraph.neighbors
          .map((n) => `  ${'  '.repeat(n.hops - 1)}[${n.hops}] ${n.node.title}  <${n.via.map((v) => v.type).join(',')}>`)
          .join('\n'),
      );
      return 0;
    }

    case 'constraints': {
      const found = await api.runConstraints({ limit: numberFlag(args, 'limit') });
      emit(args, found, () =>
        found.length === 0
          ? 'no constraints recorded'
          : found.map((n) => `[${n.importance}] ${n.title}\n    ${n.sourceRef}`).join('\n'),
      );
      return 0;
    }

    case 'session': {
      const [action, ...rest] = args.positional;
      if (action === 'start') {
        const label = rest.join(' ') || 'untitled';
        const started = await api.runSessionStart(label);
        emit(args, started, () => `session ${started.label} open (${started.id})`);
        return 0;
      }
      if (action === 'end') {
        const closed = await api.runSessionEnd({ summary: stringFlag(args, 'summary') });
        emit(args, closed, () => (closed.closed ? `session closed (${closed.closed})` : 'no session open'));
        return 0;
      }
      const open = api.currentSession(storeDirOrThrow());
      emit(args, { open }, () => (open ? `${open.label} (${open.id})` : 'no session open'));
      return 0;
    }

    case 'map': {
      const { runMap, formatMapTree, formatMapMermaid } = await import('./map.js');
      const map = await runMap({ prefix: args.positional[0] });
      const format = stringFlag(args, 'format') ?? 'tree';
      emit(args, map, () =>
        format === 'mermaid' ? formatMapMermaid(map) : formatMapTree(map),
      );
      return 0;
    }

    case 'changes': {
      const scope = (stringFlag(args, 'scope') ?? 'staged') as 'staged' | 'working' | 'compare';
      const report = await api.runChanges({ scope, baseRef: stringFlag(args, 'base') });
      emit(args, report, () => {
        if (report.changed.length === 0) return `no ${report.scope} changes`;
        const lines: string[] = [];
        for (const entry of report.covered) {
          lines.push(entry.file);
          for (const memory of entry.memories) {
            const mark = memory.contested ? ' [CONTESTED]' : '';
            lines.push(`    [${memory.layer}] ${memory.title}${mark}`);
            lines.push(`        ${memory.sourceRef}`);
          }
          if (entry.omitted > 0) {
            lines.push(`    ... and ${entry.omitted} more, not shown`);
          }
        }
        if (report.uncovered.length > 0) {
          lines.push(`${report.uncovered.length} changed file(s) with nothing recorded:`);
          for (const file of report.uncovered) lines.push(`    ${file}`);
        }
        if (report.contested > 0) {
          lines.push(`${report.contested} of these memories are contested -- settle them before committing.`);
        }
        return lines.join('\n');
      });
      return 0;
    }

    case 'conflicts': {
      const found = await api.runConflicts();
      emit(args, found, () =>
        found.length === 0
          ? 'no conflicts'
          : found.map((c) => `${c.kind}: ${c.a.title}\n          vs ${c.b.title}`).join('\n'),
      );
      return 0;
    }

    case 'clusters': {
      const found = await api.runClusters();
      emit(args, found, () =>
        found.length === 0
          ? 'no clusters (the graph has too few edges)'
          : found
              .map((c) => `#${c.id} (${c.size}) ${c.terms.join(' ')}\n${c.representatives.map((r) => `    ${r.title}`).join('\n')}`)
              .join('\n'),
      );
      return 0;
    }

    case 'summarize': {
      const [rawId] = args.positional;
      const body = stringFlag(args, 'body');
      if (!rawId || !body) throw new Error('summarize needs <clusterId> and --body');
      const result = await api.runSummarize(Number(rawId), body, { title: stringFlag(args, 'title') });
      emit(args, result, () => `summary ${result.id} covers ${result.covers} memories`);
      return 0;
    }

    case 'write': {
      const layer = layerFlag(args);
      const title = stringFlag(args, 'title');
      const body = stringFlag(args, 'body');
      const sourceRef = stringFlag(args, 'source-ref');
      if (!layer || !title || !body || !sourceRef) {
        throw new Error('write needs --layer, --title, --body and --source-ref');
      }
      const links = (Array.isArray(args.flags.link) ? args.flags.link : [args.flags.link])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => {
          const [to, type] = value.split(':');
          if (!to || !type) throw new Error(`--link expects ID:TYPE, got ${JSON.stringify(value)}`);
          return { to, type: edgeType(type) };
        });

      const result = await api.runWrite({ layer, title, body, sourceRef, links });
      emit(args, result, () =>
        `${result.id}${result.queued ? ' (queued: the store was locked, run `memory merge`)' : ''}` +
        (result.redactions.length > 0
          ? `\nredacted: ${result.redactions.map((r) => `${r.rule} x${r.count}`).join(', ')}`
          : ''),
      );
      return 0;
    }

    case 'link': {
      const [from, to, type] = args.positional;
      if (!from || !to || !type) throw new Error('link needs <from> <to> <TYPE>');
      const result = await api.runLink(from, to, edgeType(type), { weight: numberFlag(args, 'weight') });
      emit(args, result, () => (result.queued ? 'queued (store locked)' : 'linked'));
      return 0;
    }

    case 'merge': {
      const result = await api.runMerge();
      emit(args, result, () =>
        result.skipped
          ? `not merged: ${result.skipped}`
          : `merged ${result.merged} entries from ${result.files} session journals`,
      );
      return result.skipped ? 1 : 0;
    }

    case 'doctor': {
      const report = await api.runDoctor();
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatReport(report)}\n`);
        if (report.stale.stale) {
          process.stdout.write(
            `index         WARN    built at ${report.stale.indexed?.slice(0, 8)}, HEAD is ` +
              `${report.stale.head?.slice(0, 8)} -- re-run \`memory ingest\`\n`,
          );
        }
      }
      return report.failed ? 1 : 0;
    }

    case 'register': {
      const project = resolveProject();
      process.stdout.write(`${project.name} at ${project.root}\n`);
      return 0;
    }

    case 'list': {
      const entries = await api.runList();
      emit(args, entries, () =>
        entries.length === 0
          ? 'no registered projects'
          : entries
              .map((e) => {
                const nodes = e.stats ? `${e.stats.nodes} nodes` : 'not indexed';
                const state = e.freshness.unavailable
                  ? `unreachable: ${e.freshness.unavailable}`
                  : e.freshness.stale
                    ? 'STALE - re-run `memory ingest`'
                    : 'current';
                return `${e.name.padEnd(24)}${nodes.padEnd(16)}${state.padEnd(34)}${e.path}`;
              })
              .join('\n'),
      );
      return 0;
    }

    case 'forget': {
      const target = args.positional[0] ?? resolveProject().root;
      const removed = forgetProject(target);
      process.stdout.write(removed ? `forgot ${target}\n` : `not registered: ${target}\n`);
      return removed ? 0 : 1;
    }

    case 'serve': {
      const { serve } = await import('./mcp.js');
      await serve();
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
      return 2;
  }
}

function formatSearch(result: { results: { title: string; layer: string; sourceRef: string; snippet?: string; score: number; stale?: boolean }[]; fusion: { branches: Record<string, number>; degraded: string[]; reasons: Record<string, string> } }): string {
  const lines: string[] = [];

  for (const [index, hit] of result.results.entries()) {
    lines.push(
      `${String(index + 1).padStart(2)}. [${hit.layer}] ${hit.title}${hit.stale ? '  (stale)' : ''}`,
      `    ${hit.sourceRef}`,
    );
    if (hit.snippet) lines.push(`    ${hit.snippet}`);
    lines.push('');
  }

  if (result.results.length === 0) lines.push('no results', '');

  // The fusion report is printed every time, not only when something went wrong:
  // whether a branch was missing changes how far these results should be trusted.
  const branches = Object.entries(result.fusion.branches)
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  lines.push(`fusion: ${branches}`);
  if (result.fusion.degraded.length > 0) {
    lines.push(`degraded: ${result.fusion.degraded.join(', ')}`);
    for (const [name, reason] of Object.entries(result.fusion.reasons)) {
      lines.push(`  ${name}: ${reason}`);
    }
  }
  return lines.join('\n');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
