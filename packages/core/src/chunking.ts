/**
 * Markdown-aware chunking.
 *
 * Retrieval quality was measured (docs/architecture/rag.md) to fail hardest on whole-doc
 * retrieval: docs were scored entire, then cut at a fixed char budget during assembly, so a
 * 44k-char doc contributed its preamble regardless of which passage actually matched. Chunks
 * make the retrieval unit a passage, and carry enough breadcrumb to be readable out of context.
 */

/** One retrievable passage of a document. */
export interface Chunk {
  /** Heading breadcrumb, e.g. "Roads > What is NOT done". Empty for preamble. */
  heading: string;
  /** Position within the document, 0-based. */
  ordinal: number;
  content: string;
}

const DEFAULT_MAX_CHARS = 1200;
/** Below this a chunk is noise (a stray heading, a one-line stub) and is folded into the next. */
const MIN_CHARS = 60;

/** `## Heading text` -> depth 2, "Heading text". */
function parseHeading(line: string): { depth: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { depth: m[1].length, text: m[2].trim() };
}

/** Breadcrumb from the heading stack, e.g. ["Roads", "What is NOT done"] -> "Roads > What is NOT done". */
function breadcrumb(stack: string[]): string {
  return stack.filter(Boolean).join(' > ');
}

/**
 * Split markdown into passages on heading boundaries, then hard-wrap any section that is still
 * over `maxChars`. Oversized sections are split on paragraph breaks where possible so a chunk
 * rarely begins mid-sentence.
 */
export function chunkMarkdown(content: string, maxChars = DEFAULT_MAX_CHARS): Chunk[] {
  const lines = content.split('\n');
  const stack: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: '', body: [] };

  for (const line of lines) {
    const h = parseHeading(line);
    if (h) {
      if (current.body.join('\n').trim()) sections.push(current);
      stack.length = Math.max(0, h.depth - 1);
      stack[h.depth - 1] = h.text;
      current = { heading: breadcrumb(stack), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('\n').trim()) sections.push(current);

  const out: Chunk[] = [];
  for (const section of sections) {
    const body = section.body.join('\n').trim();
    if (!body) continue;
    for (const piece of splitToSize(body, maxChars)) {
      out.push({ heading: section.heading, ordinal: out.length, content: piece });
    }
  }

  // Fold runt chunks forward so a heading stub never becomes its own retrieval unit.
  const merged: Chunk[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (c.content.length < MIN_CHARS && prev && prev.content.length + c.content.length <= maxChars * 1.5) {
      prev.content = `${prev.content}\n\n${c.content}`;
      continue;
    }
    merged.push({ ...c, ordinal: merged.length });
  }
  return merged;
}

/** Split on paragraph breaks, accumulating up to `maxChars`; hard-cut anything still too long. */
function splitToSize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  };
  for (const para of paras) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) out.push(para.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + para.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return out;
}

/** The text actually indexed for a chunk: title + breadcrumb give a bare passage its subject back. */
export function chunkIndexText(title: string, chunk: Chunk): string {
  return [title, chunk.heading, chunk.content].filter(Boolean).join('\n');
}
