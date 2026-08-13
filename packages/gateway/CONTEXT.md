# Directory Context: `/packages/gateway`

## Purpose

The central HTTP and WebSocket gateway of `webai-at-home`. It authenticates and registers consumer and worker connections, holds the queue of tasks, assigns pipeline stages to connected workers, tracks task progress, records the accounting ledger, and relays the signalling messages workers use to reach each other.

## Key Exports & Entry Points

- `src/cli.ts`: the command line program that starts the gateway. `npm run dev --workspace @webai/gateway` runs it with `tsx watch`, and `npm start --workspace @webai/gateway` runs the built `dist/cli.js`.
- `src/connection/`: `connection_hub.ts`, `websocket_router.ts`, `http_routes.ts`, and `websocket_heartbeat.ts` — accepting a connection and routing the messages on it.
- `src/task/`: `task_store.ts`, `task_scheduler.ts`, `pipeline_registry.ts`, `stage_policy_resolver.ts`, `client_message_handler.ts`, and `session_registry.ts` — the queue, the placement of stages, and the built-in pipelines.
- `src/device/`: `device_registry.ts`, `worker_placement.ts`, and `device_announcer.ts` — which workers are connected and what each one can run.
- `src/accounting/`: `account_registry.ts`, `ledger_store.ts`, `accounting_recorder.ts`, `challenge_registry.ts`, and the account and accounting message handlers.
- `src/libs/gateway_settings.ts`: every command line option and environment variable the gateway reads.
- `web/`: the browser pages the gateway serves, built by Vite — `home`, `monitor`, `ledger`, `debug`, and one debug page per task type built from `web/_shared/debug_iframe_worker_frames.ts`.

## Local Rules & Boundaries

- `builtinPipelineSpecifications` in [`src/task/pipeline_registry.ts`](src/task/pipeline_registry.ts) is the one place that declares a pipeline identifier and its stage names. Every name there follows [`docs/naming_scheme.md`](../../docs/naming_scheme.md), and a new pipeline is added to that document at the same time.
- Message shapes belong in `@webai/protocol`. Never restate a wire shape here; import it.
- `src/` is the Node.js server and `web/` is browser code. They have separate TypeScript configurations, and `npm run typecheck` checks both. Server code must not import from `web/`, and page code must not import from `src/`.
- A new browser page under `web/` is three things registered together: its own directory holding `index.html`, `css/main.css`, and `src/<page name>_page.ts`; an entry in `rollupOptions.input` in [`vite.config.ts`](vite.config.ts); and an entry in the `pageRoutes` table in [`src/connection/http_routes.ts`](src/connection/http_routes.ts). Leaving out the second builds no page, and leaving out the third serves no page.
- A value baked into a page by the `define` option belongs in [`vite.config.ts`](vite.config.ts) and is declared in `web/_shared/global.d.ts`. The development server in [`src/cli.ts`](src/cli.ts) has to name that configuration file explicitly, because Vite looks for one in the root directory it is given — `web` — and this package keeps it one level above. Without that, a page reads the value in the production build and fails with a ReferenceError in development.
- Every new command line option or environment variable is added to `src/libs/gateway_settings.ts` and documented in [`docs/environment_variables.md`](../../docs/environment_variables.md).
- The account file, the ledger file, the state file and the message logs are runtime state, not source. Each location is a setting, so the Docker image can put them on the `/data` volume. All four default to `~/.webai-at-home/gateway/`, never to the directory the gateway was started from, for the same reason every other program in this repository keeps its account key pair there: a program run through `npx` has no folder of its own to write into. See [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171).
