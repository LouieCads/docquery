import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Hard ceiling for v1. Ingest is a single serverless request, and Vercel Hobby
 * functions time out long before a large PDF finishes embedding. Raising this
 * means moving ingest to a background job first (see the deployment notes).
 */
export const MAX_PAGES = 50;

export type PdfErrorCode = 'not-a-pdf' | 'unreadable' | 'too-many-pages' | 'no-text-layer';

/** Thrown for input we can identify as bad, as opposed to an unexpected crash. */
export class PdfExtractionError extends Error {
	readonly code: PdfErrorCode;

	constructor(code: PdfErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PdfExtractionError';
		this.code = code;
	}
}

/**
 * Check for the `%PDF-` signature rather than trusting the browser-supplied MIME
 * type or the file extension, either of which the client controls. The spec allows
 * leading junk, so long as the signature appears within the first 1024 bytes.
 */
export function looksLikePdf(data: Uint8Array): boolean {
	const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
	const limit = Math.min(data.length, 1024);

	outer: for (let start = 0; start + signature.length <= limit; start++) {
		for (let i = 0; i < signature.length; i++) {
			if (data[start + i] !== signature[i]) continue outer;
		}
		return true;
	}
	return false;
}

/**
 * Light cleanup only. Deliberately preserves blank lines, because the blank line is
 * the paragraph boundary that Stage 2 splits on first — collapsing it here would
 * destroy the structure chunking depends on.
 */
export function normalizePageText(raw: string): string {
	return raw
		.replace(/\r\n?/g, '\n') // CRLF and lone CR -> LF
		.replace(/[^\S\n]+\n/g, '\n') // trailing spaces/tabs at end of line
		.replace(/\n{3,}/g, '\n\n') // runs of blank lines -> one blank line
		.trim();
}

/**
 * Extract one string per page, in page order: `pages[0]` is page 1.
 *
 * Pages are kept separate rather than merged so that chunks can record which page
 * they came from, which is what lets the final answer cite "page 7".
 */
export async function extractPages(
	data: Uint8Array,
	{ maxPages = MAX_PAGES }: { maxPages?: number } = {}
): Promise<string[]> {
	if (!looksLikePdf(data)) {
		throw new PdfExtractionError('not-a-pdf', 'That file is not a PDF.');
	}

	let pdf;
	try {
		pdf = await getDocumentProxy(data);
	} catch (cause) {
		throw new PdfExtractionError('unreadable', 'This PDF could not be opened.', { cause });
	}

	// Check the page count before extracting: numPages is read from the document
	// catalog and is cheap, whereas extraction walks every content stream.
	if (pdf.numPages > maxPages) {
		throw new PdfExtractionError(
			'too-many-pages',
			`This PDF has ${pdf.numPages} pages; the current limit is ${maxPages}.`
		);
	}

	const { text } = await extractText(pdf, { mergePages: false });
	const pages = (Array.isArray(text) ? text : [text]).map(normalizePageText);

	// A scanned PDF is an image of text with no text layer. Extraction "succeeds"
	// and returns nothing, so fail loudly instead of embedding empty strings.
	if (pages.every((page) => page.length === 0)) {
		throw new PdfExtractionError(
			'no-text-layer',
			'No text found. This is most likely a scanned PDF, which needs OCR first.'
		);
	}

	return pages;
}
