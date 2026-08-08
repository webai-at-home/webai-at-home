# `@webai/protocol`

Shared message, task, pipeline, and data definitions for the WebAI distributed
pipeline. Other packages import the public package entry point as
`@webai/protocol`.

## Source layout

`src/index.ts` states what the package offers and holds no definitions of its own.
Every definition lives in the file of its own subject, grouped into one folder per
domain. Code inside this package imports from those files directly rather than
through the entry point.

- `src/task/`
  - `task_types.ts` — `TaskInput`, `GenerationSettings`, `Task`, task state, task
    snapshot, task update, stage assignment, and task events.
  - `pipeline_types.ts` — `StageName`, `PipelineStage`, and `PipelineSpecification`.
  - `task_projection.ts` — builds the task snapshot and the task update from a
    stored task record.
- `src/stage/`
  - `stage_payload_types.ts` — `EncodedTensor`, `LlmStagePayload`, `StagePayload`,
    and their Zod validation.
  - `stage_payload_factory.ts` — builds the value a pipeline stage starts from.
  - `generated_text.ts` — decides how much of an answer may be reported as it is
    written.
- `src/message/`
  - `client_message.ts` — every message a client may send the gateway.
  - `gateway_message.ts` — every message the gateway may send a client, plus the
    protocol error codes.
  - `envelope_types.ts` — the protocol version and the wrapper every frame travels
    in.
  - `envelope.ts` — builds a wrapper for sending, and reads a received one.
  - `message_logger.ts` — appends one JSON line per sent or received message to a
    log file.
  - `diagnostics.ts` — what a worker browser page reports about the messages it saw.
- `src/device_types.ts` — `DeviceRole`, `Device`, and `DeviceActivity`.
- `src/identifier.ts` — the shape every identifier in this protocol shares.
- `src/session_renewal.ts` — decides when a client should authenticate again.

## Public entry points

- `@webai/protocol` — everything listed above, re-exported by `src/index.ts`.
- `@webai/protocol/envelope`
- `@webai/protocol/message_logger`
- `@webai/protocol/task_projection`
- `@webai/protocol/session_renewal`

The current protocol version is `6`, and it is the only version the gateway
accepts. The built-in task types are `task_type_dev_formula`,
`task_type_llm_qwen3_0_6b_sharded`,
`task_type_llm_gemma_nano_chrome_full`,
`task_type_llm_qwen3_5_0_8b_full`, and
`task_type_llm_llama3_2_3b_full`.

## Build

```sh
npm run build --workspace @webai/protocol
```

The compiled JavaScript and type declarations are written to `dist/`.

Run the package checks with:

```sh
npm run typecheck --workspace @webai/protocol
npm run test --workspace @webai/protocol
```
