# `@webai/worker-openai`

A native worker that runs a model by forwarding its assigned stage to a locally running server
that speaks the OpenAI-compatible Chat Completions API, such as [LM Studio](https://lmstudio.ai).
Unlike `@webai/worker-webpage`, this worker is a Node.js
command line process rather than a browser tab: it never downloads or runs a model itself, and
instead reaches whichever local server, and whichever model that server already has loaded, the
person running it has chosen. See
[issue #100](https://github.com/webai-at-home/webai-at-home/issues/100) and its implementation
plan in [issue #103](https://github.com/webai-at-home/webai-at-home/issues/103).

## Running it

There is one ready-made script per model, each passing the base URL LM Studio uses, the name LM
Studio gives that model, and the one stage that model answers, so nothing else has to be given on
the command line.

Start LM Studio's local server from the LM Studio application or with `lms server start`, then
start the worker:

```sh
npm run sample:lmstudio:llama-3.2-1b-instruct --workspace @webai/worker-openai
```

```sh
npm run sample:lmstudio:qwen_qwen3.5-0.8b --workspace @webai/worker-openai
```

To point the worker somewhere else, use `npm run dev` and give the options yourself:

```sh
npm run dev --workspace @webai/worker-openai -- --openai-model llama-3.2-1b-instruct --stage-names stage_llm_llama3_2_1b_full
```

Or, against a built package:

```sh
npm run build --workspace @webai/worker-openai
npm run start --workspace @webai/worker-openai
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `-u, --gateway-url <url>` | `wss://webai-gateway.dash-menu.com/` | The central gateway's WebSocket URL. Falls back to the `GATEWAY_WS_URL` environment variable. |
| `-a, --auth-token <token>` | `development-token` | The bearer token the gateway requires. Falls back to the `GATEWAY_AUTH_TOKEN` environment variable. |
| `-n, --worker_name <name>` | `openai-worker` | The worker name shown in the gateway's device list. |
| `-b, --openai-base-url <url>` | `http://localhost:1234/v1` | The base URL of the local server's OpenAI-compatible API. That default is LM Studio's own address, so a worker on a machine already running LM Studio needs no `--openai-base-url` at all. Falls back to the `OPENAI_BASE_URL` environment variable. |
| `-k, --openai-api-key <key>` | none, so no `Authorization` header is sent at all | The bearer token to present to the local server's OpenAI-compatible API. A local server such as LM Studio requires none; a hosted server behind `--openai-base-url` does. Falls back to the `OPENAI_API_KEY` environment variable. |
| `-m, --openai-model <model>` | none, required | The model the local server is asked for, exactly as that server names it. Two servers name the same model differently, so this has to change with the base URL, and this worker refuses to start without it rather than guess. |
| `-s, --stage-names <name...>` | none, required | The stages this worker offers to run, such as `stage_llm_llama3_2_1b_full`. The model named by `--openai-model` is what answers every one of them, which is why this has to be given rather than defaulting to every stage this worker can run: one worker process reaches one local server for one model, and a stage named after a different model would be answered by that model all the same. |
| `-c, --config_dir <path>` | `~/.webai-at-home/worker_openai_config` | The directory holding this worker's own account key pair, as `default.account_key.json`, so the stages it completes earn credits for that account. A directory with no key pair in it means no account, and the stages it completes earn credits for nobody. See [`docs/accounting_system.md`](../../docs/accounting_system.md). |
| `--no-automatic-reconnection` | off, so this worker does connect again | Stop as soon as the connection to the central gateway closes, instead of opening a connection again after a wait. See [Connecting again after the connection is lost](#connecting-again-after-the-connection-is-lost). |

`-m, --openai-model` is required and is deliberately not read from the local server, even though `GET /v1/models` exists on every OpenAI-compatible API. Measured against a real LM Studio for [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171), that endpoint lists every downloaded model rather than the loaded one — twelve of them on the machine it was measured on, one a text embedding model that cannot serve a chat completion at all — and its entries carry only `id`, `object` and `owned_by`, so nothing in the response says which model is loaded. Zero were loaded when it returned those twelve. LM Studio loads a named model just in time instead: a chat completion naming a model that was not loaded answered in 2.7 seconds. Naming the model is therefore the whole mechanism, and there is nothing to discover.

`GATEWAY_WS_URL` and `GATEWAY_AUTH_TOKEN` are the same two names `packages/docker_server` uses for the same two settings, so one pair of exported variables points every program on this machine at the same gateway. See [`docs/environment_variables.md`](../../docs/environment_variables.md) for every variable this project reads and which programs read none.

## Connecting again after the connection is lost

A connection that closes without this worker asking for it — the gateway was deployed again, its container restarted, the network was interrupted — is opened again on its own. This worker waits one second before the first attempt, and longer after each attempt that finds no gateway: two seconds, four, eight, and so on up to one minute, plus a random extra of up to 30 per cent so that every worker that was connected to the same gateway does not come back at the same instant. There is no limit on the number of attempts, and the process keeps running throughout, printing each wait before it makes the next attempt:

```text
2026-08-09T09:51:58.005Z disconnected
2026-08-09T09:51:58.006Z Opening a connection to the central gateway again in 1 second(s), attempt 1
2026-08-09T09:51:59.042Z failure: The connection to the central gateway failed
2026-08-09T09:51:59.042Z Opening a connection to the central gateway again in 2 second(s), attempt 2
```

Ctrl-C is the way out. `--no-automatic-reconnection` asks for the earlier behaviour, where the first connection to close ended the program; anything that drives this worker from a script and depends on it exiting should pass it.

The wait itself comes from `ReconnectBackoff` in [`@webai/protocol`](../protocol/README.md), shared with [`@webai/worker-webpage`](../worker_webpage/README.md) and [`@webai/consumer-openai`](../consumer_openai/README.md), so all three lean on one gateway in the same way. See [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).

## How an answer is generated

The worker asks the local server for a streaming chat completion and reads the pieces of the
answer as they arrive. What one stage run does with those pieces follows the `isStreaming`
generation setting the consumer submitted, exactly as the browser-based full-model tasks behave:

- A task that asked for nothing has one run read every piece and return the whole answer, so it
  finishes in a single stage run.
- A task that asked for its answer in pieces has one run read one piece and return it, leaving
  the request to the local server open for the run that follows, plus one final run that finds
  generation finished and returns the whole answer.

## What this worker checks before it registers

Before it advertises the stages `--stage-names` asked for, this worker asks the configured base URL
for `GET /v1/models` and checks that the model named by `--openai-model` is in the answer. A worker
whose local server cannot be reached, or does not currently hold that model, registers with no stage
at all rather than accepting work it would fail, and says why in its own output.

This worker carries one stage helper per stage it can run, in `src/stages/`:

- `stage_llm_gemma_4_e2b_full`
- `stage_llm_llama3_2_1b_full`
- `stage_llm_qwen3_5_0_8b_full`

All three are stages `@webai/worker-webpage`'s browser tab also offers, by downloading and running the
model itself (see [`packages/worker_webpage/README.md`](../worker_webpage/README.md)). Either worker
type can fulfil any of these stages: this worker forwards the prompt to a local server that already holds
the model, and does not download anything itself. The gateway assigns the stage to whichever kind of
worker offers it, and does not know which one a given assignment reaches.

## What a model behind LM Studio can do on its own

What this worker offers to the cluster was decided from a measurement of what a model served by LM Studio can do on its own, rather than from a guess. Two programs, `examples/lmstudio_direct_history.ts` and `examples/lmstudio_direct_tools.ts`, talked to LM Studio directly through the OpenAI SDK — not through the gateway and not through this worker — and reported the model's own behaviour and nothing else. See [issue #119](https://github.com/webai-at-home/webai-at-home/issues/119). Both programs have since been removed; the two-turn history check they ran is the `history` subcommand of [`@webai/openai-api-tool`](../openai_api_tool_TOREMOVE/README.md), which measures any server speaking the OpenAI-compatible API, LM Studio among them:

```sh
npm run history:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```

The tool round trip check has no equivalent there: no subcommand of `@webai/openai-api-tool` declares a tool, reads a tool call back, or writes a `role: "tool"` message. Nothing in this project calls a tool today.

### Results so far

Measured on 4 August 2026, against LM Studio's server on `http://localhost:1234/v1` (`lms` command line at commit `71bd99c`) through the `openai` SDK version 4.104.0.

| Model | Multi-turn history | Generates a tool call | Accepts a tool result in the history | Answers from the tool result |
| --- | --- | --- | --- | --- |
| `llama-3.2-3b-instruct` | yes | no | yes | yes |
| `qwen3.5-2b-mlx` | yes | yes | yes | yes |

`qwen3.5-2b-mlx` is the 8-bit MLX build of Qwen3.5 2B from [lmstudio-community/Qwen3.5-2B-MLX-8bit](https://huggingface.co/lmstudio-community/Qwen3.5-2B-MLX-8bit), 2.69 GB on disk. LM Studio reports its kind as `vlm` rather than `llm`, because it can also be given images, and it answers a text-only chat request the same way a model of kind `llm` does.

What that means for this worker:

- Both models carry a history across turns, which is what the `stage_llm_llama3_2_1b_full` stage this worker already offers needs. Each recalled both facts from the first turn word for word.
- The Llama 3.2 3B model does not generate tool calls. It answered the question in words, explaining that it has no weather tool, and it wrote a made-up temperature of its own instead. Sending `tool_choice: "required"` did not change that: LM Studio still returned an empty `tool_calls` list. The working hypothesis in issue #119 is therefore confirmed for this model.
- The Qwen3.5 2B model does generate tool calls. It answered with `get_current_weather({"city":"Paris"})` on the first turn, which is the whole first step passed, and it is the smaller of the two models on parameter count.
- Both models read a tool result back out of the history. Given a tool call and a tool result, LM Studio accepted the history, and each model answered with the temperature the tool result carried rather than with one of its own. So a caller that decides by itself which tool to run can use either model to turn the result into an answer, while a caller that wants the model to choose the tool needs Qwen3.5 2B and not Llama 3.2 3B.
