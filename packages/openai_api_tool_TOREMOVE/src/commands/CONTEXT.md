# Directory Context: `/packages/openai_api_tool_TOREMOVE/src/commands`

## Purpose

One file per subcommand of `openai_api_tool`: sending completions, checking history, benchmarking latency, checking reported usage, and probing generation controls and tool calling.

## Key Exports & Entry Points

- `completion_command.ts`: sends one prompt per model and per mode, and reports which answered.
- `history_command.ts`: checks that a second turn recalls what the first turn said.
- `benchmark_command.ts`: measures one OpenAI-compatible endpoint's chat completion latency, on top of `../benchmark_runner.ts`.
- `usage_command.ts`: sends one prompt per model and per mode, and reports usage and `finish_reason`.
- `generation_controls_command.ts`: probes each of the five generation controls, one model at a time, on top of `../generation_control_prober.ts`.
- `tool_calls_command.ts`: probes each of the six tool call abilities, one model at a time, on top of `../tool_call_prober.ts`.

## Rules

- A subcommand never talks to an endpoint itself: every request goes through `../completion_sender.ts`, and every measurement through `../benchmark_runner.ts`.
- A subcommand does not build its own probing logic when one exists one level up — `generation_controls_command.ts` and `tool_calls_command.ts` are thin wrappers over their prober.
- Every subcommand accepts `-f/--format text|markdown|json` from `../shared_options.ts`, and does not declare its own copy of that option.
- `history_command.ts` sends its two turns `-r/--repeats` times and reports a model as not having recalled the facts only when no second answer of them all did.

## Background

- Nothing here needs a longer reason than the rule itself gives.
