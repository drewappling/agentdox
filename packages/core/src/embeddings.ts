/**
 * Pluggable embedding providers.
 *
 * Two rules shape this module, both from measurement (docs/architecture/rag.md):
 *
 * 1. **Embedding is never on the write path.** Providers are remote processes that can be down —
 *    Ollama was not running when this was designed. `memory_add` must not fail, or slow to an
 *    HTTP round-trip, because a vector could not be computed. Vectors are backfilled.
 * 2. **Absence degrades, it never errors.** With no provider, retrieval is lexical-only, which
 *    measured well on everything except vocabulary-mismatch queries.
 */

/**
 * Whether the text being embedded is a stored passage or a question about one. Asymmetric
 * models (nomic-embed-text, e5, bge) are trained with a task prefix on each side and lose real
 * accuracy without it — measured here: unprefixed vectors pushed an exact lexical match off the
 * top spot for "what pose is the base character in".
 */
export type EmbedKind = 'query' | 'document';

export interface EmbeddingProvider {
  readonly id: string;
  /** Model identifier, recorded alongside each vector so a model change can invalidate it. */
  readonly model: string;
  readonly dims: number;
  /** Embed a batch. Throws on transport failure; callers treat that as "no vectors this round". */
  embed(texts: string[], kind?: EmbedKind): Promise<Float32Array[]>;
}

/**
 * Task prefixes by model family. Applied only where the model expects them — prefixing a
 * symmetric model would be noise in its input.
 */
function taskPrefix(model: string, kind: EmbedKind): string {
  const m = model.toLowerCase();
  if (m.includes('nomic-embed')) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  if (m.includes('e5-') || m.startsWith('e5')) return kind === 'query' ? 'query: ' : 'passage: ';
  if (m.includes('bge-') && kind === 'query') return 'Represent this sentence for searching relevant passages: ';
  return '';
}

/** L2-normalise so cosine similarity reduces to a dot product at query time. */
function normalise(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

/** Local Ollama. Free, private, and already present on this machine; needs the daemon running. */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly id = 'ollama';
  constructor(
    readonly model: string,
    readonly dims: number,
    private readonly baseUrl: string,
  ) {}

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<Float32Array[]> {
    const prefix = taskPrefix(this.model, kind);
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts.map((t) => prefix + t) }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embeddings?: number[][] };
    if (!json.embeddings?.length) throw new Error('ollama embed returned no embeddings');
    return json.embeddings.map(normalise);
  }
}

/** OpenAI-compatible embeddings, for deployments without a local model server. */
export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly id = 'openai';
  constructor(
    readonly model: string,
    readonly dims: number,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async embed(texts: string[], _kind: EmbedKind = 'document'): Promise<Float32Array[]> {
    // OpenAI's embedding models are symmetric; no task prefix.
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`openai embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!json.data?.length) throw new Error('openai embed returned no data');
    return json.data.map((d) => normalise(d.embedding));
  }
}

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai' | 'none';
  model: string;
  dims: number;
  baseUrl: string;
  apiKey?: string;
}

/** Defaults chosen so an unconfigured install makes no network calls at all. */
export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const provider = (env.AGENTDOX_EMBED_PROVIDER ?? 'none').toLowerCase();
  const isOpenAi = provider === 'openai';
  return {
    provider: provider === 'ollama' || isOpenAi ? provider : 'none',
    model: env.AGENTDOX_EMBED_MODEL ?? (isOpenAi ? 'text-embedding-3-small' : 'nomic-embed-text'),
    dims: Number(env.AGENTDOX_EMBED_DIMS ?? (isOpenAi ? 1536 : 768)),
    baseUrl: env.AGENTDOX_EMBED_URL ?? (isOpenAi ? 'https://api.openai.com/v1' : 'http://localhost:11434'),
    ...(env.AGENTDOX_EMBED_API_KEY ? { apiKey: env.AGENTDOX_EMBED_API_KEY } : {}),
  };
}

/** Build a provider, or `null` when embeddings are off / misconfigured. Never throws. */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | null {
  if (config.provider === 'ollama') return new OllamaEmbeddings(config.model, config.dims, config.baseUrl);
  if (config.provider === 'openai') {
    if (!config.apiKey) return null; // configured but unusable -> lexical-only, not a crash
    return new OpenAIEmbeddings(config.model, config.dims, config.apiKey, config.baseUrl);
  }
  return null;
}

/** Pack for BLOB storage. */
export function vectorToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack from BLOB storage, copying so the result is not a view on a reused buffer. */
export function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/** Dot product. Both sides are L2-normalised on write, so this *is* cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
