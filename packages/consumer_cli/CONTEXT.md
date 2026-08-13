# Directory Context: `/packages/consumer_cli`

## Purpose

The command line client of `webai-at-home`. It submits a task to the central gateway and follows it to completion, reports the connected workers and their free capacity, measures a recorded message log file, and manages this participant's own account in the accounting system.

## Key Exports & Entry Points

- `src/cli.ts`: the `consumer_cli` command line program, linked into the repository's `node_modules/.bin` once the package is built.
- `src/index.ts`: what another package may import from `@webai/consumer-cli` — `ConsumerClient` and `TaskInputFactory`.
- `src/cli.ts` is also reachable through the dedicated `./cli` subpath, which is how [`packages/webai_at_home_cli`](../webai_at_home_cli/) imports `Cli`.
- `src/gateway_connection/`, `src/commands/`, `src/cluster_capacity/`, `src/message_log/`, and `src/account/`: the connection to the gateway, one file per subcommand, and the code behind the `capacity`, `log_statistics`, and account subcommands.

## Rules

- `Cli` is not exported from `src/index.ts`: it is this package's own binary, not a symbol another package reuses through the default entry point.
- A new subcommand is one file in `src/commands/`, named after the subcommand, and is registered in `src/cli.ts`.
- Task input construction belongs in `src/libs/task_input_factory.ts`, so the command line program and the OpenAI-compatible server build the same input.
- Message shapes come from `@webai/protocol` and are never restated here.
- Every task type name passed to `--task_type` follows [`docs/naming_scheme.md`](../../docs/naming_scheme.md), and there is one `sample:<task type>` script in `package.json` per task type.

## Background

- The `log_statistics` subcommand still answers to its earlier name `log_stats`.
