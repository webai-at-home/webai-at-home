# `@webai/openai-test`

One command line tool that tests, measures, and talks to any server speaking the OpenAI-compatible Chat Completions API. It answers three separate questions through three subcommands.

| Subcommand | The question it answers | What it returns |
| --- | --- | --- |
| `conformance` | Does this server honour the protocol, and what can the model behind it actually do | `PASS`, `FAIL`, `SKIP`, or `WARN` for each test, for each model |
| `benchmark` | How fast is this endpoint | Time to First Character and Time to Last Character, over repeated runs |
| `chat` | What does this endpoint actually answer | A session whose answers stream to the terminal |

It never grades whether an answer is a good answer. A model that replies with something unhelpful still passes, as long as the protocol was followed. What a test may do is read an answer whose prompt was built so that the behaviour under test is visible in it — asking twice with `temperature: 0` and comparing, for one — because that is a measurement rather than an opinion.

This package imports nothing from the rest of this repository. `npx tsx src/cli.ts` runs from a clean checkout with no workspace build first.

## Running it

```sh
npx tsx src/cli.ts conformance --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct --profile full
npx tsx src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
npx tsx src/cli.ts chat --base_url http://localhost:1234/v1 --model llama-3.2-3b-instruct
```

Without cloning this repository:

```sh
npx webai-at-home openai_test conformance --model llm_llama3_2_1b_full --profile full
```

## Naming the models

All three subcommands work with one model. `conformance` and `benchmark` both take the same `-m/--model`:

- one identifier — `llama-3.2-3b-instruct`
- `list` — print the identifiers the endpoint's own `GET /models` names, and send nothing else

`all`, a comma-separated list, and a pattern such as `llm_*` are refused by name. One run is one model and one report, so a value naming several has no answer here; sending it on as if it were an identifier would reach the endpoint as a model nobody serves, and the error a reader is then shown says nothing about what went wrong.

`chat` takes exactly one identifier, and refuses `list` as well, since a session has nowhere to print a listing to.

## `conformance`

- `--profile <name>` — `core`, `streaming`, `tools`, `parameters`, `structured_output`, `sdk`, `agent`, or `full`.
- `-g/--group <name>` and `-t/--test <id...>` — run part of a profile.
- `--stream <on|off>` — whether the tool call and generation control probes ask for the answer in pieces or in one response. Left out, both are measured, and the report says which row is which.
- `-r/--repeats <count>` — how many times a test that samples the model repeats before deciding. Defaults to `3`.
- `--thinking <on|off>` — whether the model may think before it answers the tool call and generation control probes. Defaults to `off`.
- `-v/--verbose` — print each test as it starts and as it finishes, on standard error, and print the detail of every test rather than only the ones that did not pass.
- `--ci` — print none of those lines, since a continuous integration log reads the report rather than the run.

| Verdict | Meaning |
| --- | --- |
| `PASS` | The protocol was followed. |
| `FAIL` | The endpoint claims to support this and behaves incorrectly. |
| `SKIP` | The endpoint said plainly that it does not support this. Left out of the compatibility percentage, because nothing was measured. |
| `WARN` | Correct, but in a way that may still break a client — a stream that arrives in one piece, or JSON wrapped in a code fence. |

`--thinking` and `--stream` both reach the tool call and generation control probes and nothing else, because every other test builds its own request with its own fixed shape. `--thinking off` sends `reasoning_effort: "none"` and is the default: measured against `google/gemma-4-e2b` on LM Studio 0.4.20, the full profile took 230 seconds with the model thinking and 66 seconds without, and `parameters.max_completion_tokens` and `parameters.stop` went from `FAIL` to `PASS`, because a thinking model spent an eight-token output budget on reasoning and answered with no text at all.

Those probe requests also carry an output budget of 128 tokens, which bounds a model that answers a one-sentence question with six paragraphs. The budget is sent only after one request carrying it has come back with text, and never on a request whose verdict a budget could change: the `max_completion_tokens` probe, the `stop` probe, and the request that asks about one control on its own.

One run is one report, however many stream settings the model was measured with: the runs are merged back into one list of records before any format sees them.

## `benchmark`

Every request is streamed, because Time to First Character and Time to Last Character are two separate numbers only while the answer arrives in pieces. No two requests are ever in flight at once.

- `-p/--prompt <text>` — the one prompt sent. Defaults to `Count up to 30`.
- `-r/--runs <count>` — measured requests. Defaults to `1`.
- `-w/--warmup_runs <count>` — unreported warm-up requests, so the first measured request is not the one that loaded the model. Defaults to `1`.
- `--thinking <on|off>` — whether the model may think before it answers. Defaults to `off`.
- `-v/--verbose` — print each warm-up and measured request as it is sent, and what it measured when it came back, on standard error.

`--thinking off` sends `reasoning_effort: "none"`, which both Ollama 0.17 and LM Studio 0.4.20 honour. It is the default because thinking happens before the first character of the answer: all of it lands inside Time to First Character and none of it inside Output Characters, so one model measured twice can differ threefold for a reason that has nothing to do with how fast the endpoint is. Measured on `gemma4:e2b`, turning thinking off took Time to First Character from between 2662 ms and 4618 ms down to under 600 ms. `--thinking on` sends no thinking field at all and leaves the decision to the endpoint — it cannot force a model to think, because no field of this interface can.

An endpoint that refuses `reasoning_effort` outright needs `--thinking on`. That is why `report:benchmark:openai:gpt-4.1-mini` carries it: the OpenAI API rejects the field for a model that does not reason, and it is the one endpoint here that cannot be checked without a paid key.

The markdown report is laid out the way the `conformance` report is: the headline numbers first, then the command line and the parameters that produced them, then what each of the five measured figures means, then the measurements themselves. Every measured request is listed behind the averages, because the spread between requests of the same model against the same endpoint is what says how much to trust the average of them.

## `chat`

- `--system <text>` — the system message opening the session.
- `-p/--prompt <text>` — send one turn and leave, without opening a session.

Three in-session commands, and no more: `/reset` clears the history and keeps the system message, `/history` prints every message the next turn will carry, and `/quit` leaves. Each is matched whole, so a turn that merely starts with a slash is still sent to the model. A turn the endpoint would not answer ends the turn, never the session.

## Reports, and exit codes

`conformance` and `benchmark` both accept `-f/--format text|markdown|json|junit` and `-o/--output <path>`. `chat` accepts neither; it is a terminal session, not a report.

Exit code `0` whenever the run finished and wrote its report, and `2` when the run itself could not start — an unusable command line, nothing listening at the endpoint, which one `GET /models` finds out before the first measurement rather than after every test has failed the same way, or an output file that cannot be written. `--ci` never changes which of the two is returned.

A failed test does **not** change the exit code. A verdict is what this program was run to find out, so returning a failing code for one made every shell that called it, and npm above it, print an error block over a run that worked perfectly and wrote its report. Read the report to find out what the endpoint did; read the exit code only to find out whether there is a report at all.

The `report:*` scripts of `package.json` write markdown reports into [`data/conformance_reports/`](data/conformance_reports/) and [`data/benchmark_reports/`](data/benchmark_reports/).

## The examples

Beside the three subcommands, [`examples/typescript/`](./examples/typescript) holds one short runnable program per task type and per calling style, each one written against the official `openai` package on npm rather than against this package's own client, and each one runnable on its own. They came here from [`packages/_openai_api_tool_TOREMOVE`](../_openai_api_tool_TOREMOVE/) when that package was frozen, so that every program sending a chat completion request from this repository lives in one package. Start with the development formula example, which needs no model download:

```sh
npm run example:ts:chat_completion_dev_formula --workspace @webai/openai-test
```

The others are `example:ts:list_models`, `example:ts:chat_completion_system_message`, `example:ts:chat_completion_nostream_llm_gemma_nano_chrome_full`, `example:ts:chat_completion_streamed_llm_gemma_nano_chrome_full`, `example:ts:chat_completion_nostream_llm_qwen3_0_6b_sharded`, `example:ts:chat_completion_streamed_llm_qwen3_0_6b_sharded`, `example:ts:chat_completion_nostream_llm_qwen3_5_0_8b_full`, `example:ts:chat_completion_streamed_llm_qwen3_5_0_8b_full`, `example:ts:chat_completion_history_llm_qwen3_5_0_8b_full`, `example:ts:chat_completion_nostream_llm_llama3_2_1b_full`, `example:ts:chat_completion_streamed_llm_llama3_2_1b_full`, `example:ts:chat_completion_history_llm_llama3_2_1b_full`, `example:ts:chat_completion_nostream_llm_gemma_4_e2b_full`, `example:ts:chat_completion_streamed_llm_gemma_4_e2b_full`, and `example:ts:chat_completion_history_llm_gemma_4_e2b_full`. Each file says at the top what the cluster has to have running for it to work. Every example reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set.

The three `history` examples are the ones to run to see a real history reach a worker: `llm_qwen3_5_0_8b_full`, `llm_llama3_2_1b_full`, and `llm_gemma_4_e2b_full` are the three models whose task type accepts a whole history rather than only one prompt, so each sends a fact in one request and asks for it back in a second request that carries the first request's own answer along with it.

### The same examples from a terminal

[`examples/clis/`](./examples/clis) holds the same set again, written as shell scripts against the official OpenAI command line program, https://developers.openai.com/api/docs/libraries/openai-cli, so that a reader who wants to try the server without writing any code can. Every script there matches a TypeScript example of the same name, and each one is registered as an `example:cli:*` script rather than an `example:ts:*` one:

```sh
npm run example:cli:chat_completion_dev_formula --workspace @webai/openai-test
```

They need two programs installed, `brew tap openai/tools && brew install openai/tools/openai` and `brew install jq`, and they read the same `OPENAI_BASE_URL` and `OPENAI_API_KEY` the TypeScript examples read. One script has no TypeScript counterpart: [`examples/clis/responses_dev_formula.sh`](./examples/clis/responses_dev_formula.sh) posts to `/v1/responses` where every other example posts to `/v1/chat/completions`.

## Its own tests

```sh
npm test --workspace @webai/openai-test
```

Every test starts its own local HTTP server where it needs an endpoint, so the suite needs neither this cluster nor a local model server.

## Where it came from

This package merges [`packages/_openai_api_tool_TOREMOVE`](../_openai_api_tool_TOREMOVE/) and [`packages/_openai_conformance_test_TOREMOVE`](../_openai_conformance_test_TOREMOVE/), which measured the same server twice and shared two probers between them. Both of those remain, and both are frozen: bug fixes only. See [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
