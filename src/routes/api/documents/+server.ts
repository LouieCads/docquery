import { error, json } from '@sveltejs/kit';
import { extractPages, PdfExtractionError } from '$lib/server/pdf';
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

	// Stage 1 returns the extraction so you can read it. Stage 2 chunks it,
	// and Stage 4 is where any of this first gets persisted.
	return json({
		filename: file.name,
		byteSize: file.size,
		pageCount: pages.length,
		emptyPages: pages.flatMap((page, i) => (page.length === 0 ? [i + 1] : [])),
		pages
	});
};
