# Directory Context: `/packages/consumer_openai/src/api`

## Purpose

The shapes of the two OpenAI interfaces this server serves, Chat Completions and Responses, and the translation of such a request into a cluster task.

## Key Exports & Entry Points

- `openai_types.ts`: the Chat Completions request and response bodies.
- `responses_types.ts`, `responses_translator.ts`: the Responses shapes, and the carrying of such a request onto them.
- `openai_error.ts`: `OpenaiError`, a failure, with the HTTP status and the response body it is answered with.
- `model_catalog.ts`: `ModelCatalog`, the models this server offers and the task type behind each one.
- `history_builder.ts`, `prompt_flattener.ts`: a request's messages become the history a task carries, or its single piece of text.
- `generation_settings_builder.ts`: a chat completion request's controls become task generation settings.
- `finish_reason_translator.ts`, `tool_translator.ts`: carrying a worker's own stop reason, and this project's tools, into the OpenAI spelling.
- `response_format_reader.ts`: reads `response_format`, and refuses a shape the chosen task type cannot produce.

## Rules

- This folder imports from no other folder of this package: it is the translation layer `../http/` and `../libs/` sit on top of, never the other way.
- The model names in `model_catalog.ts` are task type names from [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md).
- `finish_reason_translator.ts` refuses `interrupted`, which has no OpenAI value, rather than inventing one, and answers `stop_sequence` as `stop`, never `length`: an answer that ended on a stop sequence the consumer asked for is finished.
- `generation_settings_builder.ts` never drops a generation control it cannot honour; refusing it is `../http/openai_routes.ts`'s job.
- `responses_translator.ts` joins `instructions` and every system message into one leading system message, because the chat template of `llm_qwen3_5_0_8b_full` refuses a second one, and leaves out an item kind this cluster does not carry rather than refusing the request.
- `response_format_reader.ts` reads `@webai/protocol`'s `StructuredOutputSupport` rather than keeping a list of its own, so a task type gains a shape there and nothing here changes. `generation_settings_builder.ts` is handed what it read rather than reading it, so the two support tables stay apart.

## Background

- `response_format_reader.ts` comes from [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191), and carrying what it reads from milestone 2 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221).
- The finish reason and generation settings rules come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
- The Responses shapes come from [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214).
