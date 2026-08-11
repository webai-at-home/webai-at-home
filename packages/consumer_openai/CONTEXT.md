# Directory Context: `/packages/consumer_openai`

## Purpose

An OpenAI-compatible server in front of the `webai-at-home` cluster. It accepts a chat completion request in the shape the OpenAI completion interface uses, turns it into one cluster task, submits that task to the central gateway as a consumer, and answers with the generated text, streamed or whole. A program that already talks to OpenAI can use the cluster by changing its base address only.

## Key Exports & Entry Points

- `src/cli.ts`: the `consumer_openai` command line program, with one subcommand, `server`, implemented in `src/commands/server_command.ts`.
- `src/http/openai_routes.ts`: the HTTP routes, `/v1/models` and `/v1/chat/completions`. `src/http/curl_style_transaction_logger.ts` records each request and answer.
- `src/api/`: `openai_types.ts`, `openai_error.ts`, `model_catalog.ts` (which task type each model name maps to), `history_builder.ts`, `prompt_flattener.ts`, `finish_reason_translator.ts`, and `generation_settings_builder.ts`.
- `src/libs/cluster_task_runner.ts`: submits the task and follows it, on top of `ConsumerClient` from `@webai/consumer-cli`.
- `src/libs/server_settings.ts`: every command line option and environment variable this server reads.
- The runnable examples, the sweep across every model, and the latency benchmark live in [`packages/openai_api_tool`](../openai_api_tool/), not here.

## Local Rules & Boundaries

- This package is a consumer of the cluster in the same sense as `@webai/consumer-cli`, and it reuses that package's `ConsumerClient` rather than speaking the gateway protocol itself.
- One deployment of this server is one account: the account charged is the server's own, read from `default.account_key.json` in its `--config_dir`, because nothing in an OpenAI-compatible HTTP request carries an account identifier. Do not run it in a publicly reachable container.
- The model names this server answers with are task type names from [`docs/naming_scheme.md`](../../docs/naming_scheme.md), declared in `src/api/model_catalog.ts`.
- `tests/index.test.ts` runs without a cluster. The `tests/real_*.test.ts` files drive real browser tabs with Puppeteer and are run one at a time with the matching `test:real:<task type>` script, never as part of `npm test`.
- Every new command line option or environment variable is added to `src/libs/server_settings.ts` and documented in [`docs/environment_variables.md`](../../docs/environment_variables.md).
- A value the OpenAI Chat Completions interface has no field for travels in an `X-Webai-*` response header, or not at all — never as an added member of a response body. `X-Webai-Generation-Time-Ms` carries the whole-answer response's total generation time; `X-Webai-Time-To-First-Piece-Ms` carries the streamed response's time to its first piece, the one generation-time fact known before that response's headers must be sent. See [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- `usage` is present on the chat completion response only when the worker that produced the answer reported both `promptTokenCount` and `completionTokenCount` on `LlmStagePayload`, read through `ClusterTaskRunner.run`'s `TaskAnswer`. It is never estimated, and never set to `0` for a count nobody reported. `finish_reason` is translated from the worker's own `stopReason` by `src/api/finish_reason_translator.ts`, which refuses to answer a reason with no OpenAI value — `interrupted` — rather than inventing one. See milestone 2 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- A streamed answer carries `usage` in an extra final chunk, sent only when the request asks for it with `stream_options: { include_usage: true }`, exactly as the OpenAI Chat Completions interface defines it: every chunk before it carries `usage: null` and one choice, the final chunk carries no choices and a `usage` object, and it is sent after the `finish_reason` chunk and before `data: [DONE]`. A caller that disconnects mid-answer is told nothing, because the connection it would have been told on is the one it closed; the cluster still learns the task was cancelled, but a cancelled answer reports no usage to anybody. See milestone 4 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- The five generation controls of a request — `temperature`, `top_p`, `max_completion_tokens` and its older spelling `max_tokens`, `stop`, and `seed` — are read by `src/api/generation_settings_builder.ts` and carried to the cluster untranslated. A control the chosen model cannot honour is refused with HTTP 400 and the code `unhonourable_generation_control`, never dropped, unless the asked-for value is this interface's own default (`temperature: 1`, `top_p: 1`, an empty `stop`, or `null`), which is never refused. Which task type honours which control is `GenerationControlSupport` in `@webai/protocol` — do not restate that table here. See milestone 4 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
