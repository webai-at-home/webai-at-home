# Directory Context: `/packages/openai_test/src/chat`

## Purpose

The `chat` subcommand: sends turns to one model and streams each answer back to the terminal. It answers "what does this endpoint actually answer", which is neither a verdict nor a measurement to compare runs by.

## Key Exports & Entry Points

- `chat_command.ts`: `ChatCommand`, which reads the subcommand's options, sends the turns, and prints the answers.
- Command to run this folder: `npx tsx ../cli.ts chat --model <name> --prompt "..."`

## Rules

- `-m/--model` takes exactly one model identifier. `all`, `list`, a comma-separated list, and a pattern are refused by name rather than silently sent to the first model they match, because a session someone types turns into has one model behind it.
- `chat` accepts no `-f/--format` and no `-o/--output`. It is a terminal session, not a report.
- `chat` produces no verdict and sets no failing exit code. It returns `0`, or `2` when the run could not start at all.
- The timings printed under an answer are dimmed, and are there for the person reading them. Comparable measurements are what `benchmark` is for.

## Background

- The subcommand is interactive by the decision recorded in [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208); the session loop, `/reset`, `/history`, and `/quit` arrive in Milestone 6 of that issue, and until then `-p/--prompt` sends one turn and leaves.
