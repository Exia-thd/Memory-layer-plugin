import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LAYERS, EDGE_TYPES, type Layer, type EdgeType, log } from '@memory-layer/core';
import * as api from './api.js';
import { isStale, storeDirOrThrow } from './project.js';

/**
 * MCP server over stdio.
 *
 * Nothing here may write to stdout except the protocol itself; diagnostics go to
 * the log file and stderr. A stray console.log corrupts the framing and the
 * failure looks like the server being broken rather than noisy.
 */

const TOOLS = [
  {
    name: 'memory_search',
    description:
      'Search project memory for decisions, errors, constraints and past sessions. ' +
      'Returns ranked results plus a fusion report saying which retrieval branches contributed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in natural language.' },
        limit: { type: 'number', description: 'Maximum results (default 10).' },
        layers: {
          type: 'array',
          items: { type: 'string', enum: [...LAYERS] },
          description: 'Restrict to these memory layers.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_why',
    description:
      'Why is this code the way it is? Returns the decisions and constraints touching a ' +
      'file path or symbol, with the errors they were made in response to. ' +
      'Use before changing code you did not write.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A file path or a symbol name.' },
        limit: { type: 'number' },
      },
      required: ['target'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one memory node in full, with its direct edges.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_neighbors',
    description:
      'Walk the memory graph out from a node. Traversal is bidirectional, so asking from ' +
      'an error reaches the decision that resolved it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        depth: { type: 'number', description: 'Hops to walk, 1-4 (default 2).' },
        edge_types: { type: 'array', items: { type: 'string', enum: [...EDGE_TYPES] } },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_write',
    description:
      'Record a decision, error, constraint or procedure. Always include the reason it was ' +
      'chosen over the alternative -- a decision without its reason cannot be re-evaluated later.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...LAYERS] },
        title: { type: 'string' },
        body: { type: 'string' },
        source_ref: {
          type: 'string',
          description: 'Where this came from, e.g. "docs/adr/0007.md#L10-L40" or "session:2026-09-08".',
        },
        file_path: { type: 'string' },
        importance: { type: 'number', description: '0-10.' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              type: { type: 'string', enum: [...EDGE_TYPES] },
              weight: { type: 'number' },
            },
            required: ['to', 'type'],
          },
        },
      },
      required: ['layer', 'title', 'body', 'source_ref'],
    },
  },
  {
    name: 'memory_link',
    description: 'Link two memory nodes with a typed relationship.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        type: { type: 'string', enum: [...EDGE_TYPES] },
        weight: { type: 'number' },
      },
      required: ['from', 'to', 'type'],
    },
  },
  {
    name: 'memory_constraints',
    description:
      'The decisions and constraints currently in force for this project, most important ' +
      'first. Use at the start of a task to learn what the project has already settled.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'memory_conflicts',
    description:
      'Contradictions between recorded decisions that a person needs to settle. ' +
      'Check this before recording a new decision.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function serve(): Promise<void> {
  const server = new Server(
    { name: 'memory-layer', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      const payload = await dispatch(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      // The error reaches the agent as an error, not as an empty result that reads
      // like "there is nothing recorded about this".
      const message = err instanceof Error ? err.message : String(err);
      log('error', `tool ${name} failed`, err);
      return {
        content: [{ type: 'text', text: `memory_error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const result = await api.runSearch(String(args.query ?? ''), {
        limit: numeric(args.limit),
        layers: args.layers as Layer[] | undefined,
      });
      return withFreshness(result);
    }

    case 'memory_why': {
      const result = await api.runWhy(String(args.target ?? ''), { limit: numeric(args.limit) });
      return withFreshness(result);
    }

    case 'memory_get': {
      const found = await api.runGet(String(args.id ?? ''));
      if (!found) throw new Error(`No such memory node: ${args.id}`);
      return found;
    }

    case 'memory_neighbors':
      return api.runNeighbors(String(args.id ?? ''), {
        depth: numeric(args.depth),
        edgeTypes: args.edge_types as EdgeType[] | undefined,
      });

    case 'memory_write': {
      const result = await api.runWrite({
        layer: args.layer as Layer,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        sourceRef: String(args.source_ref ?? ''),
        filePath: args.file_path ? String(args.file_path) : undefined,
        importance: numeric(args.importance),
        links: args.links as { to: string; type: EdgeType; weight?: number }[] | undefined,
      });
      return {
        ...result,
        note: result.queued
          ? 'Another process held the write lock, so this was queued to the session journal. ' +
            'It is recorded but will not appear in search until `memory merge` runs.'
          : undefined,
      };
    }

    case 'memory_link': {
      const result = await api.runLink(String(args.from ?? ''), String(args.to ?? ''), args.type as EdgeType, {
        weight: numeric(args.weight),
      });
      // Reported the way memory_write reports it. An edge that went to the
      // journal is recorded but not yet traversable, and saying so is the
      // difference between a queued write and one the caller thinks landed.
      return {
        ...result,
        note: result.queued
          ? 'Another process held the write lock, so this edge was queued to the session journal. ' +
            'It is recorded but will not be traversable until `memory merge` runs.'
          : undefined,
      };
    }

    case 'memory_constraints':
      return { constraints: await api.runConstraints({ limit: numeric(args.limit) }) };

    case 'memory_conflicts':
      return { conflicts: await api.runConflicts() };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Attaches an index-freshness note.
 *
 * Memory describes what was true when it was recorded. Handing an agent results
 * from a store built several commits ago, with nothing saying so, is how a
 * memory layer turns into a confident liar.
 */
function withFreshness<T extends object>(result: T): T & { index?: object } {
  try {
    const state = isStale(storeDirOrThrow());
    if (!state.stale) return result;
    return {
      ...result,
      index: {
        stale: true,
        indexedAt: state.indexed,
        head: state.head,
        note: 'This store was built at an older commit. Treat results as context, not as current state, and re-verify against the working tree.',
      },
    };
  } catch {
    return result;
  }
}

function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
