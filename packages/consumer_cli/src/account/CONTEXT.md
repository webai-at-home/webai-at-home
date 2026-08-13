# Directory Context: `/packages/consumer_cli/src/account`

## Purpose

One connection that authenticates a participant's account and asks it questions, and how the five accounting subcommands write what it answers.

## Key Exports & Entry Points

- `account_client.ts`: `AccountClient`, one connection that authenticates an account and asks it questions.
- `account_output_format.ts`: `AccountOutputFormat`, how the five accounting commands — `account_key`, `account_register`, `account_information`, `account_balance`, `account_history` — write their answers out.

## Rules

- `AccountClient` opens and authenticates its own connection; a subcommand in `../commands/` never authenticates a connection itself.
- Message and account shapes come from `@webai/protocol` and are never restated here.

## Background

- Nothing here needs a longer reason than the rule itself gives.
