# Directory Context: `/packages/protocol/src/accounting`

## Purpose

The permanent account a participant owns, the signing key pair that account is, the three messages that put a named account on a connection, and the ledger entries that record what each account earned and spent.

## Key Exports & Entry Points

- `account_types.ts`: `AccountProfileSchema`, `AccountId`, `AccountPublicKeySpkiBase64`, `AccountSignatureBase64`, and `AccountSignatureAlgorithmName`.
- `account_identity.ts`: `AccountIdentity` — what an account signs, how its key is written, and how its identifier is derived from its public key.
- `account_authentication.ts`: `AccountAuthentication`, the three messages that put a named account on a connection.
- `account_key_file.ts` and `account_identity_file.ts`: keeping this participant's key pair and profile in one file each.
- `ledger_types.ts`: `LedgerEntry`, `LedgerDirection`, `CreditDelta`, `AccountLedgerSummary`, and `maximumLedgerPageSize`.

## Rules

- An account identifier is always derived from the public key, never chosen by the participant, so no two participants can claim the same account.
- The private key never appears in any shape defined here. A browser tab holds a key it cannot read out, and only the signature travels.
- A ledger entry is a record of something that already happened: nothing here defines a way to change or delete one.
- These are shapes only. Where the accounts and the ledger are actually kept is [`packages/gateway/src/accounting`](../../../gateway/src/accounting/).

## Background

- What a real browser tab can do with a key pair of its own was proven first in [`packages/_account_key_experiments`](../../../_account_key_experiments/), the de-risk gate of [issue #122](https://github.com/webai-at-home/webai-at-home/issues/122) and [issue #123](https://github.com/webai-at-home/webai-at-home/issues/123).
