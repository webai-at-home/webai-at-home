# `@webai/openai-api-tool`

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside.

It sends chat completion requests to an endpoint, times when the first and the last character of each answer arrived, and reports what answered. It reaches this project's own [`@webai/consumer-openai`](../consumer_openai/) server and any other such server alike — LM Studio among them — which is what makes it the way the Web AI at Home cluster is compared against a model running on one machine.

It holds the two programs that used to live inside `@webai/consumer-openai`, as `examples/chat_completion.ts` and `scripts/benchmark_openai_api.ts`. Both sent a chat completion request and timed it, through two separate transports, so the move gave them one shared implementation and one command line program. It is the work described by [issue #147](https://github.com/webai-at-home/webai-at-home/issues/147).

## Run

`@webai/consumer-cli` and `@webai/protocol` are used through their built output, so they have to be built first:

```sh
npm run build:dependencies --workspace @webai/openai-api-tool
```

The six subcommands are then reachable through `tsx`, with no build of this package needed:

```sh
npx tsx ./src/cli.ts completion --model dev_formula --nostream
```

`src/cli.ts` is executable on its own, with the shebang `#!/usr/bin/env -S npx tsx`:

```sh
././src/cli.ts history --model llm_qwen3_5_0_8b_full
```

Once this package has been built (`npm run build --workspace @webai/openai-api-tool`), the binary is linked into the repository's own `node_modules/.bin`:

```sh
npx openai_api_tool completion --model all
```

## The six subcommands

| Subcommand | What it does |
| --- | --- |
| `completion` | Sends one prompt per model and per mode, and reports which ones answered. Every model has its own default prompt: `5` for `dev_formula`, which accepts only a number, and a plain question for every other model. |
| `history` | Sends a two-turn history, then checks that the second turn's answer recalls both facts the first turn stated. Only `llm_qwen3_5_0_8b_full` and `llm_llama3_2_1b_full` accept a whole history rather than only one prompt, so only those two are swept. |
| `benchmark` | Measures the latency of one endpoint, one model at a time, over repeated requests, and prints a report as text, markdown, or JSON. |
| `usage` | Sends one prompt per model and per mode, the same sweep `completion` runs, and reports each answer's `usage` — whether it was present, and its `prompt_tokens`/`completion_tokens`/`total_tokens` when it was — and its `finish_reason`. The streamed mode asks for its final, choice-less usage chunk with `stream_options: { include_usage: true }`. |

| `generation_controls` | Probes each of `temperature`, `top_p`, `max_completion_tokens`, `stop`, and `seed` against every model, and reports whether that model really honours it — proved by comparing repeated answers, never by the endpoint having accepted the field. |
| `tool_calls` | Probes six separate tool call abilities against every model, and reports which ones the model behind the endpoint really has — proved by counting the tool calls it generated, never by the endpoint having accepted the tool declarations. |

`completion`, `history`, `usage`, and `generation_controls` print one line per swept pair followed by a summary table, and set the process exit code to `1` when any pair failed, so a single command answers whether the cluster still works. `tool_calls` prints the same shape but sets the exit code only when a request failed outright, because a model that does not call tools is the finding it exists to report rather than a fault in the run that measured it.

## Options

Every subcommand accepts these:

| Option | Default | What it does |
| --- | --- | --- |
| `-m, --model <name>` | `all` | One model identifier, a comma-separated list of identifiers, a pattern such as `llm_*`, `all`, or `list` to print the model identifiers and send nothing. |
| `-u, --base_url <url>` | `WEBAI_OPENAI_BASE_URL`, or `http://localhost:8788/v1` | The OpenAI-compatible API to reach, without `/chat/completions`. |
| `-k, --api_key <key>` | `OPENAI_API_KEY`, or `no-key-required` | The bearer token sent to the endpoint. |
| `--timeout_ms <number>` | `600000` | How long one request may take before it is given up on. |
| `-f, --format <format>` | `text` | The output format: `text`, `markdown`, or `json`. |

`completion`, `history`, `usage`, `generation_controls`, and `tool_calls` additionally accept `-s/--streamed` or `--nostream` to restrict the run to one mode; giving neither, or both, sweeps both modes. `completion` and `usage` also accept `-p/--prompt` to send one prompt instead of each model's own default prompt. `generation_controls` accepts `-r/--repeats` (`3`), how many times a probe that compares repeated answers sends its prompt; it sends its own prompts, chosen so the control under test visibly changes the answer, so it has no `-p/--prompt`. `tool_calls` accepts `-r/--repeats` (`3`) as well, how many times a probe that needs a tool call sends its prompt before giving up on getting one; it too sends its own prompts, chosen so that exactly one declared tool answers them.

`benchmark` accepts neither mode flag, because it always asks for the answer in pieces: that is what lets it measure the Time to First Character apart from the Time to Last Character. It adds `-p/--prompt` (`Count up to 30`), `-r/--runs` (`10`), and `-w/--warmup_runs` (`1`).

`-f/--format text`, the default for all five subcommands, is the only format `completion` and `history` stream live: the raw answer is written out piece by piece as it arrives, followed by one analysis line per swept pair, colored green for `ok`, yellow for `skipped`, and red for `failed` (using [`chalk`](https://www.npmjs.com/package/chalk), which turns color off automatically once the output is piped or redirected). `usage` prints its own analysis line live the same way, without streaming the raw answer, since what it reports is the answer's `usage` and `finish_reason` rather than its text. `-f/--format markdown` or `-f/--format json` runs the sweep silently instead, and prints one report — a markdown table, or JSON holding every outcome and the passed/skipped/failed (or reported/skipped/failed, for `usage`) counts — once every pair has finished:

```sh
npx tsx ./src/cli.ts completion --base_url http://localhost:1234/v1 --model qwen3.5-2b-mlx --format markdown
```

`benchmark` always runs silently and prints its own report in the requested format, since it never streams a raw answer to a person.

`history` shows every message of its two-turn history, labeled with its role. In `-f/--format text` each message is printed live as `[user] ...`/`[assistant] ...`; in `-f/--format markdown` a `## Turns` section lists them below the summary table, one subsection per swept model and mode; in `-f/--format json` they appear as the `turns` array on each outcome.

`-m/--model` behaves the same way in all four subcommands: `all` and `list` name the task type names of this project, but a plain name outside that list is passed through to the endpoint unchanged, because `openai_api_tool` is a tool over the OpenAI-compatible chat completion API, not something specific to the Web AI at Home cluster:

```sh
npx tsx ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
```

## What the benchmark measures

Each request measures five figures, all directly observable from the client side without any knowledge of the model or its tokenizer, which keeps them comparable across different providers:

| Metric | Brief |
| --- | --- |
| Time to First Character | Elapsed time from sending the request until the first streamed character arrives. Measures perceived responsiveness. |
| Time to Last Character | Elapsed time from sending the request until the final character arrives. Measures end-to-end request latency. |
| Output Characters per Second | The speed at which the endpoint streams the answer after the first character, computed as `outputCharacters / (the Time to Last Character minus the Time to First Character)`. |
| Input Characters | The number of characters sent in the request prompt. |
| Output Characters | The number of characters generated in the response. |

An endpoint that ignores the streaming request and answers as one JSON object instead is still measurable: the `openai` npm package reads such a body as a stream carrying no pieces at all, so `CompletionSender` follows an empty stream with one whole request, and the first and last character then arrive at the same moment.

The report measures wall-clock latency and response size; it calculates no monetary price, because these OpenAI-compatible endpoints provide no token pricing or usage data. To compare two endpoints, run the subcommand once against each and read the two reports side by side.

Convenience scripts run the benchmark against the endpoints this project measures most often — LM Studio directly, and the `consumer_openai` server backed by the cluster for two of its models. Start LM Studio, the gateway, the `consumer_openai` server, and the worker processes each model needs first:

```sh
npm run benchmark:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```
```sh
npm run benchmark:webai_at_home:llm_llama3_2_1b_full --workspace @webai/openai-api-tool
```
```sh
npm run benchmark:webai_at_home:llm_qwen3_0_6b_sharded --workspace @webai/openai-api-tool
```

Convenience scripts run `history` against the same LM Studio endpoint, and against the cluster's `llm_llama3_2_1b_full` — one of the two models `taskTypeNamesAcceptingHistory` names, so it is the one of the pair `history` can sweep on the cluster:

```sh
npm run history:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```
```sh
npm run history:webai_at_home:llm_llama3_2_1b_full --workspace @webai/openai-api-tool
```

## What `usage` reports

`usage` sweeps every model of `taskTypeNames`, in both modes, the same sweep `completion` runs, but instead of reporting which pair answered, it reports what each answer's `usage` and `finish_reason` actually were. In the nostream mode it reads `usage` straight from the response body; in the streamed mode it sends `stream_options: { include_usage: true }` and reads `usage` off the final, choice-less chunk the endpoint sends after the chunk that carried `finish_reason` and before `data: [DONE]`, described in [`packages/consumer_openai/README.md`](../consumer_openai/README.md#usage--the-token-counts-and-why-an-answer-stopped).

`usage` is present on an answer only when the worker that produced it reported both its prompt and completion token counts — never estimated, and never filled with `0` for a count nobody reported. Which models report it depends on the worker: this project's `llm_qwen3_5_0_8b_full` and `llm_llama3_2_1b_full` do, `llm_gemma_nano_chrome_full` and `dev_formula`/`llm_qwen3_0_6b_sharded` do not. `usage` turns writing that table by hand into one repeatable command:

```sh
npx tsx ./src/cli.ts usage --model all --format markdown
```

Like the benchmark, `usage` calculates no monetary price, because these OpenAI-compatible endpoints provide no token pricing.

Convenience scripts run `usage` against the same LM Studio endpoint, and against the cluster's `llm_qwen3_0_6b_sharded` and `llm_qwen3_5_0_8b_full`:

```sh
npm run usage:lm_studio:qwen_qwen3-0.6b --workspace @webai/openai-api-tool
```
```sh
npm run usage:webai_at_home:llm_qwen3_0_6b_sharded --workspace @webai/openai-api-tool
```
```sh
npm run usage:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```
```sh
npm run usage:webai_at_home:llm_qwen3_5_0_8b_full --workspace @webai/openai-api-tool
```

## What `generation_controls` reports

A generation control that is accepted and quietly ignored looks exactly like a control that works, until the answers are compared. So this subcommand never concludes anything from the endpoint having accepted a field: every probe sends the same prompt more than once and reads whether the answers changed the way that control is supposed to change them. It is the de-risk gate of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), made re-runnable against any endpoint that speaks the OpenAI-compatible API.

| Control | How it is proved |
| --- | --- |
| `temperature` | The same prompt at `0` several times, then at `1.6` several times. Honoured when every answer at `0` is identical and the high-temperature answers are not. Either half alone proves nothing, since a model can be deterministic for reasons that have nothing to do with the temperature it was given. |
| `top_p` | The same prompt at `1.6` with `top_p` narrowed to `0.01`, several times. Honoured when every answer is identical, because narrowing the probability mass to the most likely token is what makes a high temperature stop mattering. |
| `max_completion_tokens` | A long-answer prompt with a budget of 8 tokens, against the same prompt with no budget. Honoured when the endpoint reports `finish_reason: length`. An endpoint that ignores `max_completion_tokens` is then asked again with `max_tokens`, this interface's older spelling of the same control, and the report says which spelling it reads. LM Studio 0.4.20 reads both; an endpoint reading only the older one is reported as honouring the control under that spelling rather than as ignoring it. |
| `stop` | `Count from 1 to 9` with `stop: ["3"]`, against the same prompt without it. Honoured when the answer stops before `3` and the unstopped answer wrote straight past it. The second half is what makes the first mean anything. |
| `seed` | The same prompt at `1.6` with seed `42` twice, then with seed `43`. Honoured when the two runs of `42` agree and `43` does not. |

Each probe reports one of five conclusions: `honoured`, `not_honoured` (accepted and then ignored — the fault this subcommand exists to catch), `refused` (the endpoint answered that this model cannot honour the control, which is a correct answer and not a fault), `inconclusive` (the runs cannot tell the two apart), and `failed` (no answer arrived, so the control was never tested). The process exit code is `1` when any probe was `not_honoured` or `failed`.

Because three of the five probes need a temperature beside the control they are measuring, each control is first asked about on its own, with no other control in the request. Without that, an endpoint refusing more than one control would name whichever it checked first, and every control would be reported as refused for the wrong reason.

`-f/--format markdown` and `-f/--format json` carry every answer each probe produced, so a reader can check a conclusion against the text it was drawn from rather than taking it on trust.

Convenience scripts run it against LM Studio directly and against the cluster, for a model that honours all five and one that honours none:

```sh
npm run generation_controls:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```

```sh
npm run generation_controls:webai_at_home:llm_qwen3_5_0_8b_full --workspace @webai/openai-api-tool
```

## What `tool_calls` reports

An endpoint that accepts tool declarations without complaining looks exactly like an endpoint that supports tool calling, until a call is asked for and counted. That is not a guess: the de-risk gate of [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) found LM Studio 0.4.20, serving one particular GGUF build of `llama-3.2-3b-instruct`, reading the tool wire format correctly, accepting `tools`, accepting `tool_choice: "required"`, and never generating a single tool call in any of four requests. Tool calling was dropped from this project on that finding, and that issue says plainly that anyone resuming should first re-run the gate against a different server or a different model build. This subcommand is that gate, made re-runnable against any endpoint that speaks the OpenAI-compatible API, so re-running it is one command instead of an afternoon.

Because that failure was a model that generates no call while reading tool results back perfectly well, "does tool calling work" is not a question with one answer. Six abilities are probed separately:

| Ability | How it is proved |
| --- | --- |
| `generates_a_call` | One tool declared that answers the question, and `tool_choice: "auto"`, sent `-r/--repeats` times. Supported once any one of the requests produced a call, and the observation names how many did, so a model that calls tools once in three tries is not recorded as a model that cannot. |
| `generates_a_call_when_forced` | The same question with `tool_choice: "required"`, which leaves the model no choice. This is the decisive probe: a model that writes plain text here was never offered the option of answering in words, so the result cannot be explained away as the model having preferred to. |
| `fills_in_the_arguments` | The arguments of the call it generated must parse as JSON, carry the argument the tool declared, and name the city the question asked about. A call naming the right tool and filled in with the wrong city is worse than no call at all, because the calling program would run it and answer confidently about the wrong place. |
| `chooses_among_several_tools` | Three tools declared and a question only one of them answers. Supported when the model asks for that one. |
| `reads_a_tool_result_back` | A history already carrying the question, the assistant's tool call, and a message whose role is `tool` holding a temperature no model could have known. Supported when the answer states that temperature. Generating a call and reading one back are two different abilities, and a model can have the second without the first — both models measured for [issue #119](https://github.com/webai-at-home/webai-at-home/issues/119) read a result back, and only one of them generated a call. |
| `answers_without_a_call_when_none_is_needed` | A tool declared and a question that needs none. Supported when the model answers in words. This is the negative control, and it is what proves the endpoint read the request rather than choking on it: without it, an endpoint failing every other probe cannot be told apart from one refusing the tool wire format outright, and that distinction is the whole finding of the de-risk gate. |

Each probe reports one of five conclusions: `supported`, `unsupported` (the endpoint accepted the request and the model did not do it — the finding this subcommand exists to catch), `refused` (the endpoint answered naming `tools` or `tool_choice` as the field at fault, which is a correct answer about that endpoint and not a fault), `inconclusive` (such as an arguments probe against a model that generated no call for the arguments to be read from), and `failed` (no answer arrived at all, so the ability was never tested). Only `failed` sets the process exit code to `1`.

No probe sends a generation control. This project's own `consumer_openai` server refuses a request asking a model for a control it cannot honour, so a `temperature: 0` added for determinism would turn every probe against the cluster into a refusal about temperature, which says nothing whatever about tool calls.

`-f/--format markdown` and `-f/--format json` carry every answer each probe produced, recording an answer that asked for a tool as the call it asked for, so a run of this subcommand is a finding worth pasting onto an issue rather than a claim to be taken on trust:

```sh
npx tsx ./src/cli.ts tool_calls --base_url http://localhost:1234/v1 --model qwen3.5-2b-mlx --format markdown
```

Convenience scripts run it against LM Studio directly, for the models this project measures most often, and against the cluster:

```sh
npm run tool_calls:lm_studio:qwen_qwen3.5-0.8b --workspace @webai/openai-api-tool
```

```sh
npm run tool_calls:lm_studio:llama-3.2-3b-instruct --workspace @webai/openai-api-tool
```

```sh
npm run tool_calls:webai_at_home:llm_qwen3_5_0_8b_full --workspace @webai/openai-api-tool
```

Against the cluster every ability that needs a generated call is reported `unsupported` today, and correctly so: `consumer_openai` reads `tools` and `tool_choice` and throws them away, which is what the tests in [`packages/consumer_openai/tests/index.test.ts`](../consumer_openai/tests/index.test.ts) already state. The cluster is worth probing anyway, because the negative control and the tool result probe pass there, which is what an endpoint that ignores tools looks like as against one that refuses them.

### Results so far

Measured on 11 August 2026, against LM Studio's server on `http://localhost:1234/v1`, in both modes, with `-r/--repeats` at its default of `3`.

| Model | Generates a call | Generates a call when forced | Fills in the arguments | Chooses among several tools | Reads a tool result back | Answers without a call when none is needed |
| --- | --- | --- | --- | --- | --- | --- |
| `qwen_qwen3.5-0.8b` (LM Studio) | yes | yes | yes | yes | yes | yes |
| `qwen3.5-2b-mlx` (LM Studio) | yes | yes | yes | yes | yes | yes |
| `llm_qwen3_5_0_8b_full` (this cluster) | yes | refused | yes | yes | yes | yes |

Both models scored 12 of 12, counting the nostream mode and the streamed mode separately, and both asked for `get_current_weather` on all three repeats of both elicitation probes.

This overturns the reason tool calling was dropped from this project. The de-risk gate of [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) was run against `llama-3.2-3b-instruct` and nothing else, and it found a model that never generates a tool call under any condition. That finding was correct about that model, and it was read as a finding about tool calling. `qwen_qwen3.5-0.8b` is the LM Studio name for the model the cluster already serves as `llm_qwen3_5_0_8b_full`, so the first model issue #78 named to carry tool calling does every part of it, and needs nothing downloaded that this project does not already run.

The cluster's own row was measured on 11 August 2026 against a real worker browser tab holding the model, through `consumer_openai`. Its one non-`supported` result is not a failure of the model: `consumer_openai` refuses `tool_choice: "required"` outright, because enforcing it means constraining generation and the chat templates this cluster drives cannot express that. Refusing is the point — it is the failure that closed [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), where a server accepted that setting, did not enforce it, and the model's answering in words read as "this model cannot call tools" when nothing had ever made it try. So `generates_a_call_when_forced` cannot be measured against this cluster, and the endpoint says so plainly rather than pretending.

Two of the six probes used to ask with `tool_choice: "required"` as a convenience and now ask with `"auto"`. What `fills_in_the_arguments` and `chooses_among_several_tools` need is a tool call to read, not a forced one, so forcing bought them nothing and cost them a `refused` against any endpoint honest enough to say it cannot force. Only `generates_a_call_when_forced` still asks to be forced, which is the whole of what it measures.

The streamed mode passing matters on its own. The plan on issue #78 said its whole ordering rested on the tool call behaviour holding under `stream: true`, against a real server, and that this had not yet been seen. It has now been seen, on both models, and it holds.

## Test it

```sh
npm run test --workspace @webai/openai-api-tool
```

The tests need no cluster and no gateway. The statistics, the model expansion, the aggregation, and the report rendering are checked on their own; the sender is checked against a local HTTP server started by the test, once for a real server-sent event stream whose pieces are spaced out over real wall-clock time, once for a server that ignores the streaming request and answers with one JSON body, and once each for `usage` and `finish_reason` read from the nostream response body and from the streamed final usage chunk. The `generation_controls` probes are checked the same way, against three stand-in endpoints: one that really honours all five, one that accepts every control and answers the same way regardless, and one that refuses every control the way this project's own `consumer_openai` server does.

The `tool_calls` probes are checked against four stand-in endpoints: one that really calls tools, one that accepts the tool declarations and never calls a tool — the exact shape the de-risk gate found, which must come out as two abilities unsupported, two inconclusive, and the two that need no generated call supported — one that always asks for the wrong tool with arguments that are not JSON, and one that refuses the tool declarations outright. The streamed mode is exercised against a stand-in that splits each call's arguments across two chunks, so assembling the streamed fragments back into one call is proved rather than assumed.

These stand-in endpoints prove that the probes reach the right conclusion from a given answer. They cannot prove anything about a real model, which is the whole point of the subcommand: run it against a real server to learn that.

## The source files

- [`src/cli.ts`](./src/cli.ts) — the `openai_api_tool` command line program: declares the six subcommands and dispatches to them.
- [`src/commands/completion_command.ts`](./src/commands/completion_command.ts) — the `completion` subcommand.
- [`src/commands/history_command.ts`](./src/commands/history_command.ts) — the `history` subcommand.
- [`src/commands/benchmark_command.ts`](./src/commands/benchmark_command.ts) — the `benchmark` subcommand.
- [`src/commands/usage_command.ts`](./src/commands/usage_command.ts) — the `usage` subcommand.
- [`src/commands/generation_controls_command.ts`](./src/commands/generation_controls_command.ts) — the `generation_controls` subcommand.
- [`src/commands/tool_calls_command.ts`](./src/commands/tool_calls_command.ts) — the `tool_calls` subcommand.
- [`src/completion_sender.ts`](./src/completion_sender.ts) — the one way this package sends a request and times it.
- [`src/benchmark_runner.ts`](./src/benchmark_runner.ts) — the warm-up and measured requests of one run, and the aggregation of what they measured.
- [`src/model_sweeper.ts`](./src/model_sweeper.ts) — expands `-m/--model` into the model identifiers to work through.
- [`src/statistics_calculator.ts`](./src/statistics_calculator.ts) — the average, median, minimum, and maximum of measured values.
- [`src/generation_control_prober.ts`](./src/generation_control_prober.ts) — the five probes, and what each one concludes from the answers it compared.
- [`src/report_renderer.ts`](./src/report_renderer.ts) — the outcome lines, the summary table, and the text, markdown, and JSON reports.
- [`src/generation_control_renderer.ts`](./src/generation_control_renderer.ts) — the same, for what the `generation_controls` probes concluded.
- [`src/tool_call_prober.ts`](./src/tool_call_prober.ts) — the six tool call probes, the tools they declare, and what each one concludes from the calls it counted.
- [`src/tool_call_renderer.ts`](./src/tool_call_renderer.ts) — the same, for what the `tool_calls` probes concluded.
- [`src/shared_options.ts`](./src/shared_options.ts) — every command line option all six subcommands accept.
- [`src/completion_types.ts`](./src/completion_types.ts) — every data shape the six subcommands share.
