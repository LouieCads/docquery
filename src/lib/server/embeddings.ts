import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from '$env/static/private';

/**
 * Turning text into vectors.
 *
 * An embedding places text at a point in high-dimensional space where proximity
 * approximates semantic relatedness, which is what lets a query match an answer
 * that shares none of its vocabulary.
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Native output is 3072. This model is Matryoshka-trained, so its dimensions are
 * ordered by importance and a truncated prefix remains a usable embedding — 768
 * costs little recall, keeps rows and the HNSW index small, and stays well under
 * pgvector's 2000-dimension index ceiling.
 *
 * Changing this is a migration, not a config tweak: it is the `vector(768)` column
 * type in Stage 4 and every stored vector would need recomputing.
 */
export const EMBEDDING_DIM = 768;

/**
 * Per-request cap on how many texts to embed at once.
 *
 * Note this does *not* buy free-tier headroom. The free quota
 * (`embed_content_free_tier_requests`, 100/minute) meters individual texts, not
 * HTTP calls — 100 texts in one request consumes the whole minute's allowance just
 * as 100 separate requests would. Batching only saves round-trips and latency.
 */
export const MAX_BATCH = 100;

/**
 * Which side of the question/answer pair is being encoded. Chunks are documents,
 * questions are queries; the model projects them so a query lands near its answer
 * rather than near other queries. Mixing these up degrades retrieval silently.
 */
export type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export class EmbeddingError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'EmbeddingError';
	}
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
	if (!client) client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
	return client;
}

/** Split into fixed-size groups, preserving order. */
export function batched<T>(items: T[], size: number): T[][] {
	if (size < 1) throw new RangeError('Batch size must be at least 1.');
	const groups: T[][] = [];
	for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
	return groups;
}

/**
 * Scale a vector to unit length.
 *
 * Required here because truncating a Matryoshka embedding from 3072 to 768 drops
 * the tail dimensions, and what remains no longer has norm 1 (measured ~0.58).
 * Cosine distance renormalizes internally so it tolerates this, but storing unit
 * vectors keeps the faster inner-product operator available and makes a raw dot
 * product a valid similarity.
 */
export function normalizeVector(vector: number[]): number[] {
	let sumOfSquares = 0;
	for (const value of vector) sumOfSquares += value * value;

	const magnitude = Math.sqrt(sumOfSquares);
	if (magnitude === 0) return vector.slice(); // degenerate; nothing to scale toward
	return vector.map((value) => value / magnitude);
}

/**
 * Cosine similarity: the angle between two vectors, ignoring magnitude. 1 means
 * identical direction, 0 unrelated, -1 opposite. For unit vectors this reduces to
 * the dot product, but the norms are divided out here so it is correct either way.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new RangeError(`Cannot compare vectors of length ${a.length} and ${b.length}.`);
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Transient failures worth retrying: rate limits, overload and 5xx. A 400 or 403 is
 * a bug or a bad key and will fail identically however many times it is retried.
 */
export function isRetryable(error: unknown): boolean {
	const status = (error as { status?: unknown })?.status;
	if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;

	const message = error instanceof Error ? error.message : String(error);
	return /\b(429|500|502|503|504)\b|rate.?limit|quota|overload|unavailable|timeout|ECONN/i.test(
		message
	);
}

/**
 * How long the server asked us to wait, in milliseconds, or null if it did not say.
 *
 * A 429 from Gemini carries a `RetryInfo` detail such as `"retryDelay": "39s"`.
 * That figure is authoritative — blind exponential backoff typically retries far
 * too early, burns the remaining attempts inside the same quota window, and
 * surfaces as a hard failure that a single correct wait would have avoided.
 */
export function retryDelayMs(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
	return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
	attempts?: number;
	baseDelayMs?: number;
	/** Ceiling on any single wait, so a huge server-suggested delay cannot hang ingest. */
	maxDelayMs?: number;
	/** Injectable so tests do not actually wait. */
	sleep?: (ms: number) => Promise<unknown>;
}

/**
 * Retry `operation` on transient failures, preferring the server's own retry hint
 * over local exponential backoff.
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	{ attempts = 4, baseDelayMs = 500, maxDelayMs = 60_000, sleep = delay }: RetryOptions = {}
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (!isRetryable(error) || attempt === attempts - 1) throw error;

			// Jitter spreads retries out so concurrent batches do not all wake together
			// and immediately re-trip the same rate limit.
			const backoff = baseDelayMs * 2 ** attempt * (0.5 + Math.random());
			const requested = retryDelayMs(error) ?? 0;
			await sleep(Math.min(Math.max(backoff, requested), maxDelayMs));
		}
	}

	throw lastError;
}

/** One API call. Returns vectors in the same order as `texts`. */
async function embedBatch(texts: string[], taskType: EmbeddingTask): Promise<number[][]> {
	const response = await withRetry(() =>
		getClient().models.embedContent({
			model: EMBEDDING_MODEL,
			contents: texts,
			config: { taskType, outputDimensionality: EMBEDDING_DIM }
		})
	);

	const embeddings = response.embeddings ?? [];
	if (embeddings.length !== texts.length) {
		throw new EmbeddingError(
			`Asked for ${texts.length} embeddings but received ${embeddings.length}.`
		);
	}

	return embeddings.map((embedding, i) => {
		const values = embedding.values;
		if (!values || values.length !== EMBEDDING_DIM) {
			throw new EmbeddingError(
				`Embedding ${i} has ${values?.length ?? 0} dimensions, expected ${EMBEDDING_DIM}.`
			);
		}
		return normalizeVector(values);
	});
}

export interface EmbedOptions {
	/** Texts per request. Lower values trade latency for gentler rate-limit pressure. */
	batchSize?: number;
}

/** Embed text in batches, preserving input order. */
async function embedAll(
	texts: string[],
	taskType: EmbeddingTask,
	{ batchSize = MAX_BATCH }: EmbedOptions = {}
): Promise<number[][]> {
	if (texts.length === 0) return [];

	if (texts.some((text) => text.trim() === '')) {
		throw new EmbeddingError('Cannot embed empty text.');
	}

	const vectors: number[][] = [];
	// Sequential rather than parallel: the free tier rate-limits aggressively, and
	// firing every batch at once is the quickest way to trip it.
	for (const batch of batched(texts, batchSize)) {
		vectors.push(...(await embedBatch(batch, taskType)));
	}
	return vectors;
}

/** Embed chunks for storage. Uses `RETRIEVAL_DOCUMENT`. */
export function embedDocuments(texts: string[], options?: EmbedOptions): Promise<number[][]> {
	return embedAll(texts, 'RETRIEVAL_DOCUMENT', options);
}

/** Embed a user question for search. Uses `RETRIEVAL_QUERY`. */
export async function embedQuery(text: string): Promise<number[]> {
	const [vector] = await embedAll([text], 'RETRIEVAL_QUERY');
	return vector;
}
