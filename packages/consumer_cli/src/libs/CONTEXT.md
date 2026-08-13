# Directory Context: `/packages/consumer_cli/src/libs`

## Purpose

The task input every subcommand that submits work builds from command line text, and the one error shape a subcommand raises to end the process with a specific exit code.

## Key Exports & Entry Points

- `task_input_factory.ts`: `TaskInputFactory`, which builds the task input a consumer submits, from command line text.
- `cli_errors.ts`: `CliError`, a command failure carrying the process exit code it must end with.

## Rules

- `TaskInputFactory` is the one place that builds a `TaskInput`, so `@webai/consumer-openai` reuses it and the command line program and the OpenAI-compatible server build the same input from the same rules.
- This folder imports from no other folder of this package, so `account/`, `cluster_capacity/`, `commands/`, `gateway_connection/`, and `message_log/` may all depend on it without a cycle.

## Background

- Nothing here needs a longer reason than the rule itself gives.
