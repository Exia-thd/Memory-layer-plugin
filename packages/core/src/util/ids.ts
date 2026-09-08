import crypto from 'node:crypto';

/**
 * Node id derived from content and provenance, so re-ingesting the same file
 * updates a node instead of creating a twin.
 */
export function nodeId(layer: string, sourceRef: string, body: string): string {
  const h = crypto.createHash('sha256');
  h.update(layer);
  h.update(' ');
  h.update(sourceRef);
  h.update(' ');
  h.update(normalizeForId(body));
  return `mem_${h.digest('hex').slice(0, 24)}`;
}

/**
 * Identity ignores whitespace reflow: reindenting a block should not orphan the
 * decision recorded against it.
 */
export function normalizeForId(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function shortHash(content: string, length = 16): string {
  return contentHash(content).slice(0, length);
}
