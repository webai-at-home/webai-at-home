# Directory Context: `/packages/worker_webpage/web/src/connection`

## Purpose

Reads this browser page's settings, connects to the central gateway over a WebSocket, opens a lost connection again, advertises which stages this browser offers, keeps a stage assignment alive, holds this browser's account, and reports diagnostics back.

## Key Exports & Entry Points

- `gateway_config.ts`: `GatewayConfig`, where this browser page reaches the central gateway, and with what token — read from query parameters.
- `gateway_link.ts`: `GatewayLink`, which sends one message to the central gateway and records that it was sent.
- `gateway_reconnection.ts`: `GatewayReconnection`, which waits, counts down, and opens the connection again.
- `worker_stage_offer.ts`: `WorkerStageOffer`, which decides which stages this browser offers the central gateway.
- `lease_heartbeat.ts`: `LeaseHeartbeat`, which tells the gateway this browser is still working on its assignment.
- `worker_account.ts` and `account_key_store.ts`: this browser's account, what it earns, and the key pair it cannot read out.
- `diagnostics_reporter.ts`: `DiagnosticsReporter`, which batches this browser's message log and posts it to the gateway.
- `gateway_departure.ts`: `GatewayDeparture`, which tells the central gateway this browser page is going away.

## Rules

- Every setting comes from a query parameter on the page address — `gatewayUrl`, `authToken`, `workerName`, and repeated `enabledStages` — never from an environment variable.
- Whether a closed connection is opened again is decided from `main.ts`'s `isAutomaticReconnectionAllowed`, never from the WebSocket close code, which says nothing about whether coming back is wanted.
- `account_key_store.ts` never exposes the private key it stores; only a signature made with it ever leaves this folder.
- `WorkerStageOffer` reads the stage list from `../stages/stage_catalog.ts`, never a list kept separately here.
- `GatewayDeparture` sends its departure with `navigator.sendBeacon` and the plain-text content type `@webai/protocol` states, never with `fetch`, because only a beacon is delivered once the page is gone.

## Background

- The reconnection rule comes from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158); the account key pair guarantees were proven in [`packages/_account_key_experiments`](../../../../_account_key_experiments/).
- The departure rule comes from [issue #176](https://github.com/webai-at-home/webai-at-home/issues/176), where a beacon sent from `pagehide` was measured arriving in every case a WebSocket close frame did not.
