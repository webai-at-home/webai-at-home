# Directory Context: `/packages/consumer_cli`

## Purpose

The command line client of `webai-at-home`. It submits a task to the central gateway and follows it to completion, reports the connected workers and their free capacity, measures a recorded message log file, and manages this participant's own account in the accounting system.

## Key Exports & Entry Points

- `src/cli.ts`: the `consumer_cli` command line program, linked into the repository's `node_modules/.bin` once the package is built. Its subcommands are `submit`, `status`, `capacity`, `log_stats`, `account_key`, `account_register`, `account_information`, `account_balance`, and `account_history`.
- `src/index.ts`: what another package may import from `@webai/consumer-cli` — `ConsumerClient` and `TaskInputFactory`. `@webai/consumer-openai` reuses `ConsumerClient` to speak the consumer side of the gateway protocol.
- `src/gateway_connection/`: `consumer_client.ts`, `observer_client.ts`, and `gateway_session.ts`.
- `src/commands/`: one file per subcommand, each named `<subcommand>_command.ts`.
- `src/cluster_capacity/`: `capacity_calculator.ts` and `device_availability.ts`, behind the `capacity` subcommand.
- `src/message_log/`: reads and summarises a recorded `.log_entry.jsonl` file, behind the `log_stats` subcommand.
- `src/account/`: `account_client.ts` and `account_output_format.ts`, behind the account subcommands.

## Local Rules & Boundaries

- `Cli` itself is not exported from `src/index.ts`: it is this package's own binary, not a symbol another package reuses.
- A new subcommand is one file in `src/commands/`, named after the subcommand, and is registered in `src/cli.ts`.
- Task input construction belongs in `src/libs/task_input_factory.ts`, so the command line program and the OpenAI-compatible server build the same input.
- Message shapes come from `@webai/protocol`. Do not restate a wire shape here.
- Every task type name passed to `--task_type` follows [`docs/naming_scheme.md`](../../docs/naming_scheme.md), and there is one `sample:<task type>` script in `package.json` per task type.
