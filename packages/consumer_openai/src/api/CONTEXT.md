# Directory Context: `/packages/consumer_openai/src/api`

## Purpose

Everything specific to the shape of the OpenAI Chat Completions interface: the request and response bodies, the errors, which model name maps to which cluster task type, and the translation between a request and the cluster task it becomes.

## Key Exports & Entry Points

- `openai_types.ts`: the request bodies this server accepts and the response bodies it returns.
- `openai_error.ts`: `OpenaiError`, a failure, with the HTTP status and the response body it is answered with.
- `model_catalog.ts`: `ModelCatalog`, the models this server offers, and the cluster task type behind each one. Which of them the cluster can currently run is `../libs/model_availability.ts`'s question, not this folder's.
- `history_builder.ts` and `prompt_flattener.ts`: turning a request's messages into the history a task carries, or into the single piece of text a task carries.
- `generation_settings_builder.ts`: turning a chat completion request's controls into task generation settings.
- `finish_reason_translator.ts`: turning a worker's own stop reason into an OpenAI value.
- `tool_translator.ts`: carrying tools between the OpenAI spelling and this project's own.

## Rules

- This folder imports from no other folder of this package: it is the translation layer `../http/` and `../libs/` both sit on top of, never the other way.
- The model names in `model_catalog.ts` are task type names from [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md).
- `finish_reason_translator.ts` refuses to answer a reason with no OpenAI value — `interrupted` — rather than inventing one, and answers `stop_sequence` as `stop`, never as `length`, because an answer that ended on a stop sequence the consumer asked for is a finished answer.
- `generation_settings_builder.ts` never drops a generation control it cannot honour; refusing it is `../http/openai_routes.ts`'s job, not this folder's.

## Background

- The finish reason and generation settings rules come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
