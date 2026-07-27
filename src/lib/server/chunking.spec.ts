import { describe, expect, it } from 'vitest';
import { chunkPages, estimateTokens, type Chunk } from './chunking';

/** Text of a known length made of real words, so word-boundary logic is exercised. */
function words(totalChars: number, word = 'lorem'): string {
	let out = '';
	while (out.length < totalChars) out += (out.length ? ' ' : '') + word;
	return out.slice(0, totalChars).trim();
}

/**
 * Like `words`, but every token is distinct (`w0000 w0001 …`). Necessary wherever a
 * test compares chunks to each other: with uniform filler, two chunks from different
 * offsets are byte-identical and any such assertion passes or fails by accident.
 */
function uniqueWords(count: number): string {
	return Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' ');
}

/** Strip whitespace so comparisons ignore the joining/trimming the chunker does. */
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('estimateTokens', () => {
	it('approximates four characters per token', () => {
		expect(estimateTokens('a'.repeat(400))).toBe(100);
	});

	it('rounds up, so a short string never estimates zero tokens', () => {
		expect(estimateTokens('hi')).toBe(1);
	});
});

describe('chunkPages — sizing', () => {
	it('keeps every chunk within target + overlap', () => {
		const chunks = chunkPages([words(9000)], { targetChars: 500, overlapChars: 100 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(600);
	});

	it('leaves a document shorter than the target as a single chunk', () => {
		const chunks = chunkPages(['Short document.'], { targetChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].content).toBe('Short document.');
	});

	it('splits an unbroken run with no separators at all', () => {
		// 5000 characters, no spaces or newlines: every separator fails and the
		// splitter must fall back to a hard character cut.
		const chunks = chunkPages(['x'.repeat(5000)], { targetChars: 1000, overlapChars: 0 });
		expect(chunks.length).toBeGreaterThanOrEqual(5);
		for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1000);
	});

	it('produces smaller chunks as the target shrinks', () => {
		const text = words(6000);
		const big = chunkPages([text], { targetChars: 2000, overlapChars: 100 });
		const small = chunkPages([text], { targetChars: 500, overlapChars: 100 });
		expect(small.length).toBeGreaterThan(big.length);
	});

	it('clamps overlap below the target so chunks always advance', () => {
		// Overlap at or above the target would leave no room for new content, and the
		// chunker would emit near-identical chunks that barely move through the text.
		const chunks = chunkPages([uniqueWords(700)], { targetChars: 400, overlapChars: 10_000 });
		expect(chunks.length).toBeLessThan(40);
		expect(new Set(chunks.map((c) => c.content)).size).toBe(chunks.length);
	});
});

describe('chunkPages — separator hierarchy', () => {
	it('prefers paragraph breaks over cutting mid-sentence', () => {
		const paragraphs = [words(400, 'alpha'), words(400, 'beta'), words(400, 'gamma')];
		const chunks = chunkPages([paragraphs.join('\n\n')], {
			targetChars: 450,
			overlapChars: 0
		});
		// Each paragraph is under the target, so no chunk should mix two of them.
		for (const chunk of chunks) {
			const families = ['alpha', 'beta', 'gamma'].filter((w) => chunk.content.includes(w));
			expect(families).toHaveLength(1);
		}
	});

	it('packs several short paragraphs together rather than emitting tiny chunks', () => {
		const page = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
		const chunks = chunkPages([page], { targetChars: 1000, overlapChars: 0 });
		expect(chunks).toHaveLength(1);
	});

	it('falls back to sentence boundaries inside an oversized paragraph', () => {
		const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(' ');
		const chunks = chunkPages([sentences], { targetChars: 300, overlapChars: 0 });
		expect(chunks.length).toBeGreaterThan(1);
		// A sentence-level split keeps the terminating period with its sentence.
		for (const chunk of chunks.slice(0, -1)) expect(chunk.content.endsWith('.')).toBe(true);
	});
});

describe('chunkPages — overlap', () => {
	it('repeats the tail of each chunk at the head of the next', () => {
		const chunks = chunkPages([uniqueWords(700)], { targetChars: 500, overlapChars: 120 });
		expect(chunks.length).toBeGreaterThan(2);

		// Overlap means precisely this: the opening of each chunk already appeared at
		// the end of the one before it, so a fact split across the boundary survives.
		for (let i = 1; i < chunks.length; i++) {
			const head = squash(chunks[i].content).slice(0, 40);
			expect(squash(chunks[i - 1].content)).toContain(head);
		}
	});

	it('emits no overlap when it is disabled', () => {
		const chunks = chunkPages([words(3000)], { targetChars: 400, overlapChars: 0 });
		const rejoined = squash(chunks.map((c) => c.content).join(' '));
		expect(rejoined).toBe(squash(words(3000)));
	});

	it('does not start an overlap mid-word', () => {
		const chunks = chunkPages([words(4000, 'distinctive')], {
			targetChars: 600,
			overlapChars: 150
		});
		for (const chunk of chunks.slice(1)) {
			const firstWord = chunk.content.split(/\s+/)[0];
			expect(['distinctive', '']).toContain(firstWord);
		}
	});
});

describe('chunkPages — page provenance', () => {
	it('attributes a chunk to the page it came from', () => {
		const chunks = chunkPages(['Alpha content.', 'Beta content.', 'Gamma content.'], {
			targetChars: 20,
			overlapChars: 0
		});
		const forBeta = chunks.find((c) => c.content.includes('Beta'))!;
		expect(forBeta.pageStart).toBe(2);
		expect(forBeta.pageEnd).toBe(2);
	});

	it('records a page range when a chunk straddles a page break', () => {
		const chunks = chunkPages(['Alpha.', 'Beta.', 'Gamma.'], {
			targetChars: 1000,
			overlapChars: 0
		});
		expect(chunks).toHaveLength(1);
		expect(chunks[0].pageStart).toBe(1);
		expect(chunks[0].pageEnd).toBe(3);
	});

	it('skips empty pages without shifting later page numbers', () => {
		const chunks = chunkPages(['', '', 'Text on page three.'], { targetChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].pageStart).toBe(3);
	});

	it('never reports a page outside the document', () => {
		const pages = Array.from({ length: 5 }, (_, i) => words(800, `page${i}`));
		for (const chunk of chunkPages(pages, { targetChars: 400, overlapChars: 80 })) {
			expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
			expect(chunk.pageEnd).toBeLessThanOrEqual(5);
			expect(chunk.pageStart).toBeLessThanOrEqual(chunk.pageEnd);
		}
	});
});

describe('chunkPages — invariants', () => {
	const sample = [words(2500, 'alpha'), words(2500, 'beta'), words(1200, 'gamma')];

	it('indexes chunks sequentially from zero with no gaps', () => {
		const chunks = chunkPages(sample, { targetChars: 700, overlapChars: 100 });
		expect(chunks.map((c: Chunk) => c.index)).toEqual(chunks.map((_, i) => i));
	});

	it('never emits an empty or whitespace-only chunk', () => {
		const chunks = chunkPages(['', '   \n\n  ', ...sample], { targetChars: 300 });
		for (const chunk of chunks) expect(chunk.content.trim().length).toBeGreaterThan(0);
	});

	it('returns nothing for a document with no text', () => {
		expect(chunkPages(['', '  ', '\n\n'])).toEqual([]);
	});

	it('preserves all content when overlap is off', () => {
		const chunks = chunkPages(sample, { targetChars: 400, overlapChars: 0 });
		const rejoined = squash(chunks.map((c) => c.content).join(' '));
		expect(rejoined).toBe(squash(sample.join(' ')));
	});

	it('estimates tokens consistently with the content it stores', () => {
		for (const chunk of chunkPages(sample, { targetChars: 500 })) {
			expect(chunk.tokenEstimate).toBe(estimateTokens(chunk.content));
		}
	});
});
