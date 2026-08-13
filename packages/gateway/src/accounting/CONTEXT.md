# Directory Context: `/packages/gateway/src/accounting`

## Purpose

Registers and authenticates accounts, hands out and checks signing challenges, records one credit earned and one credit spent per completed stage, appends every event to the ledger, and answers what an account or every account holds.

## Key Exports & Entry Points

- `account_registry.ts`: `AccountRegistry`, which holds every account the gateway knows, and keeps them on disk.
- `challenge_registry.ts`: `ChallengeRegistry`, which hands out one-time values for an account to sign.
- `account_message_handler.ts`: `AccountMessageHandler`, which registers an account, hands out a challenge, and checks a signature.
- `accounting_recorder.ts`: `AccountingRecorder`, where one completed stage earns one credit and costs one credit.
- `ledger_store.ts`: `LedgerStore`, which appends every accounting event to a file, and never rewrites one.
- `accounting_query_handler.ts` and `accounting_summary_handler.ts`: answering what one account holds, and what every account holds, for an observer connection.

## Rules

- `LedgerStore` only appends. Nothing in this folder edits or deletes a written ledger entry; a correction is itself a new entry.
- An account's identifier and key pair shapes come from `@webai/protocol` and are never restated here.
- A challenge from `ChallengeRegistry` is single use: `AccountMessageHandler` consumes it on the first signature it checks, valid or not.

## Background

- The account file, the ledger file, and their `/data` volume location in the Docker image are documented on the package's own [`CONTEXT.md`](../../CONTEXT.md).
