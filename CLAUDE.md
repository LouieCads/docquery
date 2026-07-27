# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (`.npmrc` sets `engine-strict=true`).

| Task             | Command                                                    |
| ---------------- | ---------------------------------------------------------- |
| Dev server       | `pnpm dev`                                                 |
| Production build | `pnpm build`                                               |
| Preview build    | `pnpm preview`                                             |
| Typecheck        | `pnpm check` (runs `svelte-kit sync`, then `svelte-check`) |
| Lint             | `pnpm lint` (`prettier --check .`, then `eslint .`)        |
| Format           | `pnpm format`                                              |
| Tests, once      | `pnpm test`                                                |
| Tests, watch     | `pnpm test:unit`                                           |

Running a subset of tests. Pass flags directly — **no `--` separator**. pnpm forwards a literal
`--` to vitest, where it is swallowed as a positional filter and silently drops your flags
(`pnpm test:unit -- --run --project server` still launches the browser):

```sh
pnpm test:unit --run src/lib/server/chunking.spec.ts   # one file
pnpm test:unit --run -t "splits on paragraph breaks"   # by test name
pnpm test:unit --run --project server                  # one environment
```

The `test` script in `package.json` does use `--`, but that is npm's convention and correct there.

Browser tests need Chromium downloaded once: `pnpm exec playwright install`. Without it, the
`client` project — and therefore a bare `pnpm test` — fails with "Executable doesn't exist".

## Toolchain behavior worth knowing

**Vitest runs two projects, selected by filename** (`vite.config.ts:23-50`):

- `client` — matches `src/**/*.svelte.{test,spec}.{js,ts}`, runs in real headless Chromium via
  `@vitest/browser-playwright`. Use `render` from `vitest-browser-svelte` and awaited
  `expect.element(...)` assertions. Excludes `src/lib/server/**`.
- `server` — matches `src/**/*.{test,spec}.{js,ts}` _except_ the `.svelte.` ones, runs in Node.

So the `.svelte.` infix is what routes a test to the browser. `Foo.svelte.spec.ts` and
`foo.spec.ts` run in different environments.

**`expect: { requireAssertions: true }`** — a test that makes no assertion fails rather than
passing silently.

**Runes mode is forced on** for every file outside `node_modules` (`vite.config.ts:11-15`). Use
`$props`/`$state`/`$derived`; legacy `export let` and `$:` will not work, even in files containing
no runes syntax.

**Tailwind v4 is configured CSS-first** in `src/routes/layout.css` — `@import 'tailwindcss'` plus
`@plugin` lines for forms and typography. There is no `tailwind.config.js`; theme customization
goes in that stylesheet. It is imported once, from `src/routes/+layout.svelte`.
`prettier.config.js` points `tailwindStylesheet` at the same file so class sorting resolves the
real theme.

**`svelte-kit sync` must run before typechecking** — `tsconfig.json` extends the generated
`./.svelte-kit/tsconfig.json`. `pnpm check` and the `prepare` script handle this; a bare
`svelte-check` or `tsc` on a clean checkout will not.

**ESLint reuses `.gitignore`** via `includeIgnoreFile` (`eslint.config.js:9`) — add ignores there
rather than to a separate ESLint list. `no-undef` is deliberately off, per typescript-eslint
guidance for TS projects.

**`pnpm-workspace.yaml` allowlists postinstall builds.** A new dependency with a build script must
be listed there or pnpm silently skips it (and prints `ERR_PNPM_IGNORED_BUILDS`). `@google/genai`
and `protobufjs` are deliberately set to `false` — both ship a prebuilt `dist/` and their scripts
only do work for git/local installs, verified by a runtime import check.

Prettier settings are enforced by `pnpm lint`: tabs, single quotes, no trailing commas, 100-column
width.

## Layout

- `src/routes/` — SvelteKit file-based routes. `+layout.svelte` imports the global stylesheet and
  sets the favicon.
- `src/lib/` — the `$lib` alias target.
- `src/lib/server/` — server-only modules; the Vitest `client` project excludes it, and SvelteKit
  refuses to bundle it into client code. Anything touching `SUPABASE_SERVICE_ROLE_KEY` or
  `GEMINI_API_KEY` lives here.
- Deployment uses `@sveltejs/adapter-vercel` pinned to the **Node** runtime
  (`vite.config.ts:20`) — PDF parsing and the embedding loop need Node APIs and more wall-clock
  time than an edge function allows. Note there is no `svelte.config.js` in this scaffold;
  adapter and compiler options are passed inline to the `sveltekit()` Vite plugin.

## Environment

`.env` (gitignored) supplies `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GEMINI_API_KEY`;
`.env.example` documents them and is committed. Read them via `$env/static/private` — never
`PUBLIC_*`, since the service role key bypasses row-level security.
