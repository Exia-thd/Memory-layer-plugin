/**
 * Secret removal.
 *
 * This runs before embedding, not after. Once text has been through an embedder
 * the vector still carries the secret, and no amount of masking the source text
 * takes it back out. The ordering is asserted by a test.
 */
export interface RedactionResult {
  text: string;
  redactions: { rule: string; count: number }[];
}

interface Rule {
  name: string;
  pattern: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[posur]_[A-Za-z0-9]{16,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'private-key-block', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    // Credentials embedded in a URL, keeping the host so the reference stays useful.
    name: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED:url-credentials]@`,
  },
  {
    // key = value assignments whose name says the value is a secret.
    name: 'assigned-secret',
    pattern:
      /\b((?:api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)(['"]?)([^\s'";,]{8,})\2/gi,
    replace: (_m, prefix, quote) => `${prefix}${quote}[REDACTED:assigned-secret]${quote}`,
  },
];

export function redact(text: string): RedactionResult {
  let output = text;
  const redactions: { rule: string; count: number }[] = [];

  for (const rule of RULES) {
    let count = 0;
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      return rule.replace ? rule.replace(match, ...groups) : `[REDACTED:${rule.name}]`;
    });
    if (count > 0) redactions.push({ rule: rule.name, count });
  }

  return { text: output, redactions };
}

/** True when the text still looks like it holds a secret. Used by tests and doctor. */
export function looksRedacted(text: string): boolean {
  return RULES.every((rule) => {
    rule.pattern.lastIndex = 0;
    return !rule.pattern.test(text);
  });
}
