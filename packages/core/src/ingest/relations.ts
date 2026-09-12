import { ruleForFile, ruleFor, newParser, type LanguageRule } from './languages.js';
import { declarations, type Declaration } from './chunker.js';
import { log } from '../util/log.js';

/**
 * What a file does to other code: what it calls, what it imports, what it
 * inherits from.
 *
 * Read here, resolved later. A call site gives a name and where it was written;
 * turning that name into the declaration it means needs every file's
 * declarations, which only the ingest that walked them all has. Keeping the two
 * apart is what lets one file be re-read on its own without re-reading the
 * repository.
 *
 * Nothing here guesses. A callee that cannot be resolved is kept as a name with
 * its call site, and reported as unresolved rather than pointed at whichever
 * declaration happened to share the name.
 */

export interface CallSite {
  /** The declaration the call was written in, by qualified name, or null at file level. */
  fromQualified: string | null;
  /** The name being called: `FindAsync` in `_repo.FindAsync(id)`. */
  name: string;
  /** What it was called on -- `_repo` -- when the grammar shows a receiver. */
  receiver: string | null;
  /** `new Order()` rather than `order.Save()`: the name is a type, not a method. */
  construction: boolean;
  line: number;
}

export interface ImportSite {
  /** The module as written: `./repository.js`, `java.util.List`, `Inventory.Domain`. */
  module: string;
  line: number;
}

export interface Heritage {
  /** The declaration doing the inheriting, by qualified name. */
  qualified: string;
  /** The base type as written, unqualified: `ServiceBase`. */
  base: string;
  line: number;
}

export interface FileRelations {
  calls: CallSite[];
  imports: ImportSite[];
  heritage: Heritage[];
  /** The namespace, package or module this file declares, when it declares one. */
  container: string | null;
}

const EMPTY: FileRelations = { calls: [], imports: [], heritage: [], container: null };

export async function relationsIn(filePath: string, content: string): Promise<FileRelations> {
  const rule = ruleForFile(filePath);
  if (rule.label === 'vue') return vueRelations(filePath, content);
  if (rule.mode !== 'AST_DECLARATION' || !rule.relations) return EMPTY;

  const parser = await newParser(rule);
  if (!parser) return EMPTY;

  let tree: { rootNode: Node; delete?: () => void } | null = null;
  try {
    tree = parser.parse(content) as { rootNode: Node; delete?: () => void };
    const declared = await declarations(filePath, content);
    return collect(tree.rootNode, rule, declared);
  } catch (err) {
    log('warn', `relation walk failed for ${filePath}`, err);
    return EMPTY;
  } finally {
    try {
      tree?.delete?.();
    } catch {
      // Already gone.
    }
    try {
      (parser as { delete?: () => void }).delete?.();
    } catch {
      // Same.
    }
  }
}

/**
 * A Vue component imports and calls from inside its `<script>`, which the Vue
 * grammar keeps as opaque text. Re-read with the grammar the `lang` attribute
 * asks for, with the line numbers shifted back to the component's own.
 */
async function vueRelations(filePath: string, content: string): Promise<FileRelations> {
  const found: FileRelations = { calls: [], imports: [], heritage: [], container: null };
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const match of content.matchAll(script)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const label = /\blang\s*=\s*["']?tsx\b/i.test(attributes)
      ? 'tsx'
      : /\blang\s*=\s*["']?(ts|typescript)\b/i.test(attributes) ? 'typescript' : 'javascript';
    const rule = ruleFor(label);
    if (!rule?.relations) continue;

    const offset = content.slice(0, (match.index ?? 0) + match[0].indexOf('>') + 1).split('\n').length - 1;
    const parser = await newParser(rule);
    if (!parser) continue;
    let tree: { rootNode: Node; delete?: () => void } | null = null;
    try {
      tree = parser.parse(body) as { rootNode: Node; delete?: () => void };
      const declared = await declarations(`${filePath}.${label === 'javascript' ? 'js' : 'ts'}`, body);
      const inner = collect(tree.rootNode, rule, declared);
      for (const call of inner.calls) found.calls.push({ ...call, line: call.line + offset });
      for (const item of inner.imports) found.imports.push({ ...item, line: item.line + offset });
      for (const item of inner.heritage) found.heritage.push({ ...item, line: item.line + offset });
    } catch (err) {
      log('warn', `relation walk failed for the script in ${filePath}`, err);
    } finally {
      try {
        tree?.delete?.();
      } catch {
        // Already gone.
      }
      try {
        (parser as { delete?: () => void }).delete?.();
      } catch {
        // Same.
      }
    }
  }
  return found;
}

function collect(root: Node, rule: LanguageRule, declared: Declaration[]): FileRelations {
  const relations = rule.relations!;
  const calls = new Set(relations.calls ?? []);
  const constructs = new Set(relations.constructs ?? []);
  const imports = new Set(relations.imports ?? []);
  const heritage = new Set(relations.heritage ?? []);
  const containers = new Set(relations.container ?? []);

  const found: FileRelations = { calls: [], imports: [], heritage: [], container: null };

  // Innermost declaration covering a line, so a call is attributed to the method
  // it sits in rather than to the class around it.
  const byDepth = [...declared].sort(
    (a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine),
  );
  const enclosing = (line: number): Declaration | null =>
    byDepth.find((item) => item.startLine <= line && line <= item.endLine) ?? null;

  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const line = node.startPosition.row + 1;

    if (calls.has(node.type)) {
      const callee = pick(node, relations.calleeFields ?? ['function']) ?? firstNamed(node);
      const name = callee ? lastName(callee) : null;

      // Several languages import by calling: Ruby's `require`, Lua's
      // `require`, JavaScript's `require`, Elixir's `alias` and `import`. The
      // call is the import statement, so it is read as one.
      if (name && (relations.importCalls ?? []).includes(name)) {
        const argument = firstString(node);
        if (argument) found.imports.push({ module: argument, line });
      } else if (name && (relations.ignoreCallees ?? []).includes(name)) {
        // `def get(id) do ... end` is a call to `def` whose arguments are the
        // head being defined. Walking into them recorded every function as
        // calling itself; the body, in the block, is walked as usual.
        for (const child of node.namedChildren ?? []) {
          if (child.type !== 'arguments') stack.push(child);
        }
        continue;
      } else if (name) {
        const owner = enclosing(line);
        found.calls.push({
          fromQualified: owner?.qualifiedName ?? null,
          name,
          // Java hangs the receiver off the invocation, JavaScript off the
          // callee expression; both are asked.
          receiver: receiverOf(node) ?? (callee ? receiverOf(callee) : null),
          construction: constructs.has(node.type),
          line,
        });
      }
    } else if (imports.has(node.type)) {
      const module = moduleOf(node, relations.importSource);
      if (module) found.imports.push({ module, line });
    } else if (heritage.has(node.type)) {
      const owner = enclosing(line);
      if (owner) {
        for (const base of baseNames(node)) found.heritage.push({ qualified: owner.qualifiedName, base, line });
      }
    } else if (containers.has(node.type) && !found.container) {
      const name = node.childForFieldName?.('name') ?? firstNamed(node);
      if (name?.text) found.container = name.text.trim();
    }

    // Some grammars give no node for the base list at all: Python hangs it off
    // the class as a field, Rust puts the trait on the impl. Asked by field,
    // because the node they point at is an argument list like any other.
    for (const field of relations.heritageFields ?? []) {
      const child = node.childForFieldName?.(field);
      if (!child) continue;
      const owner = enclosing(line);
      if (!owner) continue;
      for (const base of baseNames(child)) found.heritage.push({ qualified: owner.qualifiedName, base, line });
    }

    for (const child of node.namedChildren ?? []) stack.push(child);
  }

  // In file order: the walk is a stack, and a caller reading a diff should see
  // relations in the order the lines are written.
  found.calls.sort((a, b) => a.line - b.line);
  found.imports.sort((a, b) => a.line - b.line);
  found.heritage.sort((a, b) => a.line - b.line || a.base.localeCompare(b.base));
  return found;
}

const NAME_NODE = /(^|_)(identifier|name)$|^(constant|word)$/;

/** The last name in a callee expression: `FindAsync` out of `this._repo.FindAsync`. */
function lastName(node: Node): string | null {
  if (NAME_NODE.test(node.type)) return clean(node.text);

  // Grammars mark the selected member differently: `name` in C# and Java,
  // `property` in JavaScript's member_expression, `field` in Go and C.
  for (const field of ['name', 'property', 'field', 'method']) {
    const child = node.childForFieldName?.(field);
    if (child) return lastName(child);
  }

  const named = node.namedChildren ?? [];
  for (let index = named.length - 1; index >= 0; index--) {
    const name = lastName(named[index]!);
    if (name) return name;
  }
  return null;
}

/** What the call was made on, when there is one: `_repo` in `_repo.FindAsync`. */
function receiverOf(callee: Node): string | null {
  for (const field of ['object', 'expression', 'receiver', 'operand']) {
    const child = callee.childForFieldName?.(field);
    if (child?.text) return clean(child.text);
  }
  return null;
}

function moduleOf(node: Node, sourceField?: string): string | null {
  const source = node.childForFieldName?.(sourceField ?? 'source');
  const text = source?.text ?? firstNamed(node)?.text ?? '';
  const trimmed = text.trim().replace(/^["'`]|["'`]$/g, '').replace(/;$/, '');
  // Dart wraps the path in nodes that carry the keyword with them, so the
  // outermost text reads `import 'package:billing/domain.dart'`. Anything with
  // a space in it is not a module name; the string inside is.
  if (trimmed.length === 0 || /\s/.test(trimmed)) return firstString(node);
  return trimmed.length < 400 ? trimmed : null;
}

function baseNames(node: Node): string[] {
  const names: string[] = [];
  const walk = (current: Node) => {
    if (NAME_NODE.test(current.type)) {
      const name = clean(current.text);
      if (name) names.push(name);
      return;
    }
    for (const child of current.namedChildren ?? []) walk(child);
  };
  for (const child of node.namedChildren ?? []) walk(child);
  return names;
}

/** The first of these fields the node actually has. */
function pick(node: Node, fields: string[]): Node | null {
  for (const field of fields) {
    const child = node.childForFieldName?.(field);
    if (child) return child;
  }
  return null;
}

function firstNamed(node: Node): Node | null {
  return (node.namedChildren ?? [])[0] ?? null;
}

/** The first string literal under a node: the module a require-style import names. */
function firstString(node: Node): string | null {
  const stack = [...(node.namedChildren ?? [])];
  while (stack.length > 0) {
    const current = stack.shift()!;
    // A string in most languages, a bare word in a shell: `source ./lib.sh`.
    if (/string|literal|alias|module|word/i.test(current.type) && current.text) {
      const text = current.text.trim().replace(/^["'`:]+|["'`]+$/g, '');
      if (text.length > 0 && text.length < 400 && !/\s/.test(text)) return text;
    }
    stack.push(...(current.namedChildren ?? []));
  }
  return null;
}

/** A name is one token; generics and qualifiers are cut back to the last part. */
function clean(text: string | undefined): string | null {
  if (!text) return null;
  const last = text.trim().replace(/<.*$/s, '').split(/[.:]/).pop() ?? '';
  return /^[A-Za-z_$][\w$]{0,127}$/.test(last) ? last : null;
}

interface Node {
  type: string;
  text?: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren?: Node[];
  childForFieldName?: (field: string) => Node | null;
}
