# Directory Context: `/packages/openai_api_tool`

## Purpose

The command line tool that exercises and measures a server speaking the OpenAI-compatible API, from the outside. It sends chat completion requests to an endpoint, times when the first and the last character of each answer arrived, and reports what answered. It reaches this project's own `consumer_openai` server and any other such server alike, which is how the cluster is compared against a model running on one machine.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_api_tool` command line program, with six subcommands, implemented in `src/commands/`: `completion`, `history`, `benchmark`, `usage`, `generation_controls`, and `tool_calls`.
- `src/completion_sender.ts`: the one way this package sends a request and times it. `src/completion_types.ts` holds every shared data shape.
- `src/benchmark_runner.ts`: the warm-up and measured requests of one benchmark run, and the aggregation of what they measured.
- `src/model_sweeper.ts`: expands `-m/--model` into the model identifiers to work through. `src/statistics_calculator.ts` and `src/report_renderer.ts` produce the figures and the lines a person reads.
- `src/generation_control_prober.ts`: the five generation control probes and what each one concludes. `src/generation_control_renderer.ts` writes out what they concluded.
- `src/tool_call_prober.ts`: the six tool call probes and what each one concludes. `src/tool_call_renderer.ts` writes out what they concluded.
- `src/shared_options.ts`: every command line option all six subcommands accept.

## Local Rules & Boundaries

- The `openai` npm package is the single transport. Never build a request body, parse a server-sent event, or read a response body by hand: one transport is what keeps the six subcommands comparable.
- Every request goes through `CompletionSender`, and every measurement through `BenchmarkRunner`. A subcommand must not talk to an endpoint itself, and neither must `GenerationControlProber`.
- This package holds no server and no gateway protocol. It depends on `@webai/consumer-cli` only for `taskTypeNames` and `taskTypeNamesAcceptingConversation`, which supply the model identifiers `all` and `list` name — do not restate either list here.
- `openai_api_tool` is a tool over the OpenAI-compatible chat completion API, not something specific to the Web AI at Home cluster. All five subcommands pass a model name outside `taskTypeNames`/`taskTypeNamesAcceptingConversation` through to the endpoint unchanged, so a name such as `qwen3.5-2b-mlx` on LM Studio works with `completion`, `history`, and `usage`, not only with `benchmark`.
- All five subcommands accept `-f/--format text|markdown|json`. `text`, the default for every subcommand, is the only format `completion`/`history`/`usage` stream live, colored with `chalk` (green `ok`, yellow `skipped`, red `failed`, turned off automatically once output is piped or redirected); `markdown`/`json` run the sweep silently and print one report once it finishes.
- `history` records every message of its two-turn conversation as `SweepOutcome.turns`, each with its `role`. `completion` leaves `turns` out entirely, since it sends one message rather than a conversation.
- `usage` sweeps every model of `taskTypeNames` the same way `completion` does, but reports `UsageOutcome`, not `SweepOutcome`: whether the answer's `usage` object was present and, when it was, its `promptTokens`/`completionTokens`/`totalTokens` and `finishReason`. It asks `CompletionSender.send` for the streamed mode's final, choice-less usage chunk with `includeUsage: true`, which `completion`/`history`/`benchmark` leave out, so their own requests are unchanged.
- `tests/index.test.ts` runs without a cluster. Its live tests start a local HTTP server rather than reaching a real endpoint, and it imports nothing that needs `@webai/consumer-cli` to have been built.
- `generation_controls` concludes nothing from an endpoint having accepted a control: every probe compares repeated answers and reports `honoured`, `not_honoured`, `refused`, `inconclusive`, or `failed`. A refusal carrying the code `unhonourable_generation_control` is the endpoint's answer about the model, not a fault, so it is never reported as a failure. Each control is asked about on its own first, so an endpoint refusing several of them names the right one each time. See [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
- `tool_calls` probes six separate abilities rather than asking whether tool calling works, because the de-risk gate of [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) found a server that read the tool wire format correctly and never generated a call. It sends no generation control at all, since `consumer_openai` refuses a control a model cannot honour and a `temperature: 0` added for determinism would turn every probe into a refusal about temperature. An ability found `unsupported` never sets the process exit code: a model that does not call tools is the finding, not a fault in the run.
