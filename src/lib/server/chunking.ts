/**
 * Splitting extracted page text into embeddable chunks.
 *
 * Two independent constraints drive the sizing. An embedding is one fixed-size
 * vector, so an oversized chunk averages several topics into a point that matches
 * nothing precisely. And retrieved chunks become prompt context, which is finite.
 * Small chunks retrieve precisely but lose surrounding context; large chunks keep
 * context but blur the vector. Stage 7 tunes this against an eval set.
 */

/** Packing target for a chunk's own content, in characters. */
export const DEFAULT_TARGET_CHARS = 1000;

/** How much of the previous chunk's tail to repeat at the head of the next. */
export const DEFAULT_OVERLAP_CHARS = 150;

/**
 * Tried in order, coarsest first. Each level keeps a larger semantic unit intact:
 * paragraph, then line, then sentence, then word. `''` is the last resort — a hard
 * character cut, reached only by an unbroken run longer than the target.
 */
export const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

export interface ChunkOptions {
	targetChars?: number;
	overlapChars?: number;
	separators?: string[];
}

export interface Chunk {
	/** Position in the document, 0-based and gap-free. */
	index: number;
	content: string;
	/** 1-based, inclusive. Equal unless the chunk straddles a page break. */
	pageStart: number;
	pageEnd: number;
	tokenEstimate: number;
}

/**
 * Rough proxy for a real tokenizer: English prose averages ~4 characters per token.
 *
 * TODO(stage 7): replace with real tokenization. This under-counts code, tables and
 * non-Latin scripts badly, which matters once it drives the context budget.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Split on `separator`, keeping it attached to the piece it followed, so joining is lossless. */
function splitKeepingSeparator(text: string, separator: string): string[] {
	if (separator === '') return [...text];
	const parts = text.split(separator);
	return parts
		.map((part, i) => (i < parts.length - 1 ? part + separator : part))
		.filter((part) => part.length > 0);
}

/**
 * Break `text` into pieces no longer than `maxChars`, descending the separator
 * hierarchy only as far as needed. A paragraph already under the limit is returned
 * whole; only an oversized one is split further.
 */
function splitToPieces(text: string, maxChars: number, separators: string[]): string[] {
	if (text.length === 0) return [];
	if (text.length <= maxChars) return [text];

	const [separator, ...rest] = separators;

	// Out of separators: hard-cut on character count.
	if (separator === undefined) {
		const pieces: string[] = [];
		for (let i = 0; i < text.length; i += maxChars) pieces.push(text.slice(i, i + maxChars));
		return pieces;
	}

	// Re-pack fragments greedily, so splitting on '\n\n' does not turn every short
	// paragraph into its own undersized piece.
	const pieces: string[] = [];
	let buffer = '';

	const flush = () => {
		if (buffer.length > 0) pieces.push(buffer);
		buffer = '';
	};

	for (const fragment of splitKeepingSeparator(text, separator)) {
		if (fragment.length > maxChars) {
			flush();
			pieces.push(...splitToPieces(fragment, maxChars, rest));
			continue;
		}
		if (buffer.length + fragment.length > maxChars) flush();
		buffer += fragment;
	}
	flush();

	return pieces;
}

/** A piece of text that still knows which page it came from. */
interface Piece {
	text: string;
	page: number;
}

/** Take up to `maxChars` from the end of `text`, backing off to a word boundary. */
function tailAtWordBoundary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const tail = text.slice(text.length - maxChars);
	const firstSpace = tail.search(/\s/);
	return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

/**
 * Split extracted pages into chunks.
 *
 * `pages` is the array from `extractPages`: index 0 is page 1. Empty pages are
 * skipped without disturbing the numbering of later ones.
 *
 * A chunk's content can reach `targetChars + overlapChars` in the worst case, since
 * overlap is prepended to a chunk that is already allowed to fill the target.
 */
export function chunkPages(pages: string[], options: ChunkOptions = {}): Chunk[] {
	const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS;
	const separators = options.separators ?? DEFAULT_SEPARATORS;

	// Overlap at or above the target would leave no room for new content and emit
	// chunks that barely advance through the document.
	const overlapChars = Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, targetChars >> 1);

	if (targetChars < 1) throw new RangeError('targetChars must be at least 1.');

	// Terminate each page with a paragraph break so pieces join cleanly across a
	// page boundary, and so '\n\n' is available as a split point on the last line.
	const pieces: Piece[] = pages.flatMap((pageText, i) =>
		splitToPieces(pageText.trim() === '' ? '' : pageText + '\n\n', targetChars, separators).map(
			(text) => ({ text, page: i + 1 })
		)
	);

	const chunks: Chunk[] = [];
	let current: Piece[] = [];
	let currentLength = 0;

	const emit = () => {
		const content = current
			.map((piece) => piece.text)
			.join('')
			.trim();
		if (content.length === 0) return;

		const pageNumbers = current.map((piece) => piece.page);
		chunks.push({
			index: chunks.length,
			content,
			pageStart: Math.min(...pageNumbers),
			pageEnd: Math.max(...pageNumbers),
			tokenEstimate: estimateTokens(content)
		});
	};

	for (const piece of pieces) {
		if (currentLength + piece.text.length > targetChars && current.length > 0) {
			emit();

			// Carry the tail of the chunk just emitted into the next one, so a fact
			// straddling this boundary survives whole on at least one side.
			const carried: Piece[] = [];
			let carriedLength = 0;
			for (let i = current.length - 1; i >= 0 && carriedLength < overlapChars; i--) {
				const tail = tailAtWordBoundary(current[i].text, overlapChars - carriedLength);
				if (tail.length === 0) break;
				carried.unshift({ text: tail, page: current[i].page });
				carriedLength += tail.length;
			}

			current = carried;
			currentLength = carriedLength;
		}

		current.push(piece);
		currentLength += piece.text.length;
	}

	emit();
	return chunks;
}
