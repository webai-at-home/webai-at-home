# Directory Context: `/packages/gateway`

## Purpose

The central HTTP and WebSocket gateway of `webai-at-home`. It authenticates and registers consumer and worker connections, holds the queue of tasks, assigns pipeline stages to workers, tracks task progress, records the accounting ledger, and relays the signalling messages workers use to reach each other.

## Key Exports & Entry Points

- `src/cli.ts`: the program that starts the gateway. Command to run this folder: `npm run dev --workspace @webai/gateway`.
- `src/connection/`, `src/task/`, `src/device/`, `src/accounting/`: accepting a connection, the queue and the placement of stages, which workers are connected, and the ledger.
- `src/libs/gateway_settings.ts`: every option and environment variable the gateway reads.
- `web/`: the browser pages the gateway serves, built by Vite.

## Rules

- `builtinPipelineSpecifications` in `src/task/pipeline_registry.ts` is the one place declaring a pipeline identifier and its stage names, each following [`docs/naming_scheme.md`](../../docs/naming_scheme.md), to which a new pipeline is added too.
- Message shapes belong in `@webai/protocol` and are never restated here.
- `src/` is the Node.js server and `web/` is browser code: server code must not import from `web/`, and page code must not import from `src/`.
- A new browser page is registered in three places together — its own directory under `web/`, `rollupOptions.input` in [`vite.config.ts`](vite.config.ts), and the `pageRoutes` table in `src/connection/http_routes.ts`.
- A value baked into a page by the `define` option belongs in [`vite.config.ts`](vite.config.ts) and is declared in `web/_shared/global.d.ts`.
- Every new option or environment variable is added to `src/libs/gateway_settings.ts` and documented in [`docs/environment_variables.md`](../../docs/environment_variables.md).
- The account file, the ledger file, the state file and the message logs are runtime state, not source: each location is a setting, and all four default to `~/.webai-at-home/gateway/`.

## Background

- The home directory default comes from [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171): a program run through `npx` has no folder of its own to write into.
- The development server must name [`vite.config.ts`](vite.config.ts) explicitly, because Vite otherwise looks inside `web` and a page reads the production value of anything set by the `define` option.
