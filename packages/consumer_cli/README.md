# `@webai/consumer-cli`

Command-line client for the central gateway: submitting tasks, reading the worker cluster's current state, and estimating its capacity.

The program has four subcommands about tasks and the cluster: `submit` sends one task and shows its updates until it completes or fails, `status` reports the connected workers and their free capacity, `capacity` estimates how many concurrent runs of a task type the cluster can currently support, and `log_statistics` measures one already recorded `.log_entry.jsonl` message log file.

It has five further subcommands about this participant's own account in the accounting system: `account_key` generates the key pair that is the account, `account_register` tells the central gateway about it, and `account_information`, `account_balance`, and `account_history` read back what the gateway holds for it. [`docs/accounting_system.md`](../../docs/accounting_system.md) describes what an account and a credit are; the sections below describe the commands.

## Run with `npx`

Once this package has been built (`npm run build --workspace @webai/consumer-cli`), its `consumer_cli` binary is linked into the repository's own `node_modules/.bin`, so `npx` runs it from anywhere inside the project without the `npm run dev --workspace ... --` prefix the examples below use:

```sh
npx consumer_cli status
npx consumer_cli submit --task_type dev_formula 5
npx consumer_cli capacity --task_type dev_formula
```

If the `npx consumer_cli` command is not found, run `npm install` from the repository root once, so npm links the `bin` entry declared in this package's `package.json`.

## Shared options

Every subcommand accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `-u, --gateway-url <url>` | `GATEWAY_WS_URL` environment variable, then `wss://webai-gateway.dash-menu.com/` | The central gateway's WebSocket URL. |
| `-a, --auth-token <token>` | `GATEWAY_AUTH_TOKEN` environment variable, then `development-token` | Bearer token for the central gateway. |

`GATEWAY_WS_URL` and `GATEWAY_AUTH_TOKEN` are the same two names `packages/worker_openai` and `packages/docker_server` use for the same two settings, so one pair of exported variables points every program on this machine at the same gateway. See [`docs/environment_variables.md`](../../docs/environment_variables.md) for every variable this project reads and which programs read none.

## `submit`

From the repository root, with the central gateway running:

```sh
npm run dev --workspace @webai/consumer-cli -- submit --task_type dev_formula 5
```

Set the registered consumer name with `--consumer_name`, for example:

```sh
npm run dev --workspace @webai/consumer-cli -- submit --task_type dev_formula --consumer_name dev-formula-consumer 5
```

Use `--gateway-url` to connect to another WebSocket endpoint:

```sh
npm run dev --workspace @webai/consumer-cli -- submit --task_type dev_formula 5 --gateway-url ws://localhost:9000
```

`submit`'s own options:

| Option | Default | Meaning |
| --- | --- | --- |
| `-t, --task_type <type>` | — | Required. One of `dev_formula`, `llm_qwen3_0_6b_sharded`, `llm_gemma_nano_chrome_full`, `llm_qwen3_5_0_8b_full`, `llm_llama3_2_1b_full`, or `llm_gemma_4_e2b_full`. |
| `-n, --consumer_name <name>` | `consumer` | Name registered with the gateway. |
| `-s, --stream` | off | Ask a language-model task to return answer pieces while it runs. |
| `--log-dir <path>` | `~/.webai-at-home/consumer_cli/logs` | Where this submission's message log is written. Never the directory the command was run from. |

`-t/--task_type` is required and has no default: which task type to run is the decision of the person submitting, and this program cannot make it for them. A `submit` without it stops with `error: required option '-t, --task_type <type>' not specified` before it connects to anything. See [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171).

Use `-t/--task_type` to choose the task type:

- `dev_formula` takes a number.
- `llm_qwen3_0_6b_sharded` takes free text, and is run by three worker browser tabs, each holding one shard of the Qwen3-0.6B model.
- `llm_gemma_nano_chrome_full` takes free text, and is run by one worker browser tab using the Gemma Nano model built into Chrome.
- `llm_qwen3_5_0_8b_full` takes free text, and is run by one worker browser tab that downloads and holds the complete Qwen3.5-0.8B model.
- `llm_llama3_2_1b_full` takes free text or a whole history, and is run either by one worker browser tab that downloads and holds the complete Llama 3.2 1B Instruct model, or by a native worker that forwards the prompt to a local server already holding it.
- `llm_gemma_4_e2b_full` takes free text or a whole history, and is run by one worker browser tab that downloads and holds the complete Gemma 4 E2B instruction-tuned model. That tab needs a WebGPU adapter carrying `shader-f16` and about 3111 megabytes of free origin storage, and has no WebAssembly fallback, so a tab without such an adapter does not offer the stage at all.

```sh
npm run dev --workspace @webai/consumer-cli -- submit "hello there" --task_type llm_qwen3_0_6b_sharded
```

Use `-s/--stream` to ask for the answer in pieces as it is produced, rather than in one result once it is finished. Without it, the cluster answers with the fewest messages the pipeline can manage.

```sh
npm run dev --workspace @webai/consumer-cli -- submit "hello there" --task_type llm_gemma_nano_chrome_full --stream
```

`--stream` is not valid for `dev_formula`, which always returns one numeric
result. `submit` writes gateway messages to `~/.webai-at-home/consumer_cli/logs`, which `--log-dir` moves.

`submit` spends from this participant's account, so the stages its task runs are recorded against that account rather than against nobody. It reads the key pair from `default.account_key.json` inside the configuration directory given by `-c, --config_dir`, which defaults to `~/.webai-at-home/consumer_cli_config`, and says which account it is submitting as:

```
Submitting as account-37b98b4c860818d3396d3b4b1b04ab88.
```

A machine with no key pair at that path submits anyway, and says so:

```
Submitting with no account of its own, so the stages this task runs are recorded against the shared development account. Run "consumer_cli account_key" and "consumer_cli account_register" to have them recorded against you.
```

## `status`

Connects as an observer and prints the current worker cluster state: how many workers are connected, how much of their advertised capacity is free, and one row per worker.

```sh
npm run dev --workspace @webai/consumer-cli -- status
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--watch` | off | Keep the connection open and reprint on every change, until interrupted or disconnected. |
| `-f, --format <format>` | `text` | `text`, `markdown`, or `json`. |
| `--timeout <ms>` | `10000` | How long to wait for the central gateway to answer. |

Without `--watch`, `status` prints one snapshot and exits `0`. With `--watch`, it keeps reprinting until interrupted with Ctrl-C (clean exit `0`) or disconnected (non-zero exit); it does not reconnect on its own.

The header names the central gateway the snapshot was read from, and the git commit that gateway was built from, which `status` reads from the gateway's `/health` route. A gateway that names no commit, or that cannot be reached over HTTP, leaves the header as the address alone. Each row names the worker, the address it connected from, its state, its capacity, and the stages it offers:

```
gateway ws://localhost:8080 commit 0dc5bf47145f15bca2be97b384b35a3f240390e1
2 workers (2 ready, 0 draining, 0 unavailable) · capacity 2/2 available, 0 active

NAME               IP ADDRESS  STATE  CAPACITY  STAGES
worker-one         ::1         ready  0/1       stage_dev_formula_multiply
worker-two         127.0.0.1   ready  0/1       stage_dev_formula_multiply
```

The address is the one the central gateway observed when the worker connected, never one the worker states about itself; see [issue #183](https://github.com/webai-at-home/webai-at-home/issues/183) and [`packages/gateway`](../gateway/README.md) for how the gateway reads it. A worker whose address the gateway could not observe reads as `-` in the `text` and `markdown` formats, and as an empty address in `json`.

## `capacity`

Estimates how many concurrent runs of a task type the cluster can currently support, from the connected workers and the pipeline that serves that task type.

```sh
npm run dev --workspace @webai/consumer-cli -- capacity --task_type llm_qwen3_0_6b_sharded
```

```
llm_qwen3_0_6b_sharded: 1 concurrent run supported
  limited by: stage_llm_qwen3_0_6b_shard3of3 is the narrowest stage of the pipeline, with 1 free slot across 1 worker
```

A run's stages can be spread across different workers, so capacity is set by whichever stage has the least free capacity behind it. A capacity of zero states which of the two reasons it has: no connected worker runs the stage at all, or workers do run it and every one of them is busy, draining, or not ready. A stage that keeps state on one worker between rounds — such as a language-model shard's key-value cache — is sent back to the worker that ran that same stage, but that pins one stage to one worker, not the whole pipeline to one worker: three workers advertising one shard each can run the sharded pipeline.

| Option | Default | Meaning |
| --- | --- | --- |
| `-t, --task_type <type>` | — | `dev_formula`, `llm_qwen3_0_6b_sharded`, `llm_gemma_nano_chrome_full`, `llm_qwen3_5_0_8b_full`, `llm_llama3_2_1b_full`, or `llm_gemma_4_e2b_full`. |
| `-f, --format <format>` | `text` | `text`, `markdown`, or `json`. |
| `--timeout <ms>` | `10000` | How long to wait for the central gateway to answer. |

An unknown task type is an error with a non-zero exit code. `--task_type` is required.

## `log_statistics`

Reads one message log file — a `.log_entry.jsonl` file written by `MessageLogger` (see `@webai/protocol/message_logger`), for example one of the gateway's own `~/.webai-at-home/gateway/logs/gateway-*.log_entry.jsonl` files — and prints everything it measures: how much traffic it carried, who carried it, how long every reply and every task and every stage run took, and anything about the file worth a second look. It never connects to the central gateway, so it measures a capture from weeks ago exactly the same way as one from a moment ago.

```sh
npm run dev --workspace @webai/consumer-cli -- log_statistics ~/.webai-at-home/gateway/logs/gateway-2026-08-02T03-09-46-028Z.log_entry.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-f, --format <format>` | `text` | `text` (a human-readable report), `markdown` (the same report as pipe tables, for pasting into an issue or a notes file), or `json` (the full report as one JSON object). |
| `--top <count>` | `12` | How many rows of each table to print before the rest are only counted. |

A gateway log sees both the consumer and the worker side of every task, so it is the only log that can measure stage runs and worker compute time; a consumer's own log cannot see those, and reports "nothing measured" for them instead of guessing.

## The account commands

These five read and write this participant's own account in the accounting system, which records contributed and consumed computation: one credit for every stage this account has completed as a worker, less one for every stage it has had run as a consumer. [`docs/accounting_system.md`](../../docs/accounting_system.md) describes the whole system.

Every one of them accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `-c, --config_dir <path>` | `data/consumer_cli_config` | The directory holding this participant's configuration, relative to this checkout of the repository. |
| `-f, --format <format>` | `text` | `text` (aligned lines, or a table for `account_history`) or `json`. |

Two files live in that directory, both named exactly as written here:

| File | What it holds |
| --- | --- |
| `default.account_key.json` | The key pair that is this participant's account, written by `account_key` and read by every other command. **The private key in it is the whole account.** |
| `default.identity.json` | This participant's profile, as `{ "displayName": string, "emailAddress": string }`. Read by `account_register` and edited by hand. An absent file, or a missing field, reads as empty. |

All but `account_key` also accept `--timeout <ms>`, defaulting to `10000`, and the shared `--gateway-url` and `--auth-token` options.

### `account_key`

Generates the key pair that is this participant's account, and prints the account identifier it produces. It connects to nothing: an account identifier is a digest of its own public key, so it exists as soon as the key pair does, and the gateway learns about it later through `account_register`.

```sh
npm run dev --workspace @webai/consumer-cli -- account_key
```

```
account identifier   account-54e3b80f7c9facc7c3accd89266f238e
signature algorithm  Ed25519
public key           MCowBQYDK2VwAyEAj8SYEGeNC7G+Zx9WD5yW4d63oL6DCEWS3abJ7h8KQbU=
kept in              /Users/someone/webai-at-home/data/consumer_cli_config/default.account_key.json
generated at         2026-08-05T19:56:14.250Z
```

The file is written readable and writable by its owner only. **The private key in it is the whole account**: anyone holding the file can spend what the account has earned, and losing the file loses the account, because nothing else can produce that identifier again. `account_key` therefore refuses to overwrite an existing key pair unless `--force` is given.

| Option | Default | Meaning |
| --- | --- | --- |
| `--force` | off | Overwrite a key pair that is already there, losing the account it belongs to. |

### `account_register`

Tells the central gateway about this machine's public key, along with the display name and the email address read from `default.identity.json` in the configuration directory.

```sh
npm run dev --workspace @webai/consumer-cli -- account_register
```

The profile is stated in a file rather than on the command line, so it is written once and not retyped on every run:

```json
{
	"displayName": "my laptop",
	"emailAddress": "volunteer@example.com"
}
```

A configuration directory with no `default.identity.json` in it, or a file missing either field, registers with that field empty — the same anonymous profile a worker browser tab registers with. Nothing writes this file: it is created and edited by hand.

Running `account_register` twice is harmless: registering a public key the gateway already knows changes nothing and reports the profile it already holds, with `was created now` answering `no`. Registration does not prove that the sender holds the private key, so it must not be able to rewrite the email address or display name of an account somebody else owns; editing a profile is not part of Version 1 of the accounting system. Changing `default.identity.json` after the account has been registered therefore changes nothing at the gateway.

### `account_information`

Prints the profile the central gateway holds for this account: its identifier, its public key, its display name, its email address, and when it was registered.

```sh
npm run dev --workspace @webai/consumer-cli -- account_information
```

### `account_balance`

Prints what this account holds.

```sh
npm run dev --workspace @webai/consumer-cli -- account_balance
```

```
account identifier            account-91816a36753645188aec73ca7d4987ec
balance                       -10 credit(s)
stages completed as a worker  0
stages run as a consumer      10
```

A negative balance is a normal state and not an error: a consumer that has run more stages than it has completed simply owes that many, and Version 1 of the accounting system stops nobody for it.

### `account_history`

Prints this account's accounting entries, newest first.

```sh
npm run dev --workspace @webai/consumer-cli -- account_history --direction earned
```

```
account-64bcafe16744539cbd4b24eb889800b6, earned, newest first

recorded at               credit  stage                  task                                       stage took
------------------------  ------  ---------------------  -----------------------------------------  ----------
2026-08-05T19:57:07.807Z  +1      stage_dev_formula_add  task-1eab6867-3f27-41ba-99c4-62504e282a44  1ms

Further entries exist. Raise --limit, or pass --all to print the whole history.
```

`--direction earned` is the list of stages this account completed, and `--direction spent` is the list of stages it had run, which is why neither has a command of its own.

| Option | Default | Meaning |
| --- | --- | --- |
| `-d, --direction <direction>` | `both` | `earned`, `spent`, or `both`. |
| `-l, --limit <count>` | `20` | How many entries to ask for at a time. At most 500, which is the largest page the gateway will assemble. |
| `--all` | off | Keep asking for further pages until the whole history has been printed. |

## Exit codes

`status`, `capacity`, and the five account commands use these exit codes:

- `0` — success.
- `1` — connection failure (unreachable gateway, or dropped mid-`--watch`).
- `2` — authentication failure, which for an account command also covers a rejected signature and a request for an account this connection may not read.
- `3` — timed out waiting for the central gateway to answer.
- `4` — the central gateway sent something this client could not make sense of.

## Public exports

`@webai/consumer_openai` and any other package that reuses this one's consumer functionality import from `@webai/consumer-cli` itself:

```ts
import { ConsumerClient, type ConsumerClientCallbacks, type TaskSocket, TaskInputFactory, type TaskTypeName, taskTypeNames } from '@webai/consumer-cli';
```

- `ConsumerClient` — holds one connection to the central gateway: registers, submits a task, and reports every update through `ConsumerClientCallbacks`.
- `TaskSocket` — the part of a WebSocket connection `ConsumerClient` uses, so it works with both the `ws` package and a browser page's own connection.
- `ConsumerClientCallbacks` — the functions `ConsumerClient` calls as a task's history with the gateway proceeds.
- `TaskInputFactory` — turns command line or request text into the `TaskInput` the gateway expects, and checks whether a given string names a task type at all.
- `TaskTypeName` and `taskTypeNames` — every task type a consumer may submit, named without the leading `task_type_`.

This is the only supported entry point; `./libs/consumer_client` and `./libs/task_input_factory` are implementation files under `src/` rather than published subpaths. `Cli`, in `src/cli.ts`, is this package's own command line program rather than a reusable symbol, and is not exported either.

## Build

```sh
npm run build --workspace @webai/consumer-cli
```

For local checks, also run:

```sh
npm run typecheck --workspace @webai/consumer-cli
npm run test --workspace @webai/consumer-cli
```
