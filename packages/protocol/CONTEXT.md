# Directory Context: `/packages/protocol`

## Purpose

The shared message, task, pipeline, account, and device definitions of `webai-at-home`, with Zod validation. Every shape that crosses a process boundary between the gateway, a consumer, and a worker is defined here once, so the gateway, the consumers, and the workers cannot disagree about it.

## Key Exports & Entry Points

- `src/index.ts`: the public entry point, imported by other packages as `@webai/protocol`. It states what the package offers and holds no definitions of its own. Five further subpaths exist: `@webai/protocol/envelope`, `@webai/protocol/message_logger`, `@webai/protocol/task_projection`, `@webai/protocol/session_renewal`, and `@webai/protocol/reconnect_backoff`.
- `src/task/`: `task_types.ts` (`TaskInput`, `GenerationSettings`, `Task`, task state, task snapshot, task update, stage assignment, task events), `pipeline_types.ts` (`StageName`, `PipelineStage`, `PipelineSpecification`), `task_projection.ts`, `conversation_types.ts`, and `generation_control_support.ts`.
- `src/message/`: `client_message.ts`, `gateway_message.ts`, `envelope.ts`, `envelope_types.ts`, `message_logger.ts`, and `diagnostics.ts`.
- `src/accounting/`: `account_types.ts`, `account_identity.ts`, `account_authentication.ts`, `account_key_file.ts`, `account_identity_file.ts`, and `ledger_types.ts`.
- `src/stage/`: `stage_payload_types.ts`, `stage_payload_factory.ts`, and `generated_text.ts`.
- `src/device_types.ts`, `src/identifier.ts`, `src/random_uuid.ts`, `src/session_renewal.ts`, and `src/reconnect_backoff.ts`.

## Local Rules & Boundaries

- This package depends on no other package of this repository. Every other package depends on it, so a dependency in the other direction would be a cycle.
- Every definition lives in the file of its own subject. Code inside this package imports from that file directly, never through `src/index.ts`.
- A new definition is added to its subject file first, then re-exported from `src/index.ts` under the section separator of its domain.
- Every shape that travels over the wire is a Zod schema, and the TypeScript type is derived from the schema rather than written twice.
- `TaskType` and the stage names it accepts follow [`docs/naming_scheme.md`](../../docs/naming_scheme.md). Adding a task type here means adding its row to that document as well.
- Run `npm run build --workspace @webai/protocol` before any package that imports it; the other packages' `build:dependencies` script does exactly that.
- `LlmStagePayload.promptTokenCount`, `.completionTokenCount`, and `.stopReason` carry token counts and the worker's own word for why generation stopped, on the result that finishes a language-model task. `stopReason` is not an OpenAI value; translating it into one belongs to whichever consumer speaks the OpenAI Chat Completions interface, not to this package. See milestone 2 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- `session_renewal.ts` and `reconnect_backoff.ts` hold the two timing rules every long-lived client shares: when to authenticate again, and how long to wait before opening a connection again. A client that keeps a timing rule of its own instead would let two programs disagree about how hard they lean on one gateway. See [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).
- `GenerationSettings` carries the five generation controls `temperature`, `topP`, `maximumOutputTokenCount`, `stopSequences`, and `randomSeed` beside `isStreaming`, each exactly as the consumer asked for it and never translated for the engine that will run the task. `generation_control_support.ts` is the one place that records which task type honours which control; a consumer reads it before submitting rather than keeping a list of its own. See [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
