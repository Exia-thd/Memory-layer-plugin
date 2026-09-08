import { ruleForFile, newParser, type LanguageRule } from './languages.js';
import { log } from '../util/log.js';

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 1200;
export const DEFAULT_OVERLAP = 120;

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
  /** For markdown, the chain of parent headings this chunk sits under. */
  headingPath?: string[];
  mode: string;
}

/**
 * Cuts content into units that mean something on their own.
 *
 * Three branches and a shortcut:
 *   fits in one chunk   -> do not cut at all
 *   grammar available   -> cut on declaration boundaries
 *   markdown            -> cut on headings, carrying the parent chain
 *   anything else, or a
 *   failed parse        -> sliding character window
 *
 * The character fallback is not a wart, it is the reason a file the grammar
 * cannot read still ends up searchable.
 */
export async function chunk(
  filePath: string,
  content: string,
  options: ChunkOptions = {},
): Promise<Chunk[]> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  const rule = ruleForFile(filePath);

  if (content.length <= chunkSize) {
    return [{ text: content, startLine: 1, endLine: countLines(content), mode: 'WHOLE' }];
  }

  if (rule.mode === 'MARKDOWN_HEADING') {
    return markdownChunk(content, chunkSize, overlap);
  }

  if (rule.mode === 'AST_DECLARATION') {
    const astChunks = await astChunk(content, rule, chunkSize);
    if (astChunks && astChunks.length > 0) return astChunks;
  }

  return characterChunk(content, chunkSize, overlap);
}

function countLines(text: string): number {
  return text.length === 0 ? 1 : text.split('\n').length;
}

async function astChunk(
  content: string,
  rule: LanguageRule,
  chunkSize: number,
): Promise<Chunk[] | null> {
  try {
    const parser = await newParser(rule);
    if (!parser) return null;

    const tree = parser.parse(content) as {
      rootNode: { children: AstNode[] };
    };
    const boundaries = new Set(rule.boundaries);
    const lines = content.split('\n');
    const chunks: Chunk[] = [];

    let pendingStart: number | null = null;
    let pendingEnd = 0;

    const flush = () => {
      if (pendingStart === null) return;
      const text = lines.slice(pendingStart, pendingEnd + 1).join('\n');
      if (text.trim()) {
        chunks.push({
          text,
          startLine: pendingStart + 1,
          endLine: pendingEnd + 1,
          mode: 'AST_DECLARATION',
        });
      }
      pendingStart = null;
    };

    for (const node of tree.rootNode.children) {
      const start = node.startPosition.row;
      const end = node.endPosition.row;

      if (!boundaries.has(node.type)) {
        // Imports, comments and other filler ride along with the next declaration.
        if (pendingStart === null) pendingStart = start;
        pendingEnd = end;
        continue;
      }

      if (pendingStart !== null) {
        const merged = lines.slice(pendingStart, end + 1).join('\n');
        if (merged.length <= chunkSize) {
          pendingEnd = end;
          flush();
          continue;
        }
        flush();
      }

      const text = lines.slice(start, end + 1).join('\n');
      if (text.length > chunkSize) {
        // A single declaration bigger than the budget still has to be cut, but the
        // line offsets stay honest so source_ref keeps pointing at real lines.
        for (const piece of characterChunk(text, chunkSize, DEFAULT_OVERLAP)) {
          chunks.push({
            ...piece,
            startLine: start + piece.startLine,
            endLine: start + piece.endLine,
            mode: 'AST_DECLARATION_SPLIT',
          });
        }
      } else if (text.trim()) {
        chunks.push({ text, startLine: start + 1, endLine: end + 1, mode: 'AST_DECLARATION' });
      }
    }

    flush();
    return chunks;
  } catch (err) {
    log('warn', 'AST chunking failed; falling back to character windows', err);
    return null;
  }
}

interface AstNode {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
}

/**
 * Markdown splits on headings and each chunk records the heading chain above it,
 * so a section named "Retry policy" is still findable as billing retry policy.
 */
function markdownChunk(content: string, chunkSize: number, overlap: number): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  const stack: { level: number; title: string }[] = [];

  let bodyStart = 0;
  let currentPath: string[] = [];
  let inFence = false;

  const flush = (endExclusive: number) => {
    const text = lines.slice(bodyStart, endExclusive).join('\n');
    if (!text.trim()) return;
    const headingPath = [...currentPath];
    if (text.length <= chunkSize) {
      chunks.push({
        text,
        startLine: bodyStart + 1,
        endLine: endExclusive,
        headingPath,
        mode: 'MARKDOWN_HEADING',
      });
      return;
    }
    for (const piece of characterChunk(text, chunkSize, overlap)) {
      chunks.push({
        text: piece.text,
        startLine: bodyStart + piece.startLine,
        endLine: bodyStart + piece.endLine,
        headingPath,
        mode: 'MARKDOWN_HEADING_SPLIT',
      });
    }
  };

  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) continue;

    flush(index);

    const level = heading[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, title: heading[2]!.trim() });
    currentPath = stack.map((s) => s.title);
    bodyStart = index;
  }

  flush(lines.length);
  return chunks;
}

/** Sliding window over characters, snapped to a line boundary where one is close. */
export function characterChunk(content: string, chunkSize: number, overlap: number): Chunk[] {
  const chunks: Chunk[] = [];
  const step = Math.max(1, chunkSize - overlap);

  for (let offset = 0; offset < content.length; offset += step) {
    let end = Math.min(content.length, offset + chunkSize);

    if (end < content.length) {
      const newline = content.lastIndexOf('\n', end);
      if (newline > offset + chunkSize / 2) end = newline;
    }

    const text = content.slice(offset, end);
    if (text.trim()) {
      chunks.push({
        text,
        startLine: countLines(content.slice(0, offset)),
        endLine: countLines(content.slice(0, end)),
        mode: 'CHARACTER',
      });
    }
    if (end >= content.length) break;
  }

  return chunks;
}
