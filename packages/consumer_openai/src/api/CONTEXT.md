# Directory Context: `/packages/consumer_openai/src/api`

## Purpose

The shapes of the two OpenAI interfaces this server serves, Chat Completions and Responses: request and response bodies, errors, which model name maps to which task type, and the translation into a task.

## Key Exports & Entry Points

- `openai_types.ts`: the Chat Completions request and response bodies.
- `responses_types.ts`, `responses_translator.ts`: the Responses shapes, and carrying such a request onto what this folder already has.
- `openai_error.ts`: `OpenaiError`, a failure, with the HTTP status and the response body it is answered with.
- `model_catalog.ts`: `ModelCatalog`, the models this server offers and the task type behind each. Which of them the cluster can run now is `../libs/model_availability.ts`'s question.
- `history_builder.ts`, `prompt_flattener.ts`: a request's messages become the history a task carries, or its one piece of text.
- `generation_settings_builder.ts`: a request's controls become task generation settings.
- `finish_reason_translator.ts`: a worker's own stop reason as an OpenAI value.
- `tool_translator.ts`: tools between the OpenAI spelling and this project's own.
- `response_format_reader.ts`: reads `response_format`, and refuses what cannot be produced.

## Rules

- This folder imports from no other folder of this package: it is the translation layer `../http/` and `../libs/` sit on top of, never the other way.
- The model names in `model_catalog.ts` are task type names from [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md).
- `finish_reason_translator.ts` refuses `interrupted`, which has no OpenAI value, rather than inventing one, and answers `stop_sequence` as `stop`, never `length`: an answer ending on a stop sequence the consumer asked for is finished ([#150](https://github.com/webai-at-home/webai-at-home/issues/150)).
- `generation_settings_builder.ts` never drops a generation control it cannot honour; refusing it is `../http/openai_routes.ts`'s job ([#151](https://github.com/webai-at-home/webai-at-home/issues/151)).
- `responses_translator.ts` joins `instructions` and every system message into one, because the chat template of `llm_qwen3_5_0_8b_full` refuses a second, and leaves out an item kind this cluster does not carry rather than refusing the request.
- `response_format_reader.ts` reads `@webai/protocol`'s `StructuredOutputSupport` rather than a list of its own, so a task type gains a shape there and nothing here changes ([#191](https://github.com/webai-at-home/webai-at-home/issues/191)). Two things it refuses on rules of its own, no table saying either: a shape beside declared tools, and a schema carrying a keyword `JsonSchemaCompiler` cannot enforce ([#219](https://github.com/webai-at-home/webai-at-home/issues/219)).

## Background

- The Responses shapes come from [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214); carrying two system messages was found live to fail the whole request.
