import { error, json } from '@sveltejs/kit';
import { extractPages, PdfExtractionError } from '$lib/server/pdf';
import { chunkPages, DEFAULT_OVERLAP_CHARS, DEFAULT_TARGET_CHARS } from '$lib/server/chunking';
import type { RequestHandler } from './$types';

/** Roughly the largest text PDF that can be read, chunked and embedded in one request. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Map our own error codes onto HTTP status codes the client can branch on. */
const STATUS_BY_CODE = {
	'not-a-pdf': 415, // Unsupported Media Type
	unreadable: 422, // Unprocessable Content
	'too-many-pages': 413, // Content Too Large
	'no-text-layer': 422
} as const;

/** Read a positive integer from the form, falling back when absent or malformed. */
function readSize(form: FormData, field: string, fallback: number, max: number): number {
	const raw = form.get(field);
	if (typeof raw !== 'string' || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), 0), max);
}

export const POST: RequestHandler = async ({ request }) => {
	const form = await request.formData();
	const file = form.get('file');

	if (!(file instanceof File) || file.size === 0) {
		error(400, 'Attach a PDF in the "file" field.');
	}
	if (file.size > MAX_BYTES) {
		const mb = (file.size / 1024 / 1024).toFixed(1);
		error(413, `That file is ${mb} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`);
	}

	const data = new Uint8Array(await file.arrayBuffer());

	let pages: string[];
	try {
		pages = await extractPages(data);
	} catch (err) {
		if (err instanceof PdfExtractionError) error(STATUS_BY_CODE[err.code], err.message);
		throw err;
	}

	// Chunk sizing is caller-supplied so the trade-off can be explored from the UI.
	// Stage 7 pins these down against an eval set; Stage 4 starts persisting them.
	const targetChars = readSize(form, 'targetChars', DEFAULT_TARGET_CHARS, 8000);
	const overlapChars = readSize(form, 'overlapChars', DEFAULT_OVERLAP_CHARS, 4000);
	const chunks = chunkPages(pages, { targetChars, overlapChars });

	return json({
		filename: file.name,
		byteSize: file.size,
		pageCount: pages.length,
		emptyPages: pages.flatMap((page, i) => (page.length === 0 ? [i + 1] : [])),
		pages,
		chunking: { targetChars, overlapChars },
		chunks
	});
};
