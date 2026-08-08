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

There is a ready-made script that passes the base URL and the model name LM Studio uses, so
nothing else has to be given on the command line.

Start LM Studio's local server from the LM Studio application or with `lms server start`, then
start the worker:

```sh
npm run sample:lmstudio --workspace @webai/worker-openai
```

To point the worker somewhere else, use `npm run dev` and give the options yourself:

```sh
npm run dev --workspace @webai/worker-openai -- --base-url http://localhost:1234/v1 --model llama-3.2-3b-instruct
```

Or, against a built package:

```sh
npm run build --workspace @webai/worker-openai
npm run start --workspace @webai/worker-openai
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `-u, --url <url>` | `ws://localhost:8787` | The central gateway's WebSocket URL. Falls back to the `GATEWAY_WS_URL` environment variable. |
| `-a, --auth-token <token>` | `development-token` | The bearer token the gateway requires. Falls back to the `GATEWAY_AUTH_TOKEN` environment variable. |
| `-n, --worker_name <name>` | `openai-worker` | The worker name shown in the gateway's device list. |
| `-b, --base-url <url>` | `http://localhost:1234/v1` | The base URL of the local server's OpenAI-compatible API. That default is LM Studio's; another server listens elsewhere. |
| `-m, --model <model>` | `llama-3.2-3b-instruct` | The model the local server is asked for, exactly as that server names it. Two servers name the same model differently, so this has to change with the base URL. |
| `-s, --stage-names <name...>` | every stage this worker can run | Restrict this worker to particular stages. |
| `-c, --config_dir <path>` | `data/worker_openai_config` | The directory holding this worker's own account key pair, as `default.account_key.json`, relative to this checkout of the repository, so the stages it completes earn credits for that account. A directory with no key pair in it means no account, and the stages it completes earn credits for nobody. See [`docs/accounting_system.md`](../../docs/accounting_system.md). |

`GATEWAY_WS_URL` and `GATEWAY_AUTH_TOKEN` are the same two names `packages/docker_server` uses for the same two settings, so one pair of exported variables points every program on this machine at the same gateway. See [`docs/environment_variables.md`](../../docs/environment_variables.md) for every variable this project reads and which programs read none.

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

Before it advertises `stage_llm_llama3_2_3b_full`, this worker asks the configured base URL for
`GET /v1/models` and checks that the model named by `--model` is in the answer. A worker whose
local server cannot be reached, or does not currently hold that model, registers with no stage
at all rather than accepting work it would fail, and says why in its own output.

## Testing what a model behind LM Studio can do on its own

The two examples in `examples/` measure what a model served by LM Studio can do, so that what this worker offers to the cluster can be decided from a measurement rather than from a guess. They talk to LM Studio directly through the OpenAI SDK: they do not go through the gateway and they do not go through this worker, so what they report is the model's own behaviour and nothing else. See [issue #119](https://github.com/webai-at-home/webai-at-home/issues/119).

Start LM Studio's server, load at least one chat model in the LM Studio application, then run either example:

```sh
npm run lmstudio:server:start --workspace @webai/worker-openai
npm run example:lmstudio_direct_history --workspace @webai/worker-openai
npm run example:lmstudio_direct_tools --workspace @webai/worker-openai
```

- `examples/lmstudio_direct_history.ts` holds a two-turn conversation: the first turn states a name and a favourite programming language, the second turn sends the whole conversation back, including the model's own first answer, and asks the model to repeat both facts.
- `examples/lmstudio_direct_tools.ts` runs a whole tool round trip: the model is asked a question it cannot answer without a declared tool, the tool call and a made-up tool result are added to the conversation, and the conversation is sent back for a final answer. A model that answers in words instead of calling the tool is still put through the two steps that follow, with a tool call the example writes itself, because emitting a tool call and reading one back out of a conversation are two different abilities.

Each example ends with one row per model, so several models can be compared in one run.

### Switching models

Switching models is one option and nothing else. With no `--model` at all, both models this README records results for are run, one after the other, each loaded by LM Studio on demand.

| What to run | What it runs against |
| --- | --- |
| `npm run example:lmstudio_direct_history --workspace @webai/worker-openai` | `llama-3.2-3b-instruct` and `qwen3.5-2b-mlx`, one after the other. |
| `… -- --model qwen3.5-2b-mlx` | That one model and no other. |
| `… -- --model llama-3.2-3b-instruct qwen3.5-2b-mlx` | Those models, one after the other. |
| `… -- --model all` | Every chat model LM Studio has downloaded, each loaded on demand. |
| `… -- --model loaded` | Every chat model LM Studio currently holds in memory. |
| `… -- --base-url http://localhost:1234/v1` | A LM Studio server somewhere other than the default. |

To run either example against Qwen3.5 2B and nothing else:

```sh
npm run example:lmstudio_direct_history --workspace @webai/worker-openai -- --model qwen3.5-2b-mlx
npm run example:lmstudio_direct_tools --workspace @webai/worker-openai -- --model qwen3.5-2b-mlx
```

`LMSTUDIO_MODEL` and `LMSTUDIO_BASE_URL` set the same two things from the environment. Naming a model LM Studio does not have is not refused: LM Studio answers it with whichever model it currently holds in memory, so both examples read back the model identifier LM Studio reported and say in the results row when it is not the model that was asked for.

To add a model to the comparison, download it and run the examples again:

```sh
lms get https://huggingface.co/lmstudio-community/Qwen3.5-2B-MLX-8bit -y
npm run example:lmstudio_direct_tools --workspace @webai/worker-openai -- --model all
```

### Results so far

Measured on 4 August 2026, against LM Studio's server on `http://localhost:1234/v1` (`lms` command line at commit `71bd99c`) through the `openai` SDK version 4.104.0.

| Model | Multi-turn history | Generates a tool call | Accepts a tool result in the conversation | Answers from the tool result |
| --- | --- | --- | --- | --- |
| `llama-3.2-3b-instruct` | yes | no | yes | yes |
| `qwen3.5-2b-mlx` | yes | yes | yes | yes |

`qwen3.5-2b-mlx` is the 8-bit MLX build of Qwen3.5 2B from [lmstudio-community/Qwen3.5-2B-MLX-8bit](https://huggingface.co/lmstudio-community/Qwen3.5-2B-MLX-8bit), 2.69 GB on disk. LM Studio reports its kind as `vlm` rather than `llm`, because it can also be given images, so both kinds count as chat models when the examples work out which models to run.

What that means for this worker:

- Both models carry a conversation across turns, which is what the `stage_llm_llama3_2_3b_full` stage this worker already offers needs. Each recalled both facts from the first turn word for word.
- The Llama 3.2 3B model does not generate tool calls. It answered the question in words, explaining that it has no weather tool, and it wrote a made-up temperature of its own instead. Sending `tool_choice: "required"` did not change that: LM Studio still returned an empty `tool_calls` list. The working hypothesis in issue #119 is therefore confirmed for this model.
- The Qwen3.5 2B model does generate tool calls. It answered with `get_current_weather({"city":"Paris"})` on the first turn, which is the whole first step passed, and it is the smaller of the two models on parameter count.
- Both models read a tool result back out of the conversation. Given a tool call and a tool result, LM Studio accepted the conversation, and each model answered with the temperature the tool result carried rather than with one of its own. So a caller that decides by itself which tool to run can use either model to turn the result into an answer, while a caller that wants the model to choose the tool needs Qwen3.5 2B and not Llama 3.2 3B.
