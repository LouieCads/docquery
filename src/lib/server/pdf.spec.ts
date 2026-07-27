import { describe, expect, it } from 'vitest';
import { extractPages, looksLikePdf, normalizePageText, PdfExtractionError } from './pdf';

/**
 * Build a real, structurally valid PDF with one page per string, so these tests
 * exercise the actual pdf.js parsing path rather than a mock. Offsets in the xref
 * table are computed from the emitted string, which is safe because every byte
 * written here is ASCII.
 */
function buildPdf(pageTexts: string[]): Uint8Array {
	const objects: string[] = [];
	const pageNums: number[] = [];
	const pages = pageTexts.map((text) => ({ contentNum: 0, pageNum: 0, text }));

	let next = 4; // 1 = catalog, 2 = page tree, 3 = font
	for (const page of pages) {
		page.contentNum = next++;
		page.pageNum = next++;
		pageNums.push(page.pageNum);
	}

	objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
	objects[2] =
		`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}]` +
		` /Count ${pages.length} >>`;
	objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

	for (const page of pages) {
		const escaped = page.text.replace(/([\\()])/g, '\\$1');
		const stream = `BT /F1 12 Tf 20 100 Td (${escaped}) Tj ET`;
		objects[page.contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
		objects[page.pageNum] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]` +
			` /Contents ${page.contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
	}

	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	for (let i = 1; i < objects.length; i++) {
		offsets[i] = pdf.length;
		pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
	}

	const xrefStart = pdf.length;
	pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let i = 1; i < objects.length; i++) {
		pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\n`;
	pdf += `startxref\n${xrefStart}\n%%EOF\n`;

	return new TextEncoder().encode(pdf);
}

describe('looksLikePdf', () => {
	it('accepts the %PDF- signature', () => {
		expect(looksLikePdf(buildPdf(['hi']))).toBe(true);
	});

	it('rejects a file that merely claims to be a PDF', () => {
		expect(looksLikePdf(new TextEncoder().encode('not a pdf at all'))).toBe(false);
	});

	it('tolerates leading junk before the signature, as the spec allows', () => {
		const padded = new Uint8Array([...new TextEncoder().encode('\n\n\n'), ...buildPdf(['hi'])]);
		expect(looksLikePdf(padded)).toBe(true);
	});

	it('ignores a signature that appears beyond the first 1024 bytes', () => {
		const junk = new Uint8Array(2048); // zero-filled
		const late = new Uint8Array([...junk, ...buildPdf(['hi'])]);
		expect(looksLikePdf(late)).toBe(false);
	});
});

describe('normalizePageText', () => {
	it('preserves the blank line that Stage 2 splits paragraphs on', () => {
		expect(normalizePageText('First para.\n\nSecond para.')).toBe('First para.\n\nSecond para.');
	});

	it('collapses runs of blank lines to a single paragraph break', () => {
		expect(normalizePageText('a\n\n\n\n\nb')).toBe('a\n\nb');
	});

	it('normalizes CRLF and lone CR to LF', () => {
		expect(normalizePageText('a\r\nb\rc')).toBe('a\nb\nc');
	});

	it('strips trailing whitespace without eating the newline', () => {
		expect(normalizePageText('a   \t\nb')).toBe('a\nb');
	});

	it('trims leading and trailing whitespace overall', () => {
		expect(normalizePageText('\n\n  text  \n\n')).toBe('text');
	});
});

describe('extractPages', () => {
	it('returns one entry per page, in page order', async () => {
		const pages = await extractPages(buildPdf(['Page one text', 'Page two text']));
		expect(pages).toHaveLength(2);
		expect(pages[0]).toContain('Page one text');
		expect(pages[1]).toContain('Page two text');
	});

	it('rejects a file that is not a PDF', async () => {
		const notPdf = new TextEncoder().encode('just some text');
		await expect(extractPages(notPdf)).rejects.toThrow(PdfExtractionError);
		await expect(extractPages(notPdf)).rejects.toMatchObject({ code: 'not-a-pdf' });
	});

	it('fails loudly when there is no text layer, rather than returning empty strings', async () => {
		// Structurally valid, but every page draws an empty string — the shape a
		// scanned document has once its image layer is ignored.
		await expect(extractPages(buildPdf(['', '']))).rejects.toMatchObject({
			code: 'no-text-layer'
		});
	});

	it('refuses a document over the page limit', async () => {
		const pdf = buildPdf(['a', 'b', 'c']);
		await expect(extractPages(pdf, { maxPages: 2 })).rejects.toMatchObject({
			code: 'too-many-pages'
		});
	});

	it('keeps a page that has text even when a sibling page is empty', async () => {
		const pages = await extractPages(buildPdf(['', 'Only this page has text']));
		expect(pages[0]).toBe('');
		expect(pages[1]).toContain('Only this page has text');
	});
});
