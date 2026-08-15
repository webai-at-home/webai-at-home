# Directory Context: `/packages/openai_api_tool`

## Purpose

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside. It sends chat completion requests, times the first and last character of each answer, and reports what answered — this project's own `consumer_openai` server and any other such server alike, which is how the cluster is compared against a model running on one machine.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_api_tool` program, six subcommands in `src/commands/`: `completion`, `history`, `benchmark`, `usage`, `generation_controls`, `tool_calls`.
- `src/completion_sender.ts`: the one way this package sends a request and times it.
- `src/benchmark_runner.ts`: the warm-up and measured requests of one run, and their aggregation.
- `src/generation_control_prober.ts`, `src/tool_call_prober.ts`: the probes behind the last two subcommands, each with its own renderer.
- `src/shared_options.ts`: every option all six subcommands accept, reachable outside this package through the `./shared_options` subpath export, reused by [`packages/openai_conformance_test`](../openai_conformance_test/) rather than restated.
- `examples/`: one runnable example per task type and per calling style.

## Rules

- `./shared_options` and `./completion_types`, named in `package.json`'s `exports` field, are the only subpaths reachable from outside this package. Anything else is imported only from inside.
- The `openai` npm package is the single transport. Never build a request body, parse a server-sent event, or read a response body by hand.
- Every request goes through `CompletionSender`, every measurement through `BenchmarkRunner`; no subcommand or prober talks to an endpoint itself.
- This package holds no server and no gateway protocol. It depends on `@webai/consumer-cli` only for `taskTypeNames` and `taskTypeNamesAcceptingHistory`, never restating either list, and a model name outside those two lists is passed to the endpoint unchanged.
- `-f/--format text|markdown|json` is accepted everywhere; `text` is the default and only format streamed live, the other two print one report at the end.
- `generation_controls` concludes nothing from an endpoint having accepted a control: every probe compares repeated answers, and a refusal carrying `unhonourable_generation_control` is an answer about the model, never a failure.
- `tool_calls` probes six separate abilities rather than asking whether tool calling works; an ability found `unsupported` never sets the exit code.
- `tests/index.test.ts` runs without a cluster: its live tests start a local server.

## Background

- The generation control probes come from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), and the six separate tool call probes from [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), whose de-risk gate found a server that read the tool wire format correctly and never generated a call.
