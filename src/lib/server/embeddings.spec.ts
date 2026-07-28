import { describe, expect, it, vi } from 'vitest';
import {
	batched,
	cosineSimilarity,
	EMBEDDING_DIM,
	isRetryable,
	normalizeVector,
	retryDelayMs,
	withRetry
} from './embeddings';

/** The shape Gemini actually returns on a free-tier 429, trimmed to what we parse. */
const quotaError = (seconds: number) =>
	new Error(
		JSON.stringify({
			error: {
				code: 429,
				status: 'RESOURCE_EXHAUSTED',
				details: [
					{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${seconds}s` }
				]
			}
		})
	);

/** Length of a vector, for asserting normalization. */
const magnitude = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

describe('normalizeVector', () => {
	it('scales a vector to unit length', () => {
		expect(magnitude(normalizeVector([3, 4]))).toBeCloseTo(1, 10);
	});

	it('preserves direction', () => {
		// [3,4] normalized is [0.6,0.8]: same heading, length 1.
		const [x, y] = normalizeVector([3, 4]);
		expect(x).toBeCloseTo(0.6, 10);
		expect(y).toBeCloseTo(0.8, 10);
	});

	it('handles the sub-unit norm that Matryoshka truncation produces', () => {
		// A 768-slice of a 3072-dim unit vector measures ~0.58 in practice.
		const truncated = Array.from({ length: EMBEDDING_DIM }, () => 0.021);
		expect(magnitude(truncated)).toBeLessThan(1);
		expect(magnitude(normalizeVector(truncated))).toBeCloseTo(1, 10);
	});

	it('leaves a zero vector alone instead of dividing by zero', () => {
		const zeros = normalizeVector([0, 0, 0]);
		expect(zeros).toEqual([0, 0, 0]);
		expect(zeros.every(Number.isFinite)).toBe(true);
	});

	it('does not mutate its input', () => {
		const original = [3, 4];
		normalizeVector(original);
		expect(original).toEqual([3, 4]);
	});
});

describe('cosineSimilarity', () => {
	it('scores identical direction as 1', () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
	});

	it('scores orthogonal vectors as 0', () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
	});

	it('scores opposite direction as -1', () => {
		expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
	});

	it('ignores magnitude, which is why it suits chunks of differing length', () => {
		// Same direction, 100x the length: a long chunk and a short one on the same
		// topic should not be pushed apart by size alone.
		expect(cosineSimilarity([1, 2], [100, 200])).toBeCloseTo(1, 10);
	});

	it('equals the dot product for unit vectors', () => {
		const a = normalizeVector([0.3, -0.7, 0.2]);
		const b = normalizeVector([0.9, 0.1, -0.4]);
		const dot = a.reduce((sum, x, i) => sum + x * b[i], 0);
		expect(cosineSimilarity(a, b)).toBeCloseTo(dot, 10);
	});

	it('refuses to compare mismatched dimensions', () => {
		expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
	});

	it('returns 0 rather than NaN when a vector is all zeros', () => {
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
});

describe('batched', () => {
	it('splits into full groups plus a remainder', () => {
		expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('returns one group when everything fits', () => {
		expect(batched([1, 2, 3], 100)).toEqual([[1, 2, 3]]);
	});

	it('returns nothing for an empty input', () => {
		expect(batched([], 10)).toEqual([]);
	});

	it('preserves order across groups', () => {
		const items = Array.from({ length: 250 }, (_, i) => i);
		expect(batched(items, 100).flat()).toEqual(items);
	});

	it('rejects a nonsensical batch size', () => {
		expect(() => batched([1], 0)).toThrow(RangeError);
	});
});

describe('isRetryable', () => {
	it('retries rate limits and server errors by status', () => {
		expect(isRetryable({ status: 429 })).toBe(true);
		expect(isRetryable({ status: 503 })).toBe(true);
		expect(isRetryable({ status: 408 })).toBe(true);
	});

	it('does not retry a bad request or a bad key', () => {
		expect(isRetryable({ status: 400 })).toBe(false);
		expect(isRetryable({ status: 403 })).toBe(false);
		expect(isRetryable({ status: 404 })).toBe(false);
	});

	it('falls back to the message when no status is attached', () => {
		expect(isRetryable(new Error('429 Too Many Requests'))).toBe(true);
		expect(isRetryable(new Error('Resource exhausted: quota exceeded'))).toBe(true);
		expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
	});

	it('treats an unrecognized error as permanent', () => {
		expect(isRetryable(new Error('Invalid taskType'))).toBe(false);
	});
});

describe('retryDelayMs', () => {
	it('reads the server-supplied RetryInfo delay', () => {
		expect(retryDelayMs(quotaError(39))).toBe(39_000);
	});

	it('rounds a fractional delay up to whole milliseconds', () => {
		expect(retryDelayMs(quotaError(39.731732312))).toBe(39_732);
	});

	it('returns null when the error carries no hint', () => {
		expect(retryDelayMs(new Error('boom'))).toBeNull();
		expect(retryDelayMs({ status: 429 })).toBeNull();
	});
});

describe('withRetry', () => {
	const noSleep = () => Promise.resolve();

	it('returns immediately when the call succeeds', async () => {
		const operation = vi.fn().mockResolvedValue('ok');
		await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('retries a rate limit and returns the eventual success', async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce({ status: 429 })
			.mockRejectedValueOnce({ status: 429 })
			.mockResolvedValue('ok');

		await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it('gives up after the attempt limit and rethrows', async () => {
		const operation = vi.fn().mockRejectedValue({ status: 503 });
		await expect(withRetry(operation, { attempts: 3, sleep: noSleep })).rejects.toEqual({
			status: 503
		});
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it('does not retry a permanent error', async () => {
		const operation = vi.fn().mockRejectedValue({ status: 400 });
		await expect(withRetry(operation, { sleep: noSleep })).rejects.toEqual({ status: 400 });
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('waits as long as the server asked, not just its own backoff', async () => {
		// The real failure mode this guards: local backoff tops out around 6s, the
		// server wants 39s, so all attempts are spent inside the same quota window.
		const waits: number[] = [];
		const operation = vi.fn().mockRejectedValueOnce(quotaError(39)).mockResolvedValue('ok');

		await withRetry(operation, {
			baseDelayMs: 500,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			}
		});

		expect(waits[0]).toBe(39_000);
	});

	it('caps a single wait so an extreme hint cannot hang ingest', async () => {
		const waits: number[] = [];
		const operation = vi.fn().mockRejectedValueOnce(quotaError(3600)).mockResolvedValue('ok');

		await withRetry(operation, {
			maxDelayMs: 10_000,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			}
		});

		expect(waits[0]).toBe(10_000);
	});

	it('doubles the backoff window on each successive attempt', async () => {
		const waits: number[] = [];
		const operation = vi
			.fn()
			.mockRejectedValueOnce({ status: 429 })
			.mockRejectedValueOnce({ status: 429 })
			.mockResolvedValue('ok');

		await withRetry(operation, {
			baseDelayMs: 100,
			sleep: (ms) => {
				waits.push(ms);
				return Promise.resolve();
			}
		});

		// Each wait is base * 2^attempt * jitter, with jitter in [0.5, 1.5). Assert the
		// band rather than waits[1] > waits[0]: consecutive bands overlap (50-150 and
		// 100-300), so a strict ordering assertion fails at random.
		expect(waits).toHaveLength(2);
		expect(waits[0]).toBeGreaterThanOrEqual(50);
		expect(waits[0]).toBeLessThan(150);
		expect(waits[1]).toBeGreaterThanOrEqual(100);
		expect(waits[1]).toBeLessThan(300);
	});
});
