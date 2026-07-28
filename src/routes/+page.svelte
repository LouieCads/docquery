<script lang="ts">
	interface Chunk {
		index: number;
		content: string;
		pageStart: number;
		pageEnd: number;
		tokenEstimate: number;
	}

	interface Extraction {
		filename: string;
		byteSize: number;
		pageCount: number;
		emptyPages: number[];
		pages: string[];
		chunking: { targetChars: number; overlapChars: number };
		chunks: Chunk[];
	}

	let files = $state<FileList | null>(null);
	let busy = $state(false);
	let errorMessage = $state('');
	let result = $state<Extraction | null>(null);

	let view = $state<'pages' | 'chunks'>('chunks');
	let pageNumber = $state(1);
	let targetChars = $state(1000);
	let overlapChars = $state(150);

	const currentPageText = $derived(result ? (result.pages[pageNumber - 1] ?? '') : '');

	const stats = $derived.by(() => {
		if (!result?.chunks.length) return null;
		const lengths = result.chunks.map((c) => c.content.length);
		return {
			count: lengths.length,
			min: Math.min(...lengths),
			max: Math.max(...lengths),
			mean: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
			tokens: result.chunks.reduce((a, c) => a + c.tokenEstimate, 0),
			spanning: result.chunks.filter((c) => c.pageEnd > c.pageStart).length
		};
	});

	async function run(event?: SubmitEvent) {
		event?.preventDefault();
		const file = files?.[0];
		if (!file) return;

		busy = true;
		errorMessage = '';

		try {
			const body = new FormData();
			body.append('file', file);
			body.append('targetChars', String(targetChars));
			body.append('overlapChars', String(overlapChars));
			const response = await fetch('/api/documents', { method: 'POST', body });

			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				errorMessage = detail?.message ?? `Upload failed (${response.status}).`;
				result = null;
				return;
			}

			result = await response.json();
			pageNumber = 1;
		} catch {
			errorMessage = 'Could not reach the server.';
			result = null;
		} finally {
			busy = false;
		}
	}
</script>

{#snippet numberField(label: string, value: number, set: (v: number) => void, step: number)}
	<label class="flex items-center gap-2 text-sm">
		<span class="text-gray-600 dark:text-gray-400">{label}</span>
		<input
			type="number"
			min="0"
			{step}
			{value}
			oninput={(e) => set(Number(e.currentTarget.value))}
			class="w-24 rounded-md border border-gray-300 px-2 py-1 text-gray-900 tabular-nums dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
		/>
	</label>
{/snippet}

<div class="mx-auto max-w-3xl px-6 py-12">
	<h1 class="text-3xl font-semibold tracking-tight">DocQuery</h1>
	<p class="mt-2 text-gray-600 dark:text-gray-400">
		Stage 2 — split the extracted text into chunks. Change the size and overlap to see how the
		boundaries move.
	</p>

	<form onsubmit={run} class="mt-8 space-y-4">
		<div class="flex flex-wrap items-center gap-3">
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
				{busy ? 'Working…' : result ? 'Re-chunk' : 'Extract & chunk'}
			</button>
		</div>

		<div class="flex flex-wrap items-center gap-5">
			{@render numberField('Chunk size', targetChars, (v) => (targetChars = v), 100)}
			{@render numberField('Overlap', overlapChars, (v) => (overlapChars = v), 50)}
			<span class="text-xs text-gray-500 dark:text-gray-400">
				Overlap is capped at half the chunk size.
			</span>
		</div>
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

			{#if stats}
				<dl
					class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-gray-50 p-4 text-sm sm:grid-cols-3 dark:bg-gray-900"
				>
					<div>
						<dt class="inline text-gray-500 dark:text-gray-400">chunks</dt>
						<dd class="inline text-gray-900 tabular-nums dark:text-gray-100">{stats.count}</dd>
					</div>
					<div>
						<dt class="inline text-gray-500 dark:text-gray-400">mean chars</dt>
						<dd class="inline text-gray-900 tabular-nums dark:text-gray-100">{stats.mean}</dd>
					</div>
					<div>
						<dt class="inline text-gray-500 dark:text-gray-400">range</dt>
						<dd class="inline text-gray-900 tabular-nums dark:text-gray-100">
							{stats.min}–{stats.max}
						</dd>
					</div>
					<div>
						<dt class="inline text-gray-500 dark:text-gray-400">est. tokens</dt>
						<dd class="inline text-gray-900 tabular-nums dark:text-gray-100">
							{stats.tokens.toLocaleString()}
						</dd>
					</div>
					<div>
						<dt class="inline text-gray-500 dark:text-gray-400">cross-page</dt>
						<dd class="inline text-gray-900 tabular-nums dark:text-gray-100">{stats.spanning}</dd>
					</div>
				</dl>
			{/if}

			<div class="mt-6 flex gap-1 border-b border-gray-200 dark:border-gray-800">
				{#each ['chunks', 'pages'] as const as tab (tab)}
					<button
						onclick={() => (view = tab)}
						class="border-b-2 px-3 py-2 text-sm capitalize {view === tab
							? 'border-blue-600 font-medium text-blue-700 dark:text-blue-400'
							: 'border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}"
					>
						{tab}
					</button>
				{/each}
			</div>

			{#if view === 'chunks'}
				<ol class="mt-4 space-y-3">
					{#each result.chunks as chunk (chunk.index)}
						<li class="rounded-md border border-gray-200 dark:border-gray-800">
							<div
								class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"
							>
								<span class="font-medium text-gray-700 dark:text-gray-300">#{chunk.index}</span>
								<span class:font-medium={chunk.pageEnd > chunk.pageStart}>
									{chunk.pageStart === chunk.pageEnd
										? `page ${chunk.pageStart}`
										: `pages ${chunk.pageStart}–${chunk.pageEnd}`}
								</span>
								<span class="tabular-nums">{chunk.content.length} chars</span>
								<span class="tabular-nums">~{chunk.tokenEstimate} tokens</span>
							</div>
							<p class="px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">{chunk.content}</p>
						</li>
					{/each}
				</ol>
			{:else}
				<div class="mt-4 flex items-center gap-3">
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
					<span class="ml-auto text-xs text-gray-500 dark:text-gray-400"
						>{currentPageText.length} chars</span
					>
				</div>

				<pre
					class="mt-3 max-h-[28rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-4 text-xs leading-relaxed whitespace-pre-wrap text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100">{currentPageText ||
						'(no text on this page)'}</pre>
			{/if}
		</div>
	{/if}
</div>
