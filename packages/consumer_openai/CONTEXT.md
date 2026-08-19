# Directory Context: `/packages/consumer_openai`

## Purpose

An OpenAI-compatible server in front of the `webai-at-home` cluster. It accepts a chat completion request or a Responses request, turns it into one cluster task, submits that task to the central gateway as a consumer, and answers with the generated text, streamed or whole.

## Key Exports & Entry Points

- `src/cli.ts`: the `consumer_openai` command line program, one subcommand, `server`.
- `src/http/`: the routes `/v1/models`, `/v1/chat/completions`, and `/v1/responses`, and the request and answer log.
- `src/api/`: the request and answer shapes of both interfaces, the errors, which task type each model name maps to, and the building of the history, the prompt, the finish reason, and the generation settings.
- `src/libs/`: `cluster_task_runner.ts`, on top of `ConsumerClient` from `@webai/consumer-cli`, and `server_settings.ts`, holding every option and variable.
- The examples and the latency benchmark live in [`packages/_openai_api_tool_TOREMOVE`](../_openai_api_tool_TOREMOVE/), not here.

## Rules

- This package is a consumer in the same sense as `@webai/consumer-cli`, and reuses its `ConsumerClient` rather than speaking the gateway protocol itself.
- One deployment is one account: the account charged is the server's own, because no OpenAI-compatible request carries an account identifier. Do not run it in a publicly reachable container.
- The model names answered with are task type names from [`docs/naming_scheme.md`](../../docs/naming_scheme.md), in `src/api/model_catalog.ts`.
- Every new option or environment variable is added to `src/libs/server_settings.ts` and named in [`docs/environment_variables.md`](../../docs/environment_variables.md).
- A value the OpenAI Chat Completions interface has no field for travels in an `X-Webai-*` response header, or not at all — never as an added member of a response body.
- `usage` is present only when the worker reported both token counts, and is never estimated. A streamed chat completion carries it in an extra final chunk, sent only when asked with `stream_options: { include_usage: true }`.
- `finish_reason` comes from the worker's `stopReason`, and a reason with no OpenAI value is refused rather than invented.
- A generation control the chosen model cannot honour is refused with HTTP 400, never dropped. Which task type honours which is `GenerationControlSupport` in `@webai/protocol`, not restated here.
- The `tests/real_*.test.ts` files drive real browser tabs with Puppeteer, one at a time, never as part of `npm test`.

## Background

- Leaving this server out of the Docker image comes from [issue #139](https://github.com/webai-at-home/webai-at-home/issues/139); the header and `usage` rules from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150); the generation controls from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151). `/v1/responses` is in [`src/http/CONTEXT.md`](src/http/CONTEXT.md).
