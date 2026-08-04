import { randomBytes } from 'node:crypto';

/** Compact, sortable-ish opaque id with a human-friendly prefix. */
export function newId(prefix: string): string {
  const rnd = randomBytes(6).toString('base64url');
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Lowercase alphanumeric tokens. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

/** Naive relevance score: token overlap weighted by query-token frequency (TF-style). */
export function relevanceScore(query: string, ...fields: string[]): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const field of fields) {
    for (const token of tokenize(field)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  let score = 0;
  for (const token of queryTokens) {
    score += counts.get(token) ?? 0;
  }
  // Normalize by query length so longer queries don't dominate.
  return score / Math.sqrt(queryTokens.length);
}

export function parseJsonArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}