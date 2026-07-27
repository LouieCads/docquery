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
pnpm test:unit --run src/lib/vitest-examples/greet.spec.ts   # one file
pnpm test:unit --run -t "returns a greeting"                 # by test name
pnpm test:unit --run --project server                        # one environment
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

**`pnpm-workspace.yaml` allowlists native postinstall builds** (`@tailwindcss/oxide`, `esbuild`).
A new dependency with a build script must be added there or pnpm silently skips its build.

Prettier settings are enforced by `pnpm lint`: tabs, single quotes, no trailing commas, 100-column
width.

## Layout

- `src/routes/` — SvelteKit file-based routes. `+layout.svelte` imports the global stylesheet and
  sets the favicon.
- `src/lib/` — the `$lib` alias target.
- `src/lib/server/` — does not exist yet, but the Vitest `client` project already excludes it;
  that is the convention for server-only modules.
- Deployment uses `@sveltejs/adapter-auto`. Swap in a target-specific adapter before deploying
  anywhere adapter-auto does not detect.

`src/lib/vitest-examples/` is scaffold sample code demonstrating both test environments. It is
safe to delete once real tests exist.
