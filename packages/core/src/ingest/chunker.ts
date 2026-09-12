import { ruleForFile, ruleFor, newParser, type LanguageRule } from './languages.js';
import { log } from '../util/log.js';

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 1200;

/**
 * Bump when chunk boundaries or recorded declarations change for content that
 * has not. Ingest compares it per file, so the next run re-reads what an older
 * reader produced instead of skipping it as unchanged.
 *
 *   1  top-level declarations only, six languages
 *   2  declarations at any depth, qualified names, 36 grammars, oversized
 *      declarations split between their members
 *   3  calls, base types and imports recorded alongside the declarations
 */
export const CHUNKER_VERSION = 3;
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
  if (rule.label === 'vue') return vueChunk(content, chunkSize);

  const parser = await newParser(rule);
  if (!parser) return null;
  let tree: ParsedTree | null = null;

  try {
    tree = parser.parse(content) as ParsedTree;
    const boundaries = new Set(rule.boundaries);
    const writer = new ChunkWriter(content.split('\n'), chunkSize);

    for (const node of topLevelNodes(tree.rootNode, rule)) {
      // Data formats pack neighbours up to the budget instead of giving each
      // key or rule a chunk of its own. A package.json cut one pair per chunk is
      // thirty fragments, none of which answers a question alone.
      if (rule.pack || !isBoundary(node, rule, boundaries)) {
        // Imports, comments and other filler ride along with the next declaration.
        writer.add(node);
        continue;
      }
      // A declaration starts a chunk of its own, taking any filler before it
      // along when the two fit, and never shares its chunk with the next one.
      writer.declaration(node);
    }

    return writer.finish();
  } catch (err) {
    log('warn', 'AST chunking failed; falling back to character windows', err);
    return null;
  } finally {
    release(tree, parser);
  }
}

/**
 * Accumulates syntax nodes into chunks of at most `chunkSize` characters.
 *
 * The rule for a node too big for one chunk is the point of this class: it is
 * split at its own children -- a class at its members, a JSON object at its
 * keys, a YAML job at its steps -- recursively, and only a node with no
 * structure left to split on is cut into character windows. Before this, any
 * declaration over the budget went straight to character windows, so a C#
 * class of more than 1200 characters -- most of them -- was cut mid-method.
 */
class ChunkWriter {
  private readonly chunks: Chunk[] = [];
  private pendingStart: number | null = null;
  private pendingEnd = 0;
  /** Where the run of comments at the end of the pending text starts, if it ends in one. */
  private commentStart: number | null = null;
  /** offsets[row] = characters before `row`, newlines included, so a size is two lookups. */
  private readonly offsets: number[];

  constructor(
    private readonly lines: string[],
    private readonly chunkSize: number,
  ) {
    this.offsets = [0];
    for (const line of lines) this.offsets.push(this.offsets[this.offsets.length - 1]! + line.length + 1);
  }

  /** Adds a node to the pending chunk, splitting it if it cannot fit anywhere. */
  add(node: AstNode): void {
    const start = node.startPosition.row;
    const end = node.endPosition.row;
    const comment = node.type.includes('comment');

    if (this.pendingStart !== null && this.size(this.pendingStart, end) <= this.chunkSize) {
      this.extend(start, end, comment);
      return;
    }
    if (this.size(start, end) <= this.chunkSize) {
      // A doc comment is about what follows it. Cut before the comments, not
      // after them, so `/// Loads an order` stays with the method it describes.
      this.flushBeforeComments();
      if (this.pendingStart !== null && this.size(this.pendingStart, end) <= this.chunkSize) {
        this.extend(start, end, comment);
        return;
      }
      this.flush();
      this.pendingStart = start;
      this.pendingEnd = end;
      this.commentStart = comment ? start : null;
      return;
    }

    // Too big on its own. Its children are the next-best boundaries; the
    // pending text stays pending, so a class header joins its first members
    // instead of becoming a chunk that says only `public class Foo {`. A
    // wrapper with a single child -- YAML's block_node around its mapping --
    // is looked through the same way.
    //
    // Chunks are made of whole lines, so a node on one line cannot be divided
    // by its children; a minified file's single line goes to character windows.
    const children = node.children ?? [];
    if (start !== end && children.length > 0) {
      for (const child of children) this.add(child);
      return;
    }

    this.flush();
    this.characters(start, end);
  }

  /**
   * A declaration: shares its chunk with the filler before it, never with what
   * follows. One too big to fit is split, and the filler -- imports, the
   * namespace line -- then leads its first members rather than standing alone.
   */
  declaration(node: AstNode): void {
    this.add(node);
    this.flush();
  }

  finish(): Chunk[] {
    this.flush();
    return this.chunks;
  }

  private extend(start: number, end: number, comment: boolean): void {
    this.pendingEnd = Math.max(this.pendingEnd, end);
    if (!comment) this.commentStart = null;
    else this.commentStart ??= start;
  }

  /** Flushes the pending text except for a trailing run of comments, which stays pending. */
  private flushBeforeComments(): void {
    if (this.pendingStart === null) return;
    const carry = this.commentStart;
    if (carry === null || carry <= this.pendingStart) {
      this.flush();
      return;
    }
    const end = this.pendingEnd;
    this.pendingEnd = carry - 1;
    this.flush();
    this.pendingStart = carry;
    this.pendingEnd = end;
    this.commentStart = carry;
  }

  private size(start: number, end: number): number {
    const last = Math.min(end + 1, this.lines.length);
    return this.offsets[last]! - this.offsets[Math.min(start, last)]! - 1;
  }

  private flush(): void {
    if (this.pendingStart === null) return;
    const start = this.pendingStart;
    const end = this.pendingEnd;
    this.pendingStart = null;
    this.commentStart = null;
    this.emit(start, end, 'AST_DECLARATION');
  }

  private emit(startRow: number, endRow: number, mode: string): void {
    // Two nodes can share a line -- `} else {`, a closing tag and the next
    // opening one. The line goes to the chunk that already has it.
    const previous = this.chunks[this.chunks.length - 1];
    let start = startRow;
    if (previous && start <= previous.endLine - 1) {
      if (endRow <= previous.endLine - 1) return;
      start = previous.endLine;
    }
    const text = this.lines.slice(start, endRow + 1).join('\n');
    if (!text.trim()) return;

    // A lone `}` or `</div>` answers nothing on its own; it closes the chunk before it.
    if (previous && !/[\p{L}\p{N}]/u.test(text) && previous.endLine >= start) {
      previous.text += `\n${this.lines.slice(previous.endLine, endRow + 1).join('\n')}`;
      previous.endLine = endRow + 1;
      return;
    }
    this.chunks.push({ text, startLine: start + 1, endLine: endRow + 1, mode });
  }

  /** The last resort: a node with no structure left to split on. */
  private characters(startRow: number, end: number): void {
    // Several nodes can sit on one over-long line; the line is cut once.
    const previous = this.chunks[this.chunks.length - 1];
    if (previous && end <= previous.endLine - 1) return;
    const start = previous ? Math.max(startRow, Math.min(previous.endLine, end)) : startRow;
    const text = this.lines.slice(start, end + 1).join('\n');
    // Line offsets stay honest so source_ref keeps pointing at real lines.
    for (const piece of characterChunk(text, this.chunkSize, DEFAULT_OVERLAP)) {
      this.chunks.push({
        ...piece,
        startLine: start + piece.startLine,
        endLine: start + piece.endLine,
        mode: 'AST_DECLARATION_SPLIT',
      });
    }
  }
}

/**
 * Vue: the component grammar sees `<template>`, `<script>` and `<style>`, and
 * keeps the inside of the last two as opaque text. Each block is cut with the
 * grammar for what it contains -- TypeScript or JavaScript for the script, CSS
 * for the style -- and the template on its own element structure, so a long
 * component is not cut mid-function.
 */
async function vueChunk(content: string, chunkSize: number): Promise<Chunk[] | null> {
  const chunks: Chunk[] = [];
  const blocks = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let cursor = 0;

  const rest = async (text: string, offset: number) => {
    if (!text.trim()) return;
    const html = ruleFor('html');
    const pieces = (html && (await astChunk(text, html, chunkSize))) || characterChunk(text, chunkSize, DEFAULT_OVERLAP);
    for (const piece of pieces) chunks.push(shift(piece, offset));
  };

  for (const match of content.matchAll(blocks)) {
    const at = match.index ?? 0;
    await rest(content.slice(cursor, at), lineOf(content, cursor));

    const [whole, tag, attributes = '', body = ''] = match;
    const lang = /\blang\s*=\s*["']?(\w+)/i.exec(attributes)?.[1]?.toLowerCase();
    const label = tag!.toLowerCase() === 'style'
      ? (lang && lang !== 'css' ? null : 'css')
      : lang === 'tsx' ? 'tsx' : lang === 'ts' || lang === 'typescript' ? 'typescript' : 'javascript';
    const inner = label ? ruleFor(label) : null;

    if (whole.length <= chunkSize || !inner) {
      const text = whole;
      const pieces = text.length <= chunkSize
        ? [{ text, startLine: 1, endLine: countLines(text), mode: 'AST_DECLARATION' }]
        : characterChunk(text, chunkSize, DEFAULT_OVERLAP);
      for (const piece of pieces) chunks.push(shift(piece, lineOf(content, at)));
    } else {
      // The body is cut by its own grammar. It starts on the opening tag's line
      // and ends on the closing tag's, so the tags go back onto those lines.
      const open = whole.slice(0, whole.indexOf('>') + 1);
      const close = whole.slice(open.length + body.length);
      const bodyLines = body.split('\n');
      const pieces = (await astChunk(body, inner, chunkSize)) ?? characterChunk(body, chunkSize, DEFAULT_OVERLAP);
      if (pieces.length > 0) {
        // Extend the first chunk back to the tag's line and the last one on to
        // the closing tag's, taking along whatever blank lines lie between.
        const first = pieces[0]!;
        const before = bodyLines.slice(0, first.startLine - 1);
        pieces[0] = {
          ...first,
          text: before.length > 0 ? `${open}${before.join('\n')}\n${first.text}` : open + first.text,
          startLine: 1,
        };
        const lastIndex = pieces.length - 1;
        const last = pieces[lastIndex]!;
        const after = bodyLines.slice(last.endLine);
        pieces[lastIndex] = {
          ...last,
          text: after.length > 0 ? `${last.text}\n${after.join('\n')}${close}` : last.text + close,
          endLine: bodyLines.length,
        };
      }
      const bodyLine = lineOf(content, at);
      for (const piece of pieces) chunks.push(shift(piece, bodyLine));
    }
    cursor = at + whole.length;
  }
  await rest(content.slice(cursor), lineOf(content, cursor));
  return chunks;
}

/** Zero-based line of a character offset. */
function lineOf(content: string, offset: number): number {
  let line = 0;
  for (let index = content.indexOf('\n'); index !== -1 && index < offset; index = content.indexOf('\n', index + 1)) line++;
  return line;
}

function shift(piece: Chunk, lines: number): Chunk {
  return { ...piece, startLine: piece.startLine + lines, endLine: piece.endLine + lines };
}

/**
 * The top-level nodes a file is cut on, looking through wrappers.
 *
 * A C# file is one namespace; a C++ file often one namespace; a JSON document
 * one object. Taken literally, each is a single top-level node and therefore a
 * single chunk. Containers are opened so the declarations inside become the
 * units -- but only containers: a class is a boundary and is never opened, so
 * its methods stay with it.
 */
function topLevelNodes(root: AstNode, rule: LanguageRule): AstNode[] {
  const containers = new Set(rule.containers ?? []);
  // An Elixir module is a call like any other; open it the way a namespace is
  // opened, so its functions become the units.
  const opens = (node: AstNode) =>
    containers.has(node.type) || (rule.label === 'elixir' && elixirDefiner(node) === 'defmodule');
  if (containers.size === 0 && rule.label !== 'elixir') return root.children ?? [];
  const open = (nodes: AstNode[]): AstNode[] =>
    nodes.flatMap((node) => (opens(node) ? open(node.children ?? []) : [node]));
  return open(root.children ?? []);
}

/**
 * Frees the parse tree and the parser.
 *
 * Both live in WebAssembly memory, which the JavaScript garbage collector
 * cannot see and never reclaims. Every file used to allocate a parser and a
 * tree and keep them -- two per file, since chunking and declarations each
 * parse -- for the life of the process.
 */
function release(tree: ParsedTree | null, parser: unknown): void {
  try {
    tree?.delete?.();
  } catch {
    // Already gone, or a runtime without explicit disposal.
  }
  try {
    (parser as { delete?: () => void } | null)?.delete?.();
  } catch {
    // Same.
  }
}

interface ParsedTree {
  rootNode: AstNode;
  delete?: () => void;
}

interface AstNode {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  children?: AstNode[];
  namedChildren?: AstNode[];
  text?: string;
  childForFieldName?: (field: string) => AstNode | null;
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


/** Tree-sitter grammars agree on very little; they do agree on these. */
const NAME_TYPES = new Set([
  'identifier', 'type_identifier', 'property_identifier', 'field_identifier',
  'simple_identifier', 'constant', 'word', 'name', 'id',
  'lower_case_identifier', 'upper_case_identifier',
]);

/** Node types that wrap a name with its qualifiers: `A::B`, `Outer.Inner`. */
const QUALIFIED_TYPES = new Set(['qualified_identifier', 'scope_resolution', 'scoped_identifier']);

/** A name is one token. Anything with spaces or brackets is a pattern or a type. */
const TOKEN = /^[^\s(){}[\],;=<>"'`]{1,128}$/;

/**
 * The name a declaration declares, or null when the grammar hides it somewhere
 * this does not look. Null is a normal answer: an anonymous default export or a
 * destructuring declaration genuinely has no single name, and inventing one
 * would be worse than leaving the chunk unnamed.
 *
 * Asks the grammar before guessing. Most grammars mark the declared name with a
 * `name` field, and that is the only reliable answer: C#'s
 * `public Order Get()` has two identifiers, and the first one is the return
 * type. Picking the first identifier recorded every such method as `Order`.
 */
function declaredName(node: AstNode): string | null {
  const field = node.childForFieldName?.('name');
  if (field) return tokenName(field);

  // `let total x = ...` in OCaml and ReScript binds a pattern. Only a plain
  // name is a declaration; `let (a, b) = ...` and `let () = ...` are not.
  const pattern = node.childForFieldName?.('pattern');
  if (pattern) return /(^|_)(name|identifier)$/.test(pattern.type) ? tokenName(pattern) : null;

  // C, C++ and Objective-C put the name inside a declarator chain:
  // function_definition > function_declarator > pointer_declarator > identifier.
  let declarator = node.childForFieldName?.('declarator') ?? null;
  for (let depth = 0; declarator && depth < 8; depth++) {
    if (NAME_TYPES.has(declarator.type) || QUALIFIED_TYPES.has(declarator.type)
      || declarator.type === 'destructor_name' || declarator.type === 'operator_name') {
      return tokenName(declarator);
    }
    declarator = declarator.childForFieldName?.('declarator') ?? null;
  }

  const direct = (node.children ?? []).find((child) => NAME_TYPES.has(child.type));
  if (direct?.text) return tokenName(direct);

  // `const charge = () => {}` hides the name one level down, inside the
  // declarator. The declarator's own `name` field decides: `const { a, b } = x`
  // names a pattern, and falling through to the first identifier would record
  // it as `x`, the thing being destructured.
  for (const child of node.namedChildren ?? node.children ?? []) {
    const nested = child.childForFieldName?.('name');
    if (nested) return NAME_TYPES.has(nested.type) ? tokenName(nested) : null;
    const inner = (child.children ?? []).find((grandchild) => NAME_TYPES.has(grandchild.type));
    if (inner?.text) return tokenName(inner);
  }
  return null;
}

function tokenName(node: AstNode): string | null {
  // `A::B::m` is declared as `m`; the qualifier is where it lives, not what it is.
  if (QUALIFIED_TYPES.has(node.type)) {
    const inner = node.childForFieldName?.('name');
    if (inner) return tokenName(inner);
  }
  const text = node.text?.trim() ?? '';
  return TOKEN.test(text) ? text : null;
}

/**
 * Elixir has no declaration syntax. `defmodule`, `def` and the rest are
 * ordinary macro calls, so the grammar sees `call` everywhere; one is a
 * declaration only when its target is a definer.
 */
const ELIXIR_DEFINERS = new Set([
  'defmodule', 'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp',
  'defdelegate', 'defprotocol', 'defimpl', 'defexception', 'defstruct',
]);

function elixirDefiner(node: AstNode): string | null {
  if (node.type !== 'call') return null;
  const target = node.childForFieldName?.('target');
  return target?.text && ELIXIR_DEFINERS.has(target.text) ? target.text : null;
}

function elixirName(node: AstNode): string | null {
  const args = (node.namedChildren ?? []).find((child) => child.type === 'arguments');
  let subject = args?.namedChildren?.[0] ?? null;
  // `def f(x) when x > 0` puts the head on the left of a `when`; `def f(x)` is a
  // call whose target is the name; `def f` and `defmodule M` are the name itself.
  for (let depth = 0; subject && depth < 4; depth++) {
    if (subject.type === 'identifier' || subject.type === 'alias') return tokenName(subject);
    if (subject.type === 'binary_operator') subject = subject.childForFieldName?.('left') ?? null;
    else if (subject.type === 'call') subject = subject.childForFieldName?.('target') ?? null;
    else return null;
  }
  return null;
}

/**
 * Whether a top-level node starts a chunk of its own.
 *
 * For every grammar but Elixir's this is the boundary list. Elixir's boundary
 * is `call`, and `alias`, `use` and `import` are calls too: without the definer
 * check each of them would open a one-line chunk.
 */
function isBoundary(node: AstNode, rule: LanguageRule, boundaries: Set<string>): boolean {
  if (!boundaries.has(node.type)) return false;
  return rule.label === 'elixir' ? elixirDefiner(node) !== null : true;
}

/**
 * Where the declarations in a file are, and what they are called.
 *
 * Kept apart from chunking because the two answer different questions: a file
 * small enough to fit in a single chunk is never cut, so it declared nothing as
 * far as the graph was concerned -- and small files are most of a repository.
 *
 * Walks the whole tree, not just its top. A method lives inside a class body,
 * a class inside a namespace; the top-only walk recorded neither, in any
 * language. Each declaration carries the chain of declarations around it, so
 * `Get` in `OrderService` and `Get` in `CustomerService` stay two symbols.
 *
 * Returns an empty list, never null, when the grammar is unavailable: a file the
 * parser cannot read has no declarations *that we know of*, and the capability
 * line already says the chunker is degraded.
 */
export async function declarations(
  filePath: string,
  content: string,
): Promise<Declaration[]> {
  const rule = ruleForFile(filePath);
  if (rule.mode !== 'AST_DECLARATION') return [];
  if (rule.label === 'vue') return vueDeclarations(content);
  return declarationsWith(rule, content, 0);
}

async function declarationsWith(
  rule: LanguageRule,
  content: string,
  lineOffset: number,
): Promise<Declaration[]> {
  const symbolTypes = new Set(rule.symbols ?? rule.boundaries);
  if (symbolTypes.size === 0 || rule.pack) return [];
  const topOnly = new Set(rule.topLevelOnly ?? []);
  const variables = new Set(rule.variables ?? []);

  const parser = await newParser(rule);
  if (!parser) return [];
  let tree: ParsedTree | null = null;
  try {
    tree = parser.parse(content) as ParsedTree;
    const found: Declaration[] = [];
    const seen = new Set<string>();

    // Iterative, because a deeply nested file -- generated code, a long chain
    // of callbacks -- would otherwise recurse as deep as the file is nested.
    const stack: Array<{ node: AstNode; topLevel: boolean; local: boolean; scope: string[] }> =
      (tree.rootNode.children ?? [])
        .map((node) => ({ node, topLevel: true, local: false, scope: [] as string[] }))
        .reverse();

    while (stack.length > 0) {
      const { node, topLevel, local, scope } = stack.pop()!;
      let name: string | null = null;
      let kind = node.type;

      const isVariable = variables.has(node.type);
      if (symbolTypes.has(node.type) && (topLevel || !topOnly.has(node.type)) && !(isVariable && local)) {
        if (rule.label === 'elixir') {
          const definer = elixirDefiner(node);
          if (definer) {
            kind = definer;
            name = elixirName(node);
          }
        } else if (!isReference(node)) {
          name = declaredName(node);
        }
      }

      let inner = scope;
      if (name) {
        const qualified = [...scope, name].join('.');
        // Overloads share a name and an id; the first one keeps the lines.
        if (!seen.has(qualified)) {
          seen.add(qualified);
          found.push({
            name,
            qualifiedName: qualified,
            kind,
            startLine: node.startPosition.row + 1 + lineOffset,
            endLine: node.endPosition.row + 1 + lineOffset,
          });
        }
        inner = [...scope, name];
      }

      // `export const x` and `export class C` are still top level.
      const childrenTopLevel = topLevel && node.type === 'export_statement';
      // Inside a function, or inside a value, a binding is a local.
      const childrenLocal = local || isVariable || FUNCTION_LIKE.test(node.type);
      const children = node.children ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index]!, topLevel: childrenTopLevel, local: childrenLocal, scope: inner });
      }
    }
    return found;
  } catch (err) {
    log('warn', `declaration walk failed for ${rule.label}`, err);
    return [];
  } finally {
    release(tree, parser);
  }
}

/**
 * `struct S *p` names a struct without declaring one. In C and C++ the same
 * node type serves both, and only a body tells them apart.
 */
function isReference(node: AstNode): boolean {
  return node.type.endsWith('_specifier') && !node.childForFieldName?.('body');
}

/**
 * Node types whose inside is a function body, across grammars: declarations,
 * methods, constructors, lambdas, closures, arrow functions, OCaml's `fun`.
 * Matched by name because thirty grammars spell it thirty ways, and a miss
 * costs only a few recorded locals.
 */
const FUNCTION_LIKE = /(^|_)(function|method|constructor|init|lambda|closure|arrow|fun|macro)(_|$)/;

/**
 * A Vue component's names are in its `<script>`, which the Vue grammar keeps as
 * opaque text. Re-parsed with the grammar the `lang` attribute asks for, with
 * line numbers shifted back to where the script sits in the file.
 */
async function vueDeclarations(content: string): Promise<Declaration[]> {
  const found: Declaration[] = [];
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of content.matchAll(script)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const label = /\blang\s*=\s*["']?tsx\b/i.test(attributes)
      ? 'tsx'
      : /\blang\s*=\s*["']?(ts|typescript)\b/i.test(attributes) ? 'typescript' : 'javascript';
    const rule = ruleFor(label);
    if (!rule) continue;
    // The body starts right after the opening tag, on the tag's own line.
    const bodyStart = (match.index ?? 0) + match[0].indexOf('>') + 1;
    const offset = content.slice(0, bodyStart).split('\n').length - 1;
    found.push(...(await declarationsWith(rule, body, offset)));
  }
  return found;
}

export interface Declaration {
  name: string;
  /** The name with the declarations around it: `OrderService.Get`. */
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}
