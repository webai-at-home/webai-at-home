# Directory Context: `/packages/worker_webpage`

## Purpose

The browser page a volunteer opens to contribute computing time. It connects to the central gateway over a WebSocket, advertises which stages it can run, accepts a stage assignment, runs the model work in the browser tab, and sends the result back.

## Key Exports & Entry Points

- `web/index.html` and `web/src/main.ts`: the page itself. Command to run this folder: `npm run dev --workspace @webai/worker-webpage`, on port `8789`.
- `web/src/connection/`: the connection to the gateway, reconnection, the stage offer, the lease heartbeat, the account key pair, and diagnostics reporting.
- `web/src/stages/`: one `stage_helper_<stage name>.ts` file per stage this page can run.
- `web/src/page/`: the markup, the event log, the theme toggle, the about panel, the quiet keepalive tone, and the screen wake lock.

## Rules

- This is a browser page, not a server. It cannot run inside the Docker container as a worker; the container only serves the built files.
- Every setting comes from a query parameter on the page address — `gatewayUrl`, `authToken`, `workerName`, and repeated `enabledStages` — never from an environment variable.
- Adding a stage means adding one `web/src/stages/stage_helper_<stage name>.ts` file named after the stage name in [`docs/naming_scheme.md`](../../docs/naming_scheme.md), registered where the other stage helpers are registered.
- Message shapes come from `@webai/protocol` and are never restated here.
- Whether a closed connection is opened again is decided from `main.ts`'s `isAutomaticReconnectionAllowed`, never from the WebSocket close code, which says nothing about whether coming back is wanted.
- A close the page itself asks for, because trying again would find exactly the same thing, sets that field to `false` before closing.
- A stage reports only the token counts and stop reason its own engine really gives, never a guessed or zero count.
- `WorkerStageOffer.offeredStages` keeps each whole-model stage's names in its own list, so `WorkerPage.prepareOfferedStages` checks the readiness of, and downloads, only the model a tab actually offers.
- The end-to-end tests driving this page live in [`packages/consumer_openai/tests`](../consumer_openai/tests); here `npm test` type checks `web/src` and `tests` before running this package's own unit tests.

## Background

- The reconnection rule comes from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158), and what each engine can report from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
