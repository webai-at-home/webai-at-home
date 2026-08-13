# Directory Context: `/packages/consumer_cli/src/commands`

## Purpose

One file per subcommand of `consumer_cli`: submitting a task, reporting cluster status and capacity, measuring a recorded message log, and managing this participant's own account.

## Key Exports & Entry Points

- `submit_command.ts`: submits one task to the central gateway and prints what comes back.
- `status_command.ts`: prints the worker cluster's current state.
- `capacity_command.ts`: estimates how many concurrent runs of a task type the cluster supports, on top of `../cluster_capacity/`.
- `log_stats_command.ts`: prints everything measurable about one `.log_entry.jsonl` file, on top of `../message_log/`.
- `account_key_command.ts`, `account_register_command.ts`, `account_information_command.ts`, `account_balance_command.ts`, `account_history_command.ts`: the five account subcommands, on top of `../account/`.

## Rules

- A new subcommand is one file here, named `<subcommand>_command.ts`, and is registered in [`../cli.ts`](../cli.ts).
- Task input construction is never repeated here: `submit_command.ts` builds it through `../libs/task_input_factory.ts`.
- A subcommand opens its own connection through `../gateway_connection/` or `../account/`; nothing here keeps a connection open across two subcommands.

## Background

- `log_stats_command.ts` still answers to the subcommand's earlier name `log_stats`.
