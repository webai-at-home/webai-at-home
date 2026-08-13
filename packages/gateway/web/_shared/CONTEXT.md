# Directory Context: `/packages/gateway/web/_shared`

## Purpose

What every browser page the gateway serves — `home`, `monitor`, `ledger`, `debug`, and each per-task-type debug page — needs in common, so no one page keeps its own copy.

## Key Exports & Entry Points

- `theme_toggle.ts`: `ThemeToggle`, the six-hour light or dark theme preference control shown in a page's navigation bar.
- `debug_iframe_worker_frames.ts`: `DebugIframeWorkerFrames`, which points every worker inline frame at the address the debug page itself was opened from.
- `global.d.ts`: the declarations for the values [`vite.config.ts`](../../vite.config.ts) bakes into a page with the `define` option.

## Rules

- A value used by more than one page's `src/` belongs here; a value only one page needs stays in that page's own `src/`.
- A value declared in `global.d.ts` must also be set by the `define` option in [`vite.config.ts`](../../vite.config.ts), or a page reads it as `undefined` in the production build and fails with a `ReferenceError` in development.

## Background

- Every one of `home`, `monitor`, `ledger`, and `debug` imports from this folder; see the package's own [`CONTEXT.md`](../../CONTEXT.md) for how a page is registered.
