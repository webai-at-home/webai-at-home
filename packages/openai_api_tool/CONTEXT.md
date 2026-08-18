# Directory Context: `/packages/openai_api_tool`

## Purpose

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside. It sends chat completion requests, times the first and last character of each answer, and reports what answered — this project's own `consumer_openai` server and any other such server alike.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_api_tool` program, whose six subcommands live in `src/commands/`.
- `src/completion_sender.ts`: the one way this package sends a request and times it.
- `src/benchmark_runner.ts`: the warm-up and measured requests of one run, and their aggregation.
- `src/generation_control_prober.ts`, `src/tool_call_prober.ts`: the probes behind `generation_controls` and `tool_calls`, each with its own renderer.
- `src/shared_options.ts`: every option all six subcommands accept, reused by [`packages/openai_conformance_test`](../openai_conformance_test/) through the `./shared_options` subpath export.

## Rules

- The four subpaths in `package.json`'s `exports` field are the only ones reachable from outside this package.
- The `openai` npm package is the single transport. Never build a request body, parse a server-sent event, or read a response body by hand.
- Every request goes through `CompletionSender`, every measurement through `BenchmarkRunner`; no subcommand or prober talks to an endpoint itself.
- This package holds no server and no gateway protocol. It depends on `@webai/consumer-cli` only for `taskTypeNames` and `taskTypeNamesAcceptingHistory`, and a model name outside those lists is passed to the endpoint unchanged.
- `-f/--format text|markdown|json` is accepted everywhere; `text` is the default and the only one streamed live.
- `generation_controls` concludes nothing from an endpoint having accepted a control: every probe compares repeated answers, and a refusal is an answer about the model, never a failure.
- `tool_calls` probes six separate abilities rather than asking whether tool calling works; an ability found `unsupported` never sets the exit code.
- `tests/index.test.ts` runs without a cluster: its live tests start a local server.
- **This package is frozen: bug fixes only, no new feature.** [`packages/openai_test`](../openai_test/) holds all of it now, and a fix made here is made there as well, since `ToolCallProber` and `GenerationControlProber` exist in both.

## Background

- The freeze comes from [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208), which merged this package and `packages/openai_conformance_test` into `packages/openai_test`. Both packages stay, and neither is deleted.

- The generation control probes come from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), and the six separate tool call probes from [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78).
