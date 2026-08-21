# Directory Context: `/packages/worker_openai/src/libs`

## Purpose

This worker's connection to the central gateway, and the calls to the local OpenAI-compatible server that runs a model.

## Key Exports & Entry Points

- `gateway_worker_client.ts`: `GatewayWorkerClient`, this worker's connection to the central gateway.
- `gateway_connection_supervisor.ts`: `GatewayConnectionSupervisor`, which opens a connection again after each one that closes.
- `worker_stage_offer.ts`: `WorkerStageOffer`, which decides which stages this worker offers the central gateway.
- `lease_heartbeat.ts`: `LeaseHeartbeat`, which tells the gateway this worker is still working on its assignment.
- `openai_api_client.ts`: `OpenaiApiClient`, which talks to one local server that speaks the OpenAI-compatible API.
- `../stages/`: one stage helper per stage this worker can run — see its own CONTEXT.md.

## Rules

- `GatewayWorkerClient` speaks the protocol over exactly one connection, and every field it resets when a connection closes depends on that. Anything that outlives one connection belongs in `GatewayConnectionSupervisor`, which builds a new socket and a new client per attempt rather than reusing either.
- `OpenaiApiClient` carries a generation control into the request body under its OpenAI name, and leaves a control the consumer did not ask for out of the body entirely rather than sending `null`.
- `OpenaiApiClient` sends both shapes a consumer may ask an answer to be in as a `json_schema`, the one spelling LM Studio and Ollama both accept, and sends no `strict` beside the schema.
- `OpenaiApiClient` carries the tools a history declared into the request body, and mints the tool call identifier the local server requires and the protocol does not carry, because a declaration this worker drops is a declaration the model never reads.
- `OpenaiApiClient` fails the stream when the local server writes a failure into one it already answered successfully, since no status check catches it.
- Message shapes come from `@webai/protocol` and are never restated here.
- Nothing here names a stage helper: which stages this worker can run is asked of `StageCatalog` in `../stages/`, and always by the computation a stage names rather than by the stage name itself, so a pipeline the gateway loaded after this worker was built can offer new stage names that reuse computations already shipped here.

## Background

- The connection lifetime rule comes from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158). The rest were proven live against a real local server first: generation controls in [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), tools and the minted identifier in [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190), response format in [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221), failure inside a successful stream in [issue #215](https://github.com/webai-at-home/webai-at-home/issues/215).
