# Directory Context: `/packages/worker_openai/src/libs`

## Purpose

This worker's connection to the central gateway, keeping that connection open, advertising which stages this worker offers, keeping a stage assignment alive, and the calls to the local OpenAI-compatible server that actually runs a model.

## Key Exports & Entry Points

- `gateway_worker_client.ts`: `GatewayWorkerClient`, holding this worker's connection to the central gateway.
- `gateway_connection_supervisor.ts`: `GatewayConnectionSupervisor`, which keeps this worker connected, opening a connection again after each one that closes.
- `worker_stage_offer.ts`: `WorkerStageOffer`, which decides which stages this worker offers the central gateway.
- `lease_heartbeat.ts`: `LeaseHeartbeat`, which tells the gateway this worker is still working on its assignment.
- `openai_api_client.ts`: `OpenaiApiClient`, which talks to one local server that speaks the OpenAI-compatible API.
- `../stages/`: one stage helper per stage this worker can run — see its own CONTEXT.md.

## Rules

- `GatewayWorkerClient` speaks the protocol over exactly one connection, and every field it resets when a connection closes depends on that. Anything that outlives one connection belongs in `GatewayConnectionSupervisor`, which builds a new socket and a new client per attempt rather than reusing either.
- `OpenaiApiClient` carries a generation control into the request body under its OpenAI name, and leaves a control the consumer did not ask for out of the body entirely rather than sending `null`.
- `OpenaiApiClient` carries the tools a history declared into the request body, and mints the tool call identifier the local server requires and the protocol does not carry, because a declaration this worker drops is a declaration the model never reads.
- Message shapes come from `@webai/protocol` and are never restated here.
- Nothing here names a stage helper: which stages this worker can run is asked of `StageCatalog` in `../stages/`, and always by the computation a stage names rather than by the stage name itself, so a pipeline the gateway loaded after this worker was built can offer new stage names that reuse computations already shipped here.

## Background

- The connection lifetime rule comes from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158); the generation control forwarding was proven live in milestone 0 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151); the tool forwarding, and the minting of the identifier, were proven live in milestone 0 of [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190).
