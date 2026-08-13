Runtime state the central gateway writes as it runs, kept out of git. None of it is checked in — see the `gateway-state.json`, `gateway-accounts.json`, and `gateway-ledger.jsonl` patterns in the repository root [`.gitignore`](../../../.gitignore).

| File | Written by | What it holds |
| --- | --- | --- |
| `gateway-state.json` | `--state-file`, default `gateway-state.json` | The gateway's durable task state. |
| `gateway-accounts.json` | `--account-file`, default `gateway-accounts.json` | The account profiles `account_register` records. |
| `gateway-ledger.jsonl` | `--ledger-file`, default `gateway-ledger.jsonl` | The append-only accounting ledger described in [`docs/accounting_system.md`](../../../docs/accounting_system.md). |

Each option's default is a bare file name, resolved against the working directory the gateway is started from, not against this folder. Running `gateway` from `packages/gateway/` with no flags writes fresh files there, not here — pass `--state-file data/gateway-state.json`, `--account-file data/gateway-accounts.json`, and `--ledger-file data/gateway-ledger.jsonl` to keep using this folder.
