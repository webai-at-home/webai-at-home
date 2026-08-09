# Directory Context: `/packages/worker_openai`

## Purpose

A worker that runs a model by forwarding its assigned stage to a locally running server that speaks the OpenAI-compatible Chat Completions API, such as LM Studio. Unlike `@webai/worker-webpage`, this worker is a Node.js command line process rather than a browser tab: it never downloads or runs a model itself.

## Key Exports & Entry Points

- `src/cli.ts`: the command line program. `npm run dev --workspace @webai/worker-openai` runs it with `tsx`; `npm run sample:lmstudio --workspace @webai/worker-openai` runs it against LM Studio with the base address and model name already filled in.
- `src/libs/gateway_worker_client.ts`: the WebSocket connection to the central gateway and the worker side of the protocol.
- `src/libs/gateway_connection_supervisor.ts`: keeps this worker connected, opening a connection again after each one that closes.
- `src/libs/openai_api_client.ts`: the calls to the local OpenAI-compatible server.
- `src/libs/worker_stage_offer.ts` and `src/libs/lease_heartbeat.ts`: advertising the stages this worker can run and keeping a stage assignment alive.
- `src/stages/stage_helper_llm_llama3_2_1b_full.ts`: the one stage this worker runs today.

## Local Rules & Boundaries

- Which local server runs the model — LM Studio, or another — is a command line option of this process, never part of a stage or task type name. The stage is named `full` because the model is held complete on one device, following [`docs/naming_scheme.md`](../../docs/naming_scheme.md).
- Adding a stage means adding one `src/stages/stage_helper_<stage name>.ts` file named after the stage.
- Message shapes come from `@webai/protocol`. Do not restate a wire shape here.
- The worker side of the protocol is implemented twice, here and in [`packages/worker_webpage`](../worker_webpage), because one runs in Node.js and the other in a browser tab. Keep the two in step when the protocol changes.
- `GatewayWorkerClient` speaks the protocol over exactly one connection, and every field it resets when a connection closes depends on that. Anything that outlives one connection belongs in `GatewayConnectionSupervisor`, which builds a new socket and a new client per attempt rather than reusing either. See [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).
- `stage_helper_llm_llama3_2_1b_full.ts` reports the exact `promptTokenCount`, `completionTokenCount`, and `stopReason` the local server sends on its Chat Completions stream, read by `openai_api_client.ts`'s `chatCompletionStream` (which asks for them with `stream_options: { include_usage: true }`). A `finish_reason` the local server sends that this stage does not recognise is left untranslated, never guessed at. See milestone 3 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- `openai_api_client.ts`'s `chatCompletionStream` carries the five generation controls of `GenerationSettings` into the request body under their OpenAI names — `temperature`, `top_p`, `max_tokens`, `stop`, and `seed` — and leaves a control the consumer did not ask for out of the body entirely rather than sending it as `null`. Forwarding a control to the local server this way could honour all five, and milestone 0's de-risk gate for [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151) proved that live against LM Studio 0.4.20 serving `llama-3.2-3b-instruct`, back when this worker's one stage was `task_type_llm_llama3_2_3b_full`. That task type is retired; this worker now offers `stage_llm_llama3_2_1b_full`, the same stage `@webai/worker-webpage`'s browser tab offers, and `task_type_llm_llama3_2_1b_full` is registered in `controlsByTaskType` as honouring none of the five, because the task type's contract cannot depend on which of its two possible workers ends up assigned a given task. Nothing in this project honours a generation control today; see [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
