# The accounting system

This document describes how `webai-at-home` records contributed and consumed computation. It is the authoritative description of Version 1 of the accounting system, whose design is recorded in [issue #122](https://github.com/webai-at-home/webai-at-home/issues/122) and whose implementation is recorded in [issue #123](https://github.com/webai-at-home/webai-at-home/issues/123). The companion document [`protocol_by_role.md`](./protocol_by_role.md) describes the messages this system travels in, and [`tasks_and_stages.md`](./tasks_and_stages.md) describes the tasks and stages it counts.

The system exists to answer one question for a participant: what have I contributed, and what have I used? The principle it is built on is a single sentence:

> Contribute computation now, consume computation later.

## The single rule

> **One completed stage earns the worker one credit, and costs the consumer one credit.**

There is no pricing. The central processing unit, the graphics processing unit, the execution duration, the memory used, and the number of floating point operations all have no effect on what a stage is worth. Every completed stage is worth exactly the same.

That is a deliberate choice, and it is what makes the whole system two lines of arithmetic that anybody can check. A future version may charge by duration or by device capability, and the ledger is shaped so that such a change is a change to what is written into it rather than a redesign of where it is written. `CreditDelta` in [`packages/protocol/src/accounting/ledger_types.ts`](../packages/protocol/src/accounting/ledger_types.ts) accepts `+1` and `-1` and nothing else, so a version that starts charging more has to widen that definition rather than quietly write a larger number into the same file.

Two consequences follow from the flat rule, and neither is a fault. Credits earned and credits spent stay equal whatever happens, because every stage records both halves.

- **What an answer costs varies enormously between pipelines.** `dev_formula@1` runs two stages in total. `llm_qwen3_0_6b_sharded@1` runs its three shard stages once per generated token, so a hundred-token answer costs about three hundred credits.
- **A consumer's balance goes negative and nothing stops it.** Version 1 has no floor and refuses no work for a negative balance, exactly as the worked example in #122 describes. Turning a balance into scheduling priority is the separate subject of [issue #14](https://github.com/webai-at-home/webai-at-home/issues/14).

## An account

An account is one participant. It is permanent, and it is identified by a key pair the participant holds:

- The participant generates a signing key pair. `Ed25519` is used wherever the environment offers it, with `ECDSA` over the `P-256` curve as the fallback. Which browsers offer which was measured before any of this was built, in [`packages/_account_key_experiments`](../packages/_account_key_experiments/README.md).
- The **account identifier** is a digest of the public key: `account-` followed by the first thirty-two hexadecimal characters of the `SHA-256` digest of the key in its `spki` encoding. It is not handed out by the gateway. The same key pair is therefore the same account on every gateway, and no identifier can be claimed by anyone who does not hold the matching private key.
- The **account profile** holds the public key, the signature algorithm, an email address, a display name, and when the account was registered. The email address and the display name may both be empty: a volunteer who opens a worker browser page has agreed to donate computing time, not to give an email address, and the page registers an account for that volunteer either way.

The rules the gateway enforces around an account are these:

- **Registering states a public key; it does not prove anything.** Anyone can send anyone's public key. That is why registering a key the gateway already knows returns the stored profile and changes nothing: a registration must not be able to rewrite the email address or display name of an account somebody else owns. Editing a profile after the fact is not part of Version 1.
- **Authenticating proves the private key is held.** The gateway hands out a random value, the participant signs it, and the gateway checks the signature against the account's public key. The value is usable once and is spent by the attempt that presents it, accepted or refused, so a captured signature cannot be replayed. What is signed is not the bare value but `webai-at-home:account-authentication:v1:` followed by it, so a signature made to authenticate an account cannot be presented as a signature over something else.
- **An account is proved per connection.** A session belongs to one connection, and so does the account on it. A new connection proves the account again; the key pair itself stays where it is kept.
- **A connection may read its own account and no other.** There is no operator view of the whole cluster's accounting in Version 1.

### Where a key pair is kept

| Participant | Where the private key lives | Can the holder read it out? |
| --- | --- | --- |
| A worker browser tab | IndexedDB in that browser, under this origin | No. It is generated as non-extractable, so the browser signs with it and no script can copy it, including the page's own. |
| `consumer_cli` | `default.account_key.json` in a configuration directory, readable and writable by its owner only, defaulting to `~/.webai-at-home/consumer_cli_config` | Yes, necessarily. A process that ends holds nothing, so it has to be able to read the key back to be the same account on its next run. |
| `consumer_openai` | `default.account_key.json` in a configuration directory, defaulting to `~/.webai-at-home/consumer_openai_config` | Yes, for the same reason. |
| `worker_openai` | `default.account_key.json` in a configuration directory, defaulting to `~/.webai-at-home/worker_openai_config` | Yes, for the same reason. |

Each of the three takes a `-c, --config_dir <path>` option naming that directory, and never the key file itself: the name inside the directory is fixed at `default.account_key.json`, so nothing can point at a differently named file the rest of the system does not expect. Each defaults to its own directory, not a shared one: a task `consumer_cli submit` submits and a stage `worker_openai` completes are two different accounts by default, unless `--config_dir` is pointed at the same directory for both. Every one of these defaults is kept under the user's home directory rather than the running program's own install location, so it lands on the same directory wherever the command is invoked from, and survives even when the program was installed and run through `npx`, which keeps no writable folder of its own between runs.

A second file sits in the same directory, `default.identity.json`, holding this participant's profile:

```json
{
	"displayName": "my laptop",
	"emailAddress": "volunteer@example.com"
}
```

It holds no secret, it is created and edited by hand, and it may be absent — an absent file, or a missing field, reads as the empty string, which is the anonymous profile a worker browser tab registers with. Only `consumer_cli account_register` reads it, and it reads it once: registering a public key the gateway already knows changes nothing, so editing this file after the account has been registered changes nothing at the gateway either.

Every one of them proves its account the same way, through `AccountAuthentication` in the shared protocol package, and every one of them proves it **before** it does the thing that would otherwise be recorded against nobody: a worker registers only once its account is settled, and a consumer submits only once its own is. A participant that could not get an account carries on without one rather than refusing to work.

The two ways of keeping a private key — non-extractable in a browser, or in a file — have the same two consequences, and they are worth stating plainly because they decide what a participant can expect:

- **An account is one browser profile on one device, or one key file.** A person contributing from a laptop and from a phone earns into two accounts. Joining several of them to one person needs an account recovery or linking mechanism, which Version 1 does not have.
- **Losing the key pair loses the account.** An account identifier is a digest of its own public key and nothing else can produce it again, so there is no recovery. A browser page asks `navigator.storage.persist()` so the browser is less likely to evict its storage, and does not insist: Safari and the in-app Chromium of Claude Code both answered `false` when the de-risk gate asked them, and a page that refused to run without a promise would refuse to run at all. `account_key` refuses to overwrite an existing key file unless `--force` is given, for the same reason.

### The shared development account

A participant that has authenticated no account of its own is recorded against one shared development account, `account-shared-development`. The gateway's shared bearer token says nothing about who presented it, so that work cannot be attributed to anybody; recording it keeps the gateway's own development runs producing a readable ledger. The identifier is deliberately not shaped like a real one — those hold nothing but hexadecimal — so nobody can mistake it for a participant.

Every participant can now hold an account of its own, so this is where only a participant that has not been given one lands: a worker browser tab in a browser that cannot hold a key pair, and a command line program or server started with no key pair at the path it was told to look in. Nobody is stopped from contributing or consuming for want of an account.

## The ledger

The gateway owns the accounting database. It is one file, given by the gateway's `--ledger-file` option and defaulting to `gateway-ledger.jsonl`, holding one JSON object per line. It is appended to and never rewritten, and no line is ever edited or deleted.

A balance is therefore not stored anywhere: it is what an account's entries add up to. There is no stored number that could disagree with the history behind it, and every credit and debit can be traced back to the completed stage that caused it.

One completed stage writes **two** entries, not one: the worker earns and the consumer spends. Both carry the same task, stage, and assignment identifiers, which is what lets one stage be followed from either side.

```json
{"ledgerEntryId":"ledgerEntry-196a45b2-…","recordedAt":"2026-08-05T19:06:24.782Z","accountId":"account-7e4ece75…","creditDelta":1,"taskId":"task-5efafb37-…","stageName":"stage_dev_formula_multiply","stageAssignmentId":"stageAssignment-ab6c3499-…","workerDeviceId":"device-7848dbaf-…","consumerDeviceId":"device-da8a03d0-…","stageDurationMs":1}
{"ledgerEntryId":"ledgerEntry-3bea0d8a-…","recordedAt":"2026-08-05T19:06:24.782Z","accountId":"account-d10328d9…","creditDelta":-1,"taskId":"task-5efafb37-…","stageName":"stage_dev_formula_multiply","stageAssignmentId":"stageAssignment-ab6c3499-…","workerDeviceId":"device-7848dbaf-…","consumerDeviceId":"device-da8a03d0-…","stageDurationMs":1}
```

| Field | What it holds |
| --- | --- |
| `ledgerEntryId` | This entry's own identifier, which a reader also uses as a paging cursor. |
| `recordedAt` | When the gateway recorded it. |
| `accountId` | The account whose balance this entry changes. |
| `creditDelta` | `+1` for the worker that completed the stage, `-1` for the consumer that submitted the task. |
| `taskId` | The task the completed stage belongs to. |
| `stageName` | The stage that completed. |
| `stageAssignmentId` | The assignment the completed stage result answered. |
| `workerDeviceId` | The worker device that ran the stage. |
| `consumerDeviceId` | The consumer device that submitted the task. |
| `stageDurationMs` | How long the worker held the assignment, when that could be measured. It is information only, and changes no balance. |

Three properties of the file are worth knowing:

- **It is not the durable task state file.** `TaskStore` writes `gateway-state.json` whole, through a temporary file, on every single mutation. That is reasonable for a bounded set of tasks and wrong for a ledger: a hundred-token answer from the sharded pipeline records six hundred entries, and rewriting the whole history to add the next line would cost more with every line added.
- **A line the gateway cannot read stops it, naming the line.** Skipping it would report a balance wrong by however much was skipped, with nothing to say anything was missing. A `creditDelta` Version 1 does not have is refused as firmly as text that is not JSON.
- **Balances are held in memory and rebuilt from the file at start-up.** Answering "what is my balance" never touches the disk. History is read from the file instead, because holding every entry of an unbounded ledger in memory is exactly what the append-only file exists to avoid. A history read therefore scans the file, which is acceptable while a ledger is small and is the first thing to change when it is not.

## When the two entries are written

There is exactly one place a stage is known to have completed: the gateway accepting a `stage.result` for the assignment that is current. Both entries are written there and nowhere else.

- **Nothing is recorded for a stage that fails, is relinquished, or has its lease expire.** An unfinished attempt earns nothing and costs nothing.
- **A stage retried until it completes records one credit and one debit**, naming the attempt that actually finished and the worker that actually ran it. One completion is what happened, however many attempts it took.
- **A result the gateway has already recorded is not recorded again.** A worker whose connection dropped as it sent its result sends it again on reconnecting; the gateway says it already has it and the ledger does not move.
- **The consumer's account is read from the task, not from a session.** It is recorded on the task when the task is submitted, because a consumer that submitted batch work is expected to be gone by the time its stages complete. The worker's account is read from its live session, which is certainly there: it has just sent its result.

## What a participant does

### A worker browser tab

Nothing. Opening [`packages/worker_webpage`](../packages/worker_webpage/README.md) is the whole procedure. On the first visit the page generates a key pair, stores it in that browser, registers the public key with the gateway, and proves it by signing a challenge. On every later visit it reads the same key pair back and proves the same account.

The page proves its account **before** it registers as a worker, so no stage can complete before the gateway knows whose account earned it. A browser that cannot hold a key pair, or a gateway that does not know the account messages, releases the page to register anyway and contribute anonymously: contributing without an account is far better than a page that refuses to contribute.

The page shows the account identifier and what it holds, and refreshes the figure every time a stage result is accepted — the moment the balance actually changed.

### A server or a command line program

`consumer_cli`, the OpenAI-compatible server, and the Node.js worker each read a key file and prove that account as they connect. All three take the same option saying where to look, `-c, --config_dir <path>`, and read `default.account_key.json` inside it; each carries on with no account when there is no key pair in that directory. Each defaults to its own directory under `data/` in this checkout of the repository, listed in "Where a key pair is kept" above.

One deployment of the OpenAI-compatible server is one account. It is that server's account and not the account of whichever program called its OpenAI-compatible endpoint, because the server is what the gateway sees.

### An operator at the gateway

The gateway serves a `/ledger` page showing what every account has earned and spent, highest balance first, with the three totals above it: credits earned, credits spent, and how many accounts exist. Those first two are always equal, because every completed stage records both halves.

It is the one place any account other than your own is readable. The page connects as an observer — the same connection type the device list already goes to — and `accounting.summaries.get` is answered for an observer and nobody else. A participant cannot reach another participant's balance through the ordinary accounting messages, which is unchanged.

The page shows balances, not history: an account's own entries stay readable only by that account. Work by participants holding no account of their own appears as one row named for what it is, rather than looking like a volunteer.

### A person at a terminal

Five [`consumer_cli`](../packages/consumer_cli/README.md) commands, described in full in that package's README:

`submit` spends from the account in that key file too, and says which account it is submitting as, or that it is submitting as nobody.

| Command | What it does |
| --- | --- |
| `account_key` | Generates the key pair that is the account, and prints the account identifier. Talks to nothing. |
| `account_register` | Tells the central gateway about the public key, with the display name and the email address read from `default.identity.json`. |
| `account_information` | Prints the profile the gateway holds. |
| `account_balance` | Prints the balance, the stages completed as a worker, and the stages run as a consumer. |
| `account_history` | Prints the entries newest first, with `--direction earned`, `spent`, or `both`. |

`account_history --direction earned` is the list of completed stages and `--direction spent` is the list of consumed stages, which is why neither has a command of its own.

## The gateway's options

| Option | Default | What it sets |
| --- | --- | --- |
| `--account-file <path>` | `gateway-accounts.json` | Where account profiles are kept. This file holds profiles only, and no balance and no history. |
| `--ledger-file <path>` | `gateway-ledger.jsonl` | The append-only ledger. A ledger with no file to write to is refused outright, because balances that vanish when the gateway restarts are worse than a gateway that will not start. |
| `--account-challenge-ms <number>` | `60000` | How long a challenge handed out for an account to sign stays usable. |

Both files are written at run time and are excluded from version control.

## What Version 1 deliberately does not do

Every one of these is a decision, not an oversight. They are recorded in #122 and none of them is required for the foundation to be useful.

- No pricing by execution duration, graphics processing unit capability, floating point operation count, or memory use.
- No priority scheduling, and no refusal of work because an account's balance is negative.
- No credit transfer between accounts.
- No reputation or reliability score.
- No credit expiry or decay.
- No verification that a returned stage result is correct, which stays the separate open research question it already is.
- No cluster-wide accounting view beyond the gateway's own `/ledger` page, which shows balances and no history, and is answered only for an observer connection.
- No editing of an account profile after registration, and no account recovery or linking.

## Where the code is

| What | Where |
| --- | --- |
| Account and ledger types, and what a signature covers | [`packages/protocol/src/accounting`](../packages/protocol/src/accounting) |
| The accounts the gateway knows | [`packages/gateway/src/accounting/account_registry.ts`](../packages/gateway/src/accounting/account_registry.ts) |
| The one-time challenges | [`packages/gateway/src/accounting/challenge_registry.ts`](../packages/gateway/src/accounting/challenge_registry.ts) |
| Registering and authenticating an account | [`packages/gateway/src/accounting/account_message_handler.ts`](../packages/gateway/src/accounting/account_message_handler.ts) |
| The append-only ledger | [`packages/gateway/src/accounting/ledger_store.ts`](../packages/gateway/src/accounting/ledger_store.ts) |
| The two accounting rules | [`packages/gateway/src/accounting/accounting_recorder.ts`](../packages/gateway/src/accounting/accounting_recorder.ts) |
| Answering the three accounting reads | [`packages/gateway/src/accounting/accounting_query_handler.ts`](../packages/gateway/src/accounting/accounting_query_handler.ts) |
| The key pair in a browser, and proving it | [`packages/worker_webpage/web/src/connection/account_key_store.ts`](../packages/worker_webpage/web/src/connection/account_key_store.ts) and [`worker_account.ts`](../packages/worker_webpage/web/src/connection/worker_account.ts) |
| The three-message conversation every participant runs | [`packages/protocol/src/accounting/account_authentication.ts`](../packages/protocol/src/accounting/account_authentication.ts) |
| The key pair in a file | [`packages/protocol/src/accounting/account_key_file.ts`](../packages/protocol/src/accounting/account_key_file.ts), reached as `@webai/protocol/account_key_file` |
| The profile in a file | [`packages/protocol/src/accounting/account_identity_file.ts`](../packages/protocol/src/accounting/account_identity_file.ts), reached as `@webai/protocol/account_identity_file` |
| The five commands | [`packages/consumer_cli/src/commands`](../packages/consumer_cli/src/commands) |
| The browser experiment that proved a tab can hold a key pair | [`packages/_account_key_experiments`](../packages/_account_key_experiments/README.md) |

## Open questions

These were raised while planning Version 1 and are not settled:

1. **Is an unlimited negative balance really acceptable?** A brand new consumer with no contribution can run the whole cluster indefinitely. #14 is where that gets fixed.
2. **Should a worker browser page ask a volunteer for an email address and a display name at all?** It currently registers with neither and lets the volunteer stay anonymous.
3. **Is one credit per completed stage acceptable given the three-hundred-fold spread between pipelines**, or should a future version charge per task?
4. **What should happen when a browser evicts a key pair?** Today the account is simply gone.
