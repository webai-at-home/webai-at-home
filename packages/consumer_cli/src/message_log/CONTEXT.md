# Directory Context: `/packages/consumer_cli/src/message_log`

## Purpose

Reads a recorded `.log_entry.jsonl` file, rebuilds what happened to each task and each stage run from it, and formats the report the `log_statistics` subcommand prints.

## Key Exports & Entry Points

- `log_entry_reader.ts`: `LogEntryReader`, which reads a `.log_entry.jsonl` file into validated `LogEntry` objects.
- `log_task_timeline.ts`: `LogTaskTimeline`, which rebuilds what happened to each task and each stage run from a log.
- `log_statistics.ts`: the measurement itself, behind the `log_statistics` subcommand.
- `log_statistics_types.ts`: `LogStatisticsTypes`, the shape of the report `log_statistics` measures and prints.
- `log_statistics_formatter.ts`: writes that report out.

## Rules

- The `.log_entry.jsonl` format is defined by `message_logger.ts` in `@webai/protocol`; when that format changes, `log_entry_reader.ts` is what has to follow.
- This folder only reads a log file. It never connects to a running gateway and never writes a log file itself.
- This folder imports from no other folder of this package.

## Background

- `log_statistics` still answers to its earlier name `log_stats`.
