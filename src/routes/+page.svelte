<script lang="ts">
	interface Extraction {
		filename: string;
		byteSize: number;
		pageCount: number;
		emptyPages: number[];
		pages: string[];
	}

	let files = $state<FileList | null>(null);
	let busy = $state(false);
	let errorMessage = $state('');
	let result = $state<Extraction | null>(null);
	let pageNumber = $state(1);

	const currentText = $derived(result ? (result.pages[pageNumber - 1] ?? '') : '');

	async function upload(event: SubmitEvent) {
		event.preventDefault();
		const file = files?.[0];
		if (!file) return;

		busy = true;
		errorMessage = '';
		result = null;

		try {
			const body = new FormData();
			body.append('file', file);
			const response = await fetch('/api/documents', { method: 'POST', body });

			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				errorMessage = detail?.message ?? `Upload failed (${response.status}).`;
				return;
			}

			result = await response.json();
			pageNumber = 1;
		} catch {
			errorMessage = 'Could not reach the server.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="mx-auto max-w-3xl px-6 py-12">
	<h1 class="text-3xl font-semibold tracking-tight">DocQuery</h1>
	<p class="mt-2 text-gray-600 dark:text-gray-400">
		Stage 1 — extract the text layer from a PDF and read exactly what the model will see.
	</p>

	<form onsubmit={upload} class="mt-8 flex flex-wrap items-center gap-3">
		<input
			type="file"
			accept="application/pdf,.pdf"
			bind:files
			class="block flex-1 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-700 dark:file:bg-gray-100 dark:file:text-gray-900"
		/>
		<button
			type="submit"
			disabled={busy || !files?.length}
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
		>
			{busy ? 'Extracting…' : 'Extract text'}
		</button>
	</form>

	{#if errorMessage}
		<p
			class="mt-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
		>
			{errorMessage}
		</p>
	{/if}

	{#if result}
		<div class="mt-8 border-t border-gray-200 pt-6 dark:border-gray-800">
			<p class="text-sm text-gray-600 dark:text-gray-400">
				<span class="font-medium text-gray-900 dark:text-gray-100">{result.filename}</span>
				· {result.pageCount} page{result.pageCount === 1 ? '' : 's'}
				· {(result.byteSize / 1024).toFixed(0)} KB
			</p>

			{#if result.emptyPages.length}
				<p
					class="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
				>
					No text on page{result.emptyPages.length === 1 ? '' : 's'}
					{result.emptyPages.join(', ')} — probably a scan, a full-page image, or a chart.
				</p>
			{/if}

			<div class="mt-6 flex items-center gap-3">
				<button
					onclick={() => (pageNumber = Math.max(1, pageNumber - 1))}
					disabled={pageNumber <= 1}
					class="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:opacity-40 dark:border-gray-700"
				>
					Prev
				</button>
				<span class="text-sm tabular-nums">Page {pageNumber} / {result.pageCount}</span>
				<button
					onclick={() => (pageNumber = Math.min(result!.pageCount, pageNumber + 1))}
					disabled={pageNumber >= result.pageCount}
					class="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:opacity-40 dark:border-gray-700"
				>
					Next
				</button>
				<span class="ml-auto text-xs text-gray-500">{currentText.length} chars</span>
			</div>

			<pre
				class="mt-3 max-h-[28rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4 text-xs leading-relaxed whitespace-pre-wrap dark:border-gray-800 dark:bg-gray-900">{currentText ||
					'(no text on this page)'}</pre>
		</div>
	{/if}
</div>
