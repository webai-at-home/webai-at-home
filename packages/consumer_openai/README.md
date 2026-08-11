# `@webai/consumer-openai`

An OpenAI-compatible server in front of the Web AI at Home cluster.

It accepts chat completion requests in the shape the OpenAI completion interface uses, turns each request into one cluster task, submits it to the central gateway as a consumer, and answers with the generated text. A program that already talks to OpenAI can therefore use the cluster by changing one setting, its base address.

It is a consumer of the cluster in exactly the same sense as [`@webai/consumer-cli`](../consumer_cli), and it reuses that package's `ConsumerClient` to speak the consumer side of the gateway protocol. It is the work described by [issue #34](https://github.com/webai-at-home/webai-at-home/issues/34).

## Run

This package's command line program is `consumer_openai`, with one subcommand: `server` starts
the OpenAI-compatible server. Once this package has been built (`npm run build
--workspace @webai/consumer-openai`), the binary is linked into the repository's own
`node_modules/.bin`, so `npx` runs it from anywhere inside the project:

```sh
npx consumer_openai server
```

`@webai/consumer-cli` and `@webai/protocol` are used through their built output, so they have to be built before either subcommand runs:

```sh
npm run build --workspace @webai/protocol && npm run build --workspace @webai/consumer-cli
```

During development, with the central gateway running, `npm run dev` reaches the server without a
build:

```sh
npm run dev --workspace @webai/consumer-openai
```

The server listens on port 8788, and an OpenAI client is pointed at `http://localhost:8788/v1`.

## Command line options

| Option | Default | What it does |
| --- | --- | --- |
| `-p, --port <number>` | `8788` | The port to serve OpenAI-compatible requests on. |
| `-u, --gateway-url <url>` | `ws://localhost:8787` | The WebSocket address of the central gateway. |
| `-t, --auth-token <token>` | `development-token` | The bearer token the central gateway requires. |
| `-k, --api-key <key>` | none | The key a request must present to this server, sent in an `Authorization` header as `Bearer` followed by the key. Omitted means no key is required. |
| `-n, --consumer_name <name>` | `consumer_openai server` | The consumer name this server registers under with the central gateway. |
| `-c, --config_dir <path>` | `data/consumer_openai_config` | The directory holding this server's own account key pair, as `default.account_key.json`, relative to this checkout of the repository, so the stages its tasks run are recorded against that account. One deployment of this server is one account, and it is this server's account rather than the account of whichever program called its OpenAI-compatible endpoint: this server is what the gateway sees. A directory with no key pair in it means no account, and the stages are recorded against the shared development account instead. See [`docs/accounting_system.md`](../../docs/accounting_system.md). |
| `--request-timeout-ms <number>` | `600000` | How long one task may run before it is cancelled and the request is given up on. |
| `--connection-wait-ms <number>` | `5000` | How long a request waits for a registered gateway connection before it is refused. |
| `--max-tasks-in-flight <number>` | `20` | How many cluster tasks to have in flight at once. The gateway's own `--max-tasks-per-principal` defaults to the same number. |

## Endpoints

- `POST /v1/chat/completions` — runs one cluster task and answers with the generated text, either in one piece or as the answer is written.
- `GET /v1/models` — lists the models the cluster offers.
- `GET /health` — reports whether this server holds a registered connection to the central gateway and how many requests are waiting for a task. It answers 200 when the connection is up and 503 when it is not, and it requires no key.

The web server is Express, which is what [issue #70](https://github.com/webai-at-home/webai-at-home/issues/70) asks of every web-serving package in this repository.

## The models it offers

A model identifier is the cluster's task type name without the leading `task_type_`, which is the same spelling the `-t/--task_type` option of `@webai/consumer-cli` accepts. The list comes from `taskTypeNames` in that package, so the models offered here cannot drift away from the task types the cluster runs.

| Model | What runs it | What it needs |
| --- | --- | --- |
| `dev_formula` | The cluster's development formula task: one stage multiplies the number by two, the next adds seven. | One worker browser tab. No model download. Its message must be a number, and its answer is the resulting number written out. |
| `llm_qwen3_0_6b_sharded` | The Qwen3-0.6B model split into three shards, one per worker browser tab. | Worker browser tabs offering all three shard stages, and the shard files generated first. |
| `llm_gemma_nano_chrome_full` | The Gemma Nano language model built into the Chrome browser. | One worker browser tab in a recent Chrome whose own language model is ready. |
| `llm_qwen3_5_0_8b_full` | The complete Qwen3.5-0.8B model, downloaded from Hugging Face and held by one worker browser tab. | One worker browser tab with WebGPU and 16-bit float shader support, and enough free storage for the roughly 600 MB download. |
| `llm_llama3_2_1b_full` | The complete Llama 3.2 1B Instruct model, held either by one worker browser tab that downloads it, or by a server on a native worker's own device that speaks the OpenAI-compatible API, such as LM Studio. | Either one worker browser tab with WebGPU and 16-bit float shader support and enough free storage for the roughly 1050 MB download, or one worker process from `@webai/worker-openai` and a local server that already has the model. |

[`docs/tasks_and_stages.md`](../../docs/tasks_and_stages.md) describes each of these tasks in full, and [`docs/naming_scheme.md`](../../docs/naming_scheme.md) is the authoritative account of how the names are built.

## Try it

The examples that use the official `openai` package on npm against this server live in [`@webai/openai-api-tool`](../openai_api_tool/), in [`packages/openai_api_tool/examples/`](../openai_api_tool/examples), each one runnable on its own. Start with the development formula example, which needs no model download:

```sh
npm run example:chat_completion_dev_formula --workspace @webai/openai-api-tool
```

Each example file says at the top what the cluster has to have running for it to work, and every example reads `WEBAI_OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set. The sweep that sends one prompt to every model in one run, and the one that checks a two-turn history across the models accepting a history, live in the same package as the `completion` and `history` subcommands. The examples remain the ones to read first: each is a short, single-purpose file explaining one model in one mode.

Without the `openai` package, the same two endpoints with `curl`:

```sh
curl http://localhost:8788/v1/models
```

```sh
curl http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"dev_formula","messages":[{"role":"user","content":"5"}]}'
```

## How a history becomes a prompt

A task in this cluster carries one piece of text, so a history of several messages has to become one piece of text before it can be submitted. Two rules do that:

- A request carrying one message sends that message's content unchanged, so the worker browser tab receives exactly what the caller wrote. This is also what makes `dev_formula` usable, because that task type accepts a number and nothing else.
- A request carrying several messages sends them labelled with their roles, one message per line, followed by a final `assistant:` line that invites the answer.

## Asking for the answer as it is written

A request that sets `stream: true` is answered as server-sent events: one chunk per piece of the answer, each on its own `data:` line as a `chat.completion.chunk`, ended by a `data: [DONE]` line. The first chunk states the role and carries no text, and the last chunk that carries a choice carries no text and says the answer stopped (a further, choice-less chunk carrying `usage` follows it when the request asked for one — see below). Joining the pieces gives the same text the request would have been answered with in one piece.

```sh
curl -N http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"llm_gemma_nano_chrome_full","messages":[{"role":"user","content":"What is the capital of France?"}],"stream":true}'
```

Asking for a stream is what makes the cluster send pieces at all. The cluster does not stream internally by default: a task that asked for nothing has its answer produced in as few stage runs as the pipeline can manage, and one that asked for pieces costs a scheduling round for every piece. That is why it is a per-request choice rather than how the cluster always behaves, and it is the work of [issue #77](https://github.com/webai-at-home/webai-at-home/issues/77).

A failure before the first chunk is answered with an HTTP status and an error body, like any other failure. A failure after the first chunk cannot be: the status line has already gone. Such a failure is written into the stream instead, as a `data:` line carrying the same error body, and the stream is then ended.

## `usage` — the token counts and why an answer stopped

Rule 1: `usage` is present on a chat completion response only when the worker that produced the answer reported both its prompt and completion token counts. It is never estimated, and never filled with `0` for a count nobody reported. Which models can report it depends on how much each engine knows about itself:

| Model | Reports `usage` |
| --- | --- |
| `llm_qwen3_5_0_8b_full` | Always — an exact prompt count from the model's own chat template, and an exact completion count counted as it generates. |
| `llm_llama3_2_1b_full` | Always when a worker browser tab runs it — an exact prompt count from the model's own chat template, and an exact completion count counted as it generates — and whenever the local OpenAI-compatible server reports it, which LM Studio does, when a native worker runs it instead. |
| `llm_gemma_nano_chrome_full` | Never — this engine has no prompt/completion token count to report, only a cumulative context-window usage number in its own unit. |
| `dev_formula`, `llm_qwen3_0_6b_sharded` | Never — neither task type carries a language model with token counts to report. |

Rule 2: `finish_reason` is always one of the OpenAI Chat Completions interface's own values (`stop` or `length`, for this cluster). A worker's own reason for stopping that has no OpenAI value — `interrupted`, when a worker gave up partway through — is never translated into one, so it becomes a failure instead: an HTTP error for a whole-answer response, or a `data:` line carrying the error body for a streamed one.

A streamed answer has no response body to put `usage` in, so it is carried on an extra final chunk instead, sent only when the request asks for it with `stream_options: { include_usage: true }` — an existing field of the OpenAI Chat Completions interface. Every chunk before that one carries `usage: null` and one choice; the final chunk carries no choices at all and the `usage` object, and it is sent after the chunk that carried `finish_reason` and before the `data: [DONE]` line:

```sh
curl -N http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"llm_qwen3_5_0_8b_full","messages":[{"role":"user","content":"What is the capital of France?"}],"stream":true,"stream_options":{"include_usage":true}}'
```

A caller that hangs up mid-answer is told nothing, because the connection it would have been told on is the one it closed. The cluster still learns the task was cancelled — that path already works, through this server cancelling the task — but a cancelled answer reports no usage to anybody.

## The generation controls — `temperature`, `top_p`, `max_completion_tokens`, `stop`, and `seed`

These five fields of a request are read and carried to the cluster, for whichever models honour them. `max_completion_tokens` is a budget for the whole answer rather than for one stage run, and its older spelling `max_tokens` is accepted too; a request that sends both means the newer one. `stop` is accepted as either one piece of text or a list of up to four, and is applied where the tokens are produced rather than by this server dropping pieces of the answer as it forwards them, since a stop sequence can straddle two pieces.

No language-model task type honours any of the five generation controls today. `llm_llama3_2_3b_full` was the only one that ever did, proved live against LM Studio 0.4.20 serving `llama-3.2-3b-instruct`, until [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154) retired that task type:

| Model | Honours |
| --- | --- |
| `llm_llama3_2_1b_full`, `llm_qwen3_5_0_8b_full`, `llm_gemma_nano_chrome_full`, `llm_qwen3_0_6b_sharded` | None yet. Some of the four do not sample at all today, so honouring a temperature on one of those means turning sampling on for the first time and changing the answer every existing caller already receives; that is milestone 3 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151). |
| `dev_formula` | None — it answers with one number and generates no text. |

**A control a model cannot honour is refused, not dropped.** Ignoring it would return an answer generated some other way and report nothing, which is a wrong answer with no error. The refusal is an HTTP 400 whose `code` is `unhonourable_generation_control` and whose `param` names the field at fault, and its message lists the controls that model does honour.

A request that asks for this interface's own default is never refused, whatever model it names: `temperature: 1`, `top_p: 1`, an empty `stop` list, and a control sent as `null` all ask for nothing unusual, so a client that always sends `temperature: 1` works against every model as it always did. Since no model honours anything else today, a request naming any other value for any of the five is refused, whatever model it names:

```sh
curl http://localhost:8788/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"llm_llama3_2_1b_full","messages":[{"role":"user","content":"Write one short sentence about a cat."}],"temperature":0,"seed":42,"max_completion_tokens":20,"stop":["\nUser:"]}'
```

## `X-Webai-*` response headers — what has no OpenAI field

Rule 3: a value the OpenAI Chat Completions interface has no field for travels in an `X-Webai-*` response header, or not at all — never as an added member of a response body, since that would risk breaking a client that reads the body strictly. An OpenAI client ignores a header it does not recognise, so these break nothing.

| Header | Sent on | Carries |
| --- | --- | --- |
| `X-Webai-Generation-Time-Ms` | A whole-answer (non-streamed) response | The total time the cluster took to generate the answer. |
| `X-Webai-Time-To-First-Piece-Ms` | The first chunk of a streamed response | The time to the first piece, the only generation-time fact known before a streamed response's headers must be sent. |

## What this server deliberately does not do

This is a first version. It serves the two endpoints above rather than the whole OpenAI completion interface, and the following are left out on purpose rather than by oversight:

- **It ignores every field of a request outside `stream`, `stream_options`, and the five generation controls above.** `n`, `tools`, `logprobs`, `presence_penalty`, `frequency_penalty`, and the rest are accepted in the body and then ignored. A model that honours none of the five generation controls still generates under the worker browser tab's own limits: 160 tokens for the sharded Qwen3-0.6B task, and 400 pieces of an answer for the Chrome built-in task.
- **It refuses a message whose content is a list of parts**, which is what a request carrying an image or audio sends, rather than joining the parts together. It also refuses the `tool` role, because it ignores the tool settings of a request and so could not continue a history containing the answer of a tool.
- **It keeps no history state.** One request is one cluster task, and the whole history is sent with every request.

## How failures are answered

Every failure is answered with the OpenAI error shape, `{ "error": { "message", "type", "param", "code" } }`, so the official `openai` package raises the error it would raise against OpenAI itself.

| What happened | Status | `code` |
| --- | --- | --- |
| The body is not valid JSON, a field is missing, or a message's content is not a single piece of text | 400 | none |
| The chosen model cannot take the text of the request, such as text that is not a number for `dev_formula` | 400 | none |
| The request asks for a generation control the chosen model cannot honour, at a value other than this interface's own default | 400 | `unhonourable_generation_control` |
| A key is required and the request did not present it | 401 | `invalid_api_key` |
| The request names a model this server does not offer | 404 | `model_not_found` |
| This server already has as many tasks in flight as it holds at once | 429 | `too_many_tasks_in_flight` |
| The central gateway refused the submission because this server has reached its own task limit | 429 | `gateway_rate_limited` |
| The cluster ran the task and the task failed | 502 | `task_failed` |
| The task completed but its result carried no text | 502 | `answer_unreadable` |
| No volunteer browser offered the work before the gateway's submission deadline | 503 | `no_volunteer_available` |
| This server is not connected to the central gateway, or the connection was lost while the request was waiting | 503 | `gateway_unavailable` |
| The task did not finish within `--request-timeout-ms`, and was cancelled | 504 | `request_timed_out` |
| This server failed in a way it does not account for | 500 | `internal_error` |

Two of these are worth spelling out:

- A task already under way is **not** picked up again after the gateway connection returns. The gateway gives the new connection a new device identifier, and a task belongs to the device that submitted it, so a request waiting when the connection drops is given up on rather than being left to wait for an answer that can no longer reach it.
- When a caller hangs up, or `--request-timeout-ms` is reached, this server cancels the task, so the cluster stops running stages for an answer nobody will read.

## Auditing HTTP transactions

Every `POST /v1/chat/completions` request is recorded as one `curl -v`-style block of plain text, appended to its own file, `logs/consumer_openai-<run timestamp>.log_http.txt`, one file per run of this server, in the same `logs/` directory as the message log described above but kept apart from it: that file is this server's own wire protocol with the central gateway, and this one is what a caller of this server actually experienced. This is the work described by [issue #75](https://github.com/webai-at-home/webai-at-home/issues/75).

One block is written per transaction, once its response has closed, in the shape `curl -v`, a browser's network inspector, or a reverse proxy's access log already uses: a `>` line per outgoing request field, a `<` line per incoming response field, a blank line between headers and body, and a few plain diagnostic lines naming how the request was authenticated, how it was submitted to the central gateway, how long it took, and how it ended. It reads like this:

```text
==================================================

> POST /v1/chat/completions HTTP/1.1
> host: localhost:8788
> content-type: application/json
> authorization: Bearer sekret
> content-length: 144
>
> {
>   "model": "llm_qwen3_0_6b_sharded",
>   "messages": [
>     {
>       "role": "user",
>       "content": "What is the capital of France?"
>     }
>   ]
> }

< HTTP/1.1 200 OK
< content-type: application/json
<
< {
<   "id": "chatcmpl-e5f944cd-c863-418a-88e6-3b347a33f9ae",
<   "object": "chat.completion",
<   "created": 1785419970,
<   "model": "llm_qwen3_0_6b_sharded",
<   "choices": [
<     {
<       "index": 0,
<       "message": {
<         "role": "assistant",
<         "content": "The capital of France is **Paris**."
<       },
<       "logprobs": null,
<       "finish_reason": "stop"
<     }
<   ]
< }

Transaction: 7893bfe2-e193-4817-91f8-af59c343cdd4
Duration: 1855 ms
Model: llm_qwen3_0_6b_sharded
Auth: ok
Gateway request: bedf801e-5e65-47a7-a31e-4d1424e4a0d4
Gateway task: task-329d8a1b-eb3d-4d87-baf7-29d739ec3aba
Outcome: completed

==================================================
```

`Gateway request` is the same `taskRequestId` a `task.submit` in the message log above carries, and `Gateway task` is the `taskId` a `task.accepted` in that same file assigns, so a transaction here can be followed into the gateway traffic that answered it. `Outcome` is `completed`, `failed`, or `cancelled`; a request whose caller disconnects before an answer arrives, whether by closing the connection or because `--request-timeout-ms` was reached, prints `< (no response: the caller disconnected before one was sent)` and `Outcome: cancelled`, told apart from a request this server actively refused or failed to serve.

**Nothing is redacted.** Every header is written as received, the `Authorization` header included, and both bodies are written as sent. That is the point of this log: a block says what a caller actually asked for and what it actually received, which is what makes it worth keeping for an audit, and what lets a block be read, compared with `diff`, and replayed as the request it describes.

The only thing held back is length: a body longer than 4096 characters is cut short and followed by `Body truncated (N characters omitted of M)`, so one very long prompt or answer cannot make a whole run's log unreadable.

It follows that this file holds the keys presented to this server and every prompt and answer that went through it, in full. **It is as sensitive as the credentials and the histories it records**; `logs/` is ignored by git for that reason, and the file should be treated the same way anywhere it is copied.

A failure while writing to this log, including one while first creating the log directory, is caught and reported to this server's own output, so a caller is always given the answer or failure it was owed even when the log itself cannot be written to.

## Build, type check, and test

```sh
npm run build --workspace @webai/consumer-openai
```

```sh
npm run typecheck --workspace @webai/consumer-openai
```

```sh
npm run test --workspace @webai/consumer-openai
```

The tests cover reading a request, the models on offer, the failure mapping, the whole run of a cluster task against a stand-in connection, and the transaction log described above, in the way [`packages/consumer_cli/tests/index.test.ts`](../consumer_cli/tests/index.test.ts) tests `ConsumerClient`. Most start no server and reach no gateway; a handful send real HTTP requests to the actual Express routes in front of a stand-in gateway connection to check the full request-response flow and what it writes to the transaction log. A live run against the real cluster is still what proves the package works end to end; the examples above are that run.

## The source files

- [`src/cli.ts`](./src/cli.ts) — the `consumer_openai` command line program: dispatches to the `server` subcommand.
- [`src/commands/server_command.ts`](./src/commands/server_command.ts) — the `server` subcommand: builds every part and starts serving.
- [`src/libs/server_settings.ts`](./src/libs/server_settings.ts) — the `server` subcommand's own command line options, read once and typed.
- [`src/http/openai_routes.ts`](./src/http/openai_routes.ts) — the endpoints, including reading and checking a request.
- [`src/libs/cluster_task_runner.ts`](./src/libs/cluster_task_runner.ts) — the one gateway connection, and one promise per submitted task.
- [`src/api/model_catalog.ts`](./src/api/model_catalog.ts) — the models on offer, and the task type behind each one.
- [`src/api/prompt_flattener.ts`](./src/api/prompt_flattener.ts) — turning a history into the single piece of text a task carries.
- [`src/api/generation_settings_builder.ts`](./src/api/generation_settings_builder.ts) — the five generation controls of a request, turned into the settings a task carries, or refused.
- [`src/api/openai_error.ts`](./src/api/openai_error.ts) — every way a request can fail, with its status and its body.
- [`src/api/openai_types.ts`](./src/api/openai_types.ts) — the request bodies accepted and the response bodies returned.
- [`src/http/curl_style_transaction_logger.ts`](./src/http/curl_style_transaction_logger.ts) — records every chat completion request to the transaction log described above.
