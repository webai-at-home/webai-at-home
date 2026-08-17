# Protocol by role

This document describes the current WebSocket protocol between the actors in
`webai-at-home`. The protocol is implemented in
[`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). The
protocol is an early prototype, and task storage is durable only as far as a
local state file.

Every client reconnects to the gateway on its own, through the shared
`ReconnectBackoff` rule in `@webai/protocol`, but this protocol defines nothing
about what a reconnected client may then do. A consumer that reconnects is
issued a new device identifier, and only the device that submitted a task may
read it, so a reconnected consumer is a stranger to its own task. See "What a
task revision carries" below.

## Actors

### Gateway

The gateway is the coordinator. The gateway accepts WebSocket connections,
assigns each connection a `deviceId`, validates incoming messages, keeps the
device registry and in-memory task store, assigns stages to workers, and
broadcasts task and worker updates.

The gateway is the only actor that schedules stages. Workers and consumers do
not send messages directly to each other for task processing. The gateway
relays signalling messages when a connection needs to exchange peer-connection
data.

### Consumer

A consumer submits work and receives task state. A consumer registers with
`role: "consumer"`, then submits a formula number, a language-model prompt, or a
whole history — which of the three a task type accepts is decided by `TaskInput`
in [`packages/protocol/src/task/task_types.ts`](../packages/protocol/src/task/task_types.ts).
The consumer receives the accepted task and later task updates. The command
line consumer closes its connection when the task reaches `completed` or
`failed`.

### Worker

A worker performs one or more named stages. A worker registers its name and the
stages that it supports. The gateway sends a `stage.assign` message when the
worker is selected. The worker computes the stage and replies with either
`stage.result` or `stage.failed`.

Most workers are browser tabs running `packages/worker_webpage`, and this
document says "worker browser tab" wherever something is true only of those. A
worker does not have to be a browser: `packages/worker_openai` is a Node.js
command line process that carries out its stage by calling a language-model
server running on its own device, and it speaks everything described here
unchanged. The gateway does not distinguish the two, and nothing in this
protocol names a browser.

For formula tasks, the gateway normally uses different workers for the two
stages when suitable workers are available. For the sharded language-model task,
each shard is pinned to its own worker and stays there for every round of one
task, so that the worker keeps that shard's in-memory key-value cache between
generation rounds. The three shards are therefore normally on three different
devices, which is the arrangement the sharded pipeline exists for; one device
advertising all three shards also works, and is what the project is trying to
avoid. See "The assignment lease" below.

### Observer

An observer is a read-only connection used by the gateway home page and flow
viewer-style tooling. An observer sends `observe` and receives the current
worker list. An observer is not added to the worker registry and cannot submit
tasks or return stage results.

## Connection and registration

All actors use a WebSocket connection to the gateway. The gateway creates a
device identifier when the connection opens and returns that identifier after a
successful registration.

The client sends one of these initial messages:

```json
{ "type": "deviceRegister", "role": "consumer", "name": "consumer" }
```

```json
{
  "type": "deviceRegister",
  "role": "worker",
  "name": "browser-worker-a",
  "stageNames": ["stage_dev_formula_multiply", "stage_dev_formula_add"]
}
```

A worker chooses those stage names from the pipelines the gateway reports for `pipelines.get`, keeping every stage whose computation it implements. A worker that sends no `stageNames` at all is taken to run every stage the loaded pipelines define. See "Pipelines, stages, and computations" below.

The gateway replies to either registered role with:

```json
{ "type": "deviceRegistered", "deviceId": "device-..." }
```

An observer sends:

```json
{ "type": "observe" }
```

The gateway replies with `devices` and does not send `deviceRegistered`.

### Worker identity and worker names

- The `deviceId` the gateway creates when the connection opens is what identifies a worker. It is what the device registry is keyed by, what a task records in `stageWorkerDeviceIds` when a stage keeps state on the device that ran it, and what every assignment names.
- The `name` a worker registers under is a display label and nothing more. Two or more connected workers are allowed to register under the same name, and the gateway does nothing about it: it never refuses such a registration, and it never closes the older connection. Opening one debug page twice therefore leaves both copies of its worker browser tabs connected, six workers under three names.
- A device is removed from the registry only when its own connection closes. The gateway then announces `device.left` for that one `deviceId`, and no other device is touched.
- A worker that wants to be told apart from another worker on screen should register under a name of its own. When two connected devices do share a name, the monitor page displays that name followed by the start of each device's own identifier, so the two are still distinguishable; the whole identifier is shown on every device in any case.
- There is no intentional-replacement message. A worker that wants to take the place of an older one closes the older connection itself; the gateway offers nothing that closes somebody else's connection.

## The wrapper every message travels in

Nothing in this protocol travels bare. Every frame, in either direction, is an object with four fields:

- `v` is the protocol version the frame was written for. The current version is 9, declared by `protocolVersion` in [`packages/protocol/src/message/envelope_types.ts`](../packages/protocol/src/message/envelope_types.ts). No earlier version is accepted.
- `id` is the frame's own identifier, generated by whoever sent it.
- `ts` is when the frame was sent, in ISO 8601 format.
- `body` is the message itself, which is what the rest of this document describes.

A gateway frame may carry a fifth field, `inReplyToMessageId`, holding the `id` of the client request it answers. That field is the whole distinction between an answer and a push: an answer names its request, and a message the gateway sends on its own initiative names nothing. A client no longer has to guess from the message type or from the order messages arrive in, and two requests of the same kind in flight at once are each matched to their own answer.

```json
{
  "v": 9,
  "id": "message-4f1c...",
  "ts": "2026-01-01T00:00:00.000Z",
  "body": { "type": "task.get", "taskId": "task-..." }
}
```

```json
{
  "v": 9,
  "id": "message-9ab3...",
  "ts": "2026-01-01T00:00:00.010Z",
  "inReplyToMessageId": "message-4f1c...",
  "body": { "type": "task.snapshot", "task": { } }
}
```

The gateway checks the version on every frame, which means it checks it on `deviceAuthenticate`, the first frame a connection sends. A client stating a version the gateway does not support is answered straight away with the error code `UNSUPPORTED`, whose details list the versions that are accepted. A client that sends a message without the wrapper at all — which is what a peer built before the wrapper existed does — gets the same error code with an explanation of what is now required, rather than a bare complaint that its message did not validate.

The gateway's message log records `messageId`, `inReplyToMessageId`, and `protocolVersion` on each entry, and uses the frame's own `ts` as the entry timestamp. The flow viewer reads those fields to draw each answer against the request it answers. A log recorded before the wrapper existed carries none of them and still renders.

## Authentication is a development placeholder

**The single shared token this gateway accepts is not authentication, and nothing downstream should treat the authenticated identity as a security boundary.** Every connection presents the same token, which is a command-line option with a default value, so every client that connects is the same identity by construction. The gateway can tell that a caller holds the token; it cannot tell one holder from another, and it cannot tell an authorized holder from anyone who copied the token. Designing real authentication remains an open decision, listed at the end of this document.

An account is what makes one participant distinguishable from another, and it is separate from this token: a connection presents the shared token to open a session, and then proves which account is on that session by signing a value the gateway hands it. That signature is real evidence — the private key never leaves the participant — but it sits on top of a shared token that is not, so a gateway reachable by anyone who has the token remains a development gateway. See "Accounts and accounting" below, and [`accounting_system.md`](./accounting_system.md).

What the gateway does guarantee is that it honours the session rules it states:

- **The advertised expiry is enforced.** `deviceAuthenticated` carries an `expiresAt`, and that moment is now checked on every message rather than only when the connection authenticates. It used to be advertised and never looked at again, so a connection stayed authenticated for as long as it stayed open.
- **Expiry does not drop the connection.** A message sent after the session runs out is refused with `AUTHENTICATION_REQUIRED`, marked retryable. The client sends `deviceAuthenticate` again on the same connection and retries the request; it never has to reconnect.
- **The authenticated identity is derived from the whole credential.** It is a digest of the credential, so two different tokens cannot become the same identity, and no readable part of the credential ends up in task records or log files. It used to be the first twelve characters of the token, which meant tokens sharing a prefix collided into one identity and shared its task quota, and which copied most of the credential into every log file.
- **The per-identity active-task limit follows the live session.** The limit checked in `task.submit` uses the authenticated identity of the session that is authenticated at that moment, not one captured earlier when the connection registered.

How long a session lasts is set by `--session-ms`, and defaults to one hour.

## Accounts and accounting

A connection that has presented the shared token is one holder of that token among many, and the token says nothing about which participant is on it. Three further messages turn such a connection into a named account, and three more read what that account holds. [`accounting_system.md`](./accounting_system.md) describes what an account and a credit are; this section describes only the messages.

The account messages and the accounting reads are all answered **before** registration, because a worker browser page proves which account it is before it registers as a worker, and a command line program that only wants to read its balance never registers as a device at all. All six still require an active session: account registration is not open to a connection that has presented nothing.

### Proving which account is on a connection

```json
{ "type": "account.register", "signatureAlgorithmName": "Ed25519", "publicKeySpkiBase64": "MCowBQYDK2Vw...", "emailAddress": "", "displayName": "browser-worker-a" }
```

```json
{ "type": "account.registered", "account": { "accountId": "account-422c1433a9c0d8746e2c1ed842b740b7", "signatureAlgorithmName": "Ed25519", "publicKeySpkiBase64": "MCowBQYDK2Vw...", "emailAddress": "", "displayName": "browser-worker-a", "createdAt": "2026-08-05T20:17:35.510Z" }, "isNewAccount": true }
```

`emailAddress` and `displayName` may both be left out, and both may be empty. The account identifier is not chosen by either side: it is a digest of the public key. Registering a public key the gateway already knows returns the stored profile unchanged and answers `isNewAccount: false`, which is what lets a page register on every visit rather than remembering whether it has registered before.

```json
{ "type": "account.challenge.request" }
```

```json
{ "type": "account.challenge", "challenge": "8561f65aa284e30e...", "expiresAt": "2026-08-05T18:23:33.625Z" }
```

```json
{ "type": "account.authenticate", "accountId": "account-422c1433a9c0d8746e2c1ed842b740b7", "signatureBase64": "At8g8qYgARRc0crG..." }
```

```json
{ "type": "account.authenticated", "accountId": "account-422c1433a9c0d8746e2c1ed842b740b7", "expiresAt": "2026-08-05T19:22:33.621Z" }
```

What is signed is not the challenge on its own. It is the text `webai-at-home:account-authentication:v1:` followed by the challenge, encoded as UTF-8, so a signature made to authenticate an account cannot be presented as a signature over something else the same key pair might be asked to sign.

A challenge belongs to the connection it was handed to, and is usable once: it is spent by the attempt that presents it, whether the signature was accepted or refused. A sender whose signature was refused therefore asks for a new value rather than trying again against the same one.

`account.authenticated` reports the session expiry, and does not extend it. Signing a challenge says who is on the connection, not for how long: the expiry still belongs to the credential the connection presented to open the session.

### Reading what an account holds

```json
{ "type": "account.get" }
```

```json
{ "type": "account.balance.get" }
```

```json
{ "type": "account.ledger.get", "direction": "earned", "limit": 20, "before": "ledgerEntry-f83846e0-..." }
```

Each of the three may name an `accountId` and none has to. Naming none means the account the connection has authenticated as, which is the only account it may read. Naming its own is allowed, and is how a client states which account it believes it is and is told plainly when it is wrong; naming another is refused with `AUTHORISATION`, and the error names the account the connection actually is.

The answers are `account.profile`, `account.balance`, and `account.ledger`:

```json
{ "type": "account.balance", "summary": { "accountId": "account-91816a36...", "balance": -10, "earnedStageCount": 0, "spentStageCount": 10 } }
```

```json
{ "type": "account.ledger", "accountId": "account-91816a36...", "direction": "both", "entries": [], "nextCursor": "ledgerEntry-f83846e0-..." }
```

`account.ledger` states the direction it was read in, so a page says what it is a page of. Entries come newest first. `nextCursor` is present only while there is more to read, so a reader stops when it is absent rather than by counting what it has, and it is the `ledgerEntryId` of the last entry of the page. A cursor naming an entry the account does not have returns nothing, rather than the newest page again, so a stale cursor cannot be mistaken for progress. `limit` may not exceed 500, the largest page the gateway will assemble; a larger one is refused as the message is validated rather than quietly answered with less.

### Reading what every account holds

One message reads further than the asking connection's own account, and it is drawn narrowly: it is answered for an observer connection and no other.

```json
{ "type": "accounting.summaries.get" }
```

```json
{ "type": "accounting.summaries", "summaries": [{ "accountId": "account-785c857b…", "displayName": "alice", "createdAt": "2026-08-06T03:24:03.682Z", "balance": 6, "earnedStageCount": 8, "spentStageCount": 2 }] }
```

A row is one account's ledger summary joined with the little of its profile that makes the row recognisable, so a reader answers "what does everybody hold" with one request rather than two lists to match up. Rows come highest balance first, ties broken by account identifier so two reads that changed nothing come back in the same order.

Every account either source names is included: one that registered but has not worked yet appears with a balance of zero, and the shared development account appears with entries and no profile fields, since it was never registered. A connection that is not an observer is refused with `AUTHORISATION`.

This is what the gateway's own `/ledger` page reads. Balances only: an account's entries stay readable by that account alone.

### The account error codes

| Code | What it means | Retryable |
| --- | --- | --- |
| `ACCOUNT_NOT_FOUND` | The gateway holds no account with that identifier. Register it first. | No |
| `ACCOUNT_CHALLENGE_INVALID` | There is no challenge outstanding on this connection, or the one there was has expired. Ask for another and sign that. | Yes |
| `ACCOUNT_SIGNATURE_REJECTED` | The signature was not produced over this challenge by this account. | No |
| `ACCOUNT_REQUIRED` | This connection has authenticated no account, so it has none of its own to read. | Yes |

## Message direction by role

| Message | Sender | Receiver | Purpose |
| --- | --- | --- | --- |
| `observe` | Observer | Gateway | Request the current worker list. |
| `deviceRegister` | Consumer or worker | Gateway | Declare the connection role, name, and worker stages. |
| `deviceRegistered` | Gateway | Consumer or worker | Confirm registration and provide `deviceId`. |
| `task.submit` | Consumer | Gateway | Submit a validated formula or language-model task input. |
| `task.accepted` | Gateway | Consumer | Return the newly created task. |
| `pipelines.get` | Any authenticated client | Gateway | Request the pipeline specifications the gateway has loaded. Answered before registration, because a worker uses the answer to decide which stages to advertise. |
| `pipelines` | Gateway | The requesting client | Return the loaded pipeline specifications. |
| `task.get` | Task owner or granted observer | Gateway | Request the full state of one task by identifier. |
| `task.history` | Task owner or granted observer | Gateway | Request the complete change log of one task. |
| `task.snapshot` | Gateway | The requesting client | Return the full state of one task, in reply to `task.get`, `task.resync`, or `task.observe`. |
| `task.updated` | Gateway | Task owner and granted observers | Announce one task revision, as the slim projection rather than the whole task. Never sent to a worker. |
| `stage.assign` | Gateway | Worker | Ask a worker to execute one stage for one task. |
| `stage.cancel` | Gateway | Worker | Tell a worker that its assignment was cancelled or superseded, so it can drop any state it holds for the task. |
| `stage.heartbeat` | Worker | Gateway | Say that the worker is still running its assigned stage, so the gateway extends the assignment lease. |
| `stage.lease.extended` | Gateway | Worker | Return the new lease expiry, in reply to `stage.heartbeat`. |
| `stage.result` | Worker | Gateway | Return the output of the expected next stage. |
| `stage.failed` | Worker | Gateway | Report that a stage could not be completed. |
| `signal` | Any connected client | Gateway, then target client | Relay peer-connection signalling data. |
| `devices.subscribe` | Any registered client | Gateway | Ask to receive device membership messages. The gateway replies with `devices`. |
| `devices.unsubscribe` | Any registered client | Gateway | Stop receiving device membership messages. |
| `devices` | Gateway | Device membership subscribers | Report every currently connected device. |
| `device.joined` | Gateway | Device membership subscribers | Report one device arriving. |
| `device.updated` | Gateway | Device membership subscribers | Report a change to one device's own description, such as its name or its stage list. |
| `device.activity` | Gateway | Device membership subscribers | Report how busy one or more devices now are, batched over a short window. |
| `device.left` | Gateway | Device membership subscribers | Report one device leaving. |
| `account.register` | Any authenticated client | Gateway | State a public key, so stages can be recorded against the account it identifies. Answered before registration. |
| `account.registered` | Gateway | The requesting client | Return the profile the gateway holds for that public key, and whether this call created it. |
| `account.challenge.request` | Any authenticated client | Gateway | Ask for a one-time value to sign. |
| `account.challenge` | Gateway | The requesting client | Return the value to sign and when it expires. |
| `account.authenticate` | Any authenticated client | Gateway | Prove which account is on this connection, by signing that value. |
| `account.authenticated` | Gateway | The requesting client | Confirm the account now on the connection, and restate the session expiry. |
| `account.get` | Account holder | Gateway | Request this account's own profile. |
| `account.profile` | Gateway | The requesting client | Return that profile. |
| `account.balance.get` | Account holder | Gateway | Request what this account holds. |
| `account.balance` | Gateway | The requesting client | Return the balance, the stages earned, and the stages spent. |
| `account.ledger.get` | Account holder | Gateway | Request one page of this account's accounting entries. |
| `account.ledger` | Gateway | The requesting client | Return that page, newest first, with a cursor while there is more. |
| `accounting.summaries.get` | Observer | Gateway | Request what every account holds. Answered for an observer connection and no other. |
| `accounting.summaries` | Gateway | The requesting observer | Return one row per account, highest balance first. |
| `error` | Gateway | The requesting client | Report invalid input, an unexpected stage, or another protocol error. |

## Diagnostics do not travel on the scheduling connection

A worker browser page cannot write files, so it tells the gateway which messages it saw and the gateway appends them to that worker's log file on its behalf. This whole path exists for that one reason, so a worker that is an ordinary process, such as `packages/worker_openai`, does not use it at all and writes its own output instead. That reporting used to travel over the same WebSocket connection as scheduling, where it was 37 percent of all messages and 49 percent of all bytes in a measured run, was never validated against a schema, and had no limit of any kind. Diagnostic traffic therefore competed with the messages that assign stages and collect results (see [issue #50](https://github.com/webai-at-home/webai-at-home/issues/50)).

Reporting now travels over HTTP instead, and the scheduling connection refuses it outright.

- **Where it goes.** A worker posts to `POST /diagnostics` on the gateway, in batches, every two seconds. The endpoint answers cross-origin requests, because a worker page is normally served by a different development server than the gateway.
- **What it carries.** Only the direction, the message type, the time the browser saw the message, and the identifier of the frame it travelled in. It carries no message bodies at all.
- **Why no bodies.** The gateway is the other end of every connection a worker has, so it has already recorded the body of every message the worker could report. The only fact the worker adds is its own view of the timing. The frame identifier joins each entry to the gateway's own record of the same message, which does carry the body.
- **How it is guarded.** The request must present the same bearer token the WebSocket connection uses, and must name a device that currently holds an authenticated connection. The body is validated by `DiagnosticsBatchSchema`, is capped at 64,000 bytes and 200 entries per report, and each device may report at most 600 entries per ten seconds. A report that exceeds any of these is refused rather than partly recorded.
- **What happens when it fails.** The worker drops entries rather than retrying forever. Diagnostics are never allowed to delay the work or grow without bound in the page's memory.

Because a report cannot carry a message body, task data cannot travel this path at all, rather than travelling it and relying on redaction to remove the data afterwards.

## A worker browser page announces its own departure over HTTP

A worker browser page whose tab is being closed cannot rely on the WebSocket connection to say so. The close frame it sends is queued at the moment the browser is destroying the tab, so the browser never promises to write it to the network, and a reverse proxy in front of the gateway can hold its own upstream connection open after the browser side is gone. When the close frame never arrives, the only thing that notices is the gateway's ping, up to `--heartbeat-timeout-ms` later (see [issue #176](https://github.com/webai-at-home/webai-at-home/issues/176)).

- **Where it goes.** The page sends `POST /departure` with `navigator.sendBeacon` from its `pagehide` handler, which is the one request a browser promises to deliver after the page is gone. It still closes the WebSocket connection as well, because a page merely put into the back and forward cache is alive and its close frame is written normally.
- **What it carries.** The device identifier and the bearer token, and nothing else, validated by `DepartureSchema`.
- **Why it is plain text.** A browser refuses to send a cross-origin JSON body until it has asked the other side for permission, and a beacon sent from a page that is being destroyed cannot wait for that answer. The content type both sides agree on is `departureContentType` in `@webai/protocol`. The token travels in the body for the same reason: a beacon can set no `authorization` header.
- **How it is guarded.** Exactly as a diagnostics report is: the token must match, and the named device must currently hold an authenticated connection. The body is capped at 2,000 bytes.
- **What the gateway does.** It terminates that device's WebSocket connection and nothing else. Every piece of forgetting is then done by the same close handling that runs for a connection which ended any other way.

## Task submission flow

1. A consumer registers with the gateway.
2. After `deviceRegistered`, the consumer sends `task.submit`.
3. The gateway validates `TaskInput`, creates a task in `queued` state, and
   returns `task.accepted`.
4. The gateway chooses the first worker that advertises the first stage and
   sends `stage.assign`.
5. The worker computes the assigned stage and sends `stage.result`.
6. The gateway checks that the returned stage is the expected next stage,
   stores the result, and either assigns the next stage or completes the task.
7. The gateway broadcasts `task.updated` after each state change. The task
   ends in `completed` with `result`, or in `failed` with `error`.

### What a task revision carries

`task.updated` carries a slim projection of the task, not the task itself: the task identifier, the task revision number, the state, the time of the change, the number of completed stages, the stage now running, the identity of the current stage assignment without its stage input value, and the error or the final result. Its size therefore does not grow as a task runs more stages. This matters most for the language-model pipeline, where generating N tokens runs 3N stage assignments and every assignment carries base64-encoded tensors. Sending the whole task on every revision would have meant re-sending every earlier tensor each time, so the bytes on the connection would have grown with the square of the number of tokens generated.

A task that asked for its answer in pieces adds one field, `newText`, on each revision that produced text. It is the text produced since the previous revision and never the answer so far, for the same reason: an update that carried the answer so far would send the whole answer once per token. A consumer joins these in revision order to show an answer as it is written. The result that ends the task carries the whole answer, so a consumer that wants it as one piece of text ignores `newText` entirely, and a consumer that has been joining the pieces can check what it built against what the device that generated it produced.

Anyone reading the whole task can see an answer part-way through without having followed every revision from the start. A task snapshot carries `generatedText`: everything the answer has produced so far. That field is filled only for a task that asked for pieces, so a task that did not ask stores nothing extra. The pieces are joined as they arrive, and the result that finishes the answer replaces that joining with the whole answer it carries, so the field is exact once the task is finished and an account of the answer before then.

Reaching it after a dropped connection needs an observer grant made before the drop. A consumer that reconnects is issued a new device identifier, and only the device that submitted a task or one granted observation of it may read that task, so a reconnected consumer is a stranger to its own task. That is a limitation of the protocol, not of this field, and it is why a consumer that wants to survive its own disconnection has to arrange to observe its task while it still can.

A client that needs more than a revision announcement asks for it:

- `task.get` and `task.resync` return `task.snapshot`, the full current state of the task, including the task input and the completed stage values.
- `task.history` returns the complete change log.

**The snapshot is authoritative.** The completed stages and the current assignment in `task.snapshot` are the state of the task. The change log returned by `task.history`, and the `recentEvents` tail carried inside a snapshot, are a diagnostic record of how the task reached that state; they are never the source of truth, and a client must not reconstruct task state from them.

The per-attempt assignment history is not part of the protocol at all. The gateway keeps it in memory to make retry decisions, but it never travels over the connection, because every attempt carries a full stage input value and the list only ever grows.

### Device membership

Device membership is opt-in. A connection receives `devices`, `device.joined`, `device.updated`, `device.activity`, and `device.left` only after asking for them with `devices.subscribe`, or by connecting as an observer, which implies the subscription. Workers and consumers never ask, so a cluster with no dashboard and no observer attached exchanges no device membership messages at all.

A device record is split by how often its fields change:

- The fields that describe the device itself are `deviceId`, `name`, `deviceRole`, `stageNames`, `connectedAt`, `authIdentity`, and `maxConcurrentAssignments`. A change to any of them is announced immediately, as `device.updated`.
- The fields that change as work is assigned are `lastSeenAt`, `workerState`, `ready`, and `activeAssignments`. A change to any of them is announced as `device.activity`, which carries only those fields, so a worker's assignment counter moving from 0 to 1 does not re-transmit the device's name and stage list.

`device.activity` messages are batched. Activity changes are collected over a short window, 250 milliseconds by default and set by the gateway's `--device-activity-coalesce-ms` option, and sent as one combined message. Batching matters because a worker's assignment counter moves twice per stage, once when the stage is assigned and once when the result arrives.

A change that moves nothing but `lastSeenAt` is never announced, and never spends a device-list revision. A liveness timestamp that nobody displays to the millisecond does not justify a message. This applies to the refresh that happens on every message a device sends.

### Pipelines, stages, and computations

A pipeline is a validated record listing the stages a task runs, in order. The gateway loads the built-in pipelines and any further pipelines given by its `--pipeline-file` option, and a task selects one when it is submitted. The stage sequence is therefore data the task carries, not a sequence built into the gateway.

Three separate things are involved, and keeping them apart is what allows a pipeline to be added without releasing the gateway, the worker, and the consumer together:

- The **stage name** identifies one step of one pipeline, such as `stage_dev_formula_multiply`. The shared protocol package checks only the shape of a stage name — lower-case letters, digits, and underscores, starting with a letter, up to 100 characters. It does not list which stage names exist. The pipeline registry in the gateway is the authority on that.
- The **computation** identifies the code that carries the step out, such as `dev_formula_multiply` or `llm_qwen3_0_6b_shard`. Every stage names one, and every `stage.assign` carries it, so a worker never has to recognise a stage name to know what to run. A new pipeline can give a new stage name a computation that workers already ship.
- The **task type** still decides which pipelines a task may select, and remains a closed list, five values today, checked by `TaskInput` in [`packages/protocol/src/task/task_types.ts`](../packages/protocol/src/task/task_types.ts). Adding one is a change to the shared protocol package. Between them the five accept three kinds of value: a finite number, a prompt, and a prompt or a whole history.

A worker asks for `pipelines.get` before it registers, and advertises every stage whose computation it implements. A worker that advertises a stage no loaded pipeline defines is refused at registration with the error code `VALIDATION`, whose details list both the stage names it asked for and the stage names that exist, so a mistyped name is reported rather than silently never receiving work.

`stage.assign` also carries `stageIndex`, the stage's position in its pipeline counted from zero. A computation with ordered parts uses it to know which part it is running: the language-model shards are told which shard to run this way rather than by reading a number out of the stage name.

A pipeline that states `repeatsUntilDone` starts again at its first stage once its last stage finishes, and ends only when a stage result reports `done: true`. The language-model pipeline works this way — its three shards run once per generated token — so its looping is a property the specification states rather than behaviour written into the gateway.

### Generation settings

A consumer states what it wants about how its answer is generated, as opposed to what the answer is about, in an optional `generationSettings` field on the task input it submits. A submission that states nothing carries no `generationSettings` field at all, which is the same as asking for the answer in one result, generated the way that task type has always generated it.

It holds seven settings:

- `isStreaming` says whether the consumer wants the answer in pieces as it is produced rather than in one result once it is finished.
- `temperature`, from `0` to `2`, says how much the model may prefer a less likely next token.
- `topP`, from just above `0` to `1`, says what share of the probability mass the next token is drawn from. This is the sampling method the OpenAI Chat Completions interface spells `top_p`.
- `maximumOutputTokenCount` is the largest number of tokens the whole answer may be generated as, counted across every run of the task, not the per-run ceiling each worker sets for itself.
- `stopSequences` names up to four pieces of text that end the answer as soon as the model writes one of them. A stop sequence is applied where the tokens are produced, never by a consumer dropping pieces of the answer as it forwards them, because a stop sequence can straddle two pieces.
- `randomSeed` decides every random choice made while the answer is generated, so that the same task submitted twice with the same seed is answered the same way twice by the same worker.
- `reasoningEffort`, one of `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`, says how much of its output budget a model that thinks before it answers may spend on thinking. The six levels are the ones LM Studio 0.4.20 names itself when it refuses a seventh. A model that never thought is unaffected by any level.

Three counts of those settings are used below, and they are nested rather than in disagreement. There are **seven settings** in all. Six of them are **generation controls**: `isStreaming` is set aside, because it says how the answer is delivered rather than how it is generated. Five of those are **sampling controls**: `reasoningEffort` is set aside as well, because it budgets a model's thinking rather than steering the choice of the next token.

Each of the six generation controls is carried exactly as the consumer asked for it and is never translated for the engine that will run the task. Which task type honours which control is written down once, in [`packages/protocol/src/task/generation_control_support.ts`](../packages/protocol/src/task/generation_control_support.ts), and what is written there is what a de-risk gate observed live rather than what an engine documents. `task_type_llm_qwen3_0_6b_sharded` honours all five of the sampling controls, because its sampler is written by hand over the logits; `task_type_llm_llama3_2_1b_full` honours `temperature`, `maximumOutputTokenCount`, and `stopSequences`, its `@huggingface/transformers` engine acting on neither `topP` nor a seed; `task_type_llm_qwen3_5_0_8b_full` honours those three and `reasoningEffort` besides, being the only task type whose model thinks before it answers on both of its workers; `task_type_llm_gemma_nano_chrome_full` honours none, being the one engine the gate could not reach. See [issue #180](https://github.com/webai-at-home/webai-at-home/issues/180), [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196), and [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192).

The settings travel with the task input rather than beside it, so the gateway stores them once when the task is created and reads them off the stored task every time it places a stage. Every path that places a stage therefore sends the same settings without any of them having to pass the settings along: the first assignment, each round of a pipeline that repeats, a retry after a lease expires, and a task placed after waiting in the queue.

They reach the worker as their own field of `stage.assign`, never inside the stage input value. The stage input value is what a stage consumes and returns — it is a plain number for the formula pipeline — and the gateway stores it again with every completed stage and every assignment attempt, so putting settings there would both make workers echo them back and store them once per stage.

The gateway does not read the settings. Which of them a stage honours is decided by the code that runs the stage, because a setting means different things to a stage that drives a browser's built-in model and to a stage that runs one shard of a model this project ships. A setting this protocol version does not define is refused at submission rather than dropped, because a dropped setting would change the answer a consumer receives without telling it anything went wrong.

That refusal only reaches as far as the settings block itself. A gateway built before the block existed has no such field to check, and drops it silently along with everything else it does not recognise on a task input. What catches that is the protocol version: the block itself arrived with version 2, the five sampling controls with version 6, which is the first version in which a stage acts on a setting other than `isStreaming`, and `reasoningEffort` with version 9. A gateway that predates a version refuses a connection that states it, rather than accepting a request it would answer differently from the way it was asked.

### The assignment lease

Every `stage.assign` carries a `leaseUntil` time. If that time passes and the assignment is still not finished, the gateway takes the stage away from the worker and assigns it again. The worker's eventual result is then refused with the error code `STALE_ASSIGNMENT`, and the work it did is thrown away.

A worker that is still running its stage keeps the assignment by sending `stage.heartbeat`, carrying the task identifier, the assignment identifier, and the attempt number. The gateway answers with `stage.lease.extended` and a later `leaseUntil`. A worker sends a heartbeat three times per lease, so one lost or late message does not cost the assignment. Both the worker browser page and the Node.js worker follow that rule. A lease extension deliberately does not raise the task's revision, because nothing a consumer or an observer displays has changed; a heartbeat therefore produces no `task.updated` message to anyone.

The gateway refuses to extend the lease of an assignment that is no longer current, and answers the heartbeat with `stage.cancel` instead. A worker whose assignment was taken away therefore stops work and drops the state it holds, rather than finishing work nobody wants.

Two properties of a stage control leasing, both stated in the pipeline specification:

- `leaseMs` is how long that stage's lease lasts. A stage that states no lease uses the gateway's `--lease-ms` option, which defaults to 15,000 milliseconds. A multiplication and a language-model shard no longer have to share one duration.
- `prefersSameWorkerOnRetry` says that the stage should go back to the worker that already holds the state that stage keeps in memory, rather than deliberately avoiding that worker. Set it for a stage that keeps state between assignments. The three language-model shards set it, because each shard of one task must stay on the device that ran that same shard, for that device to retain the shard's key-value cache. The three shards do not have to be on one device: each shard is pinned to its own device, and three devices advertising one shard each run the pipeline. Retrying such a stage on a different device throws that cache away at exactly the moment the model is slow, so the retry is more likely to be slow again than the attempt it replaced.

A stage that keeps no state is still retried away from the worker that missed its lease. Both kinds of retry remain bounded by the gateway's `--max-attempts` option.

`prefersSameWorkerOnRetry` also decides where a stage goes when nothing has gone wrong. To place such a stage the gateway needs to know which worker holds the state for the stage that is about to run, which is not the same as which worker ran last: in a pipeline that repeats, the state for the upcoming stage is held by the worker that ran that same stage in the previous round. The gateway therefore records on each task which worker most recently completed each of its stages, and consults that record when it hands out the stage that follows a finished one and when it takes a task out of the `queued` state. None of this reaches a worker, which sees only its own `stage.assign` messages.

### What a worker sees

A worker never receives `task.updated`, and a worker holding a stage assignment may not read the whole task through `task.get` or `task.resync`. A worker's entire view of a task is what `stage.assign` carries: the task identifier, the assignment identity, the stage name, the computation to run, the stage's position in its pipeline, the stage input value, the generation settings the consumer asked for, and the lease expiry. A worker therefore never sees the original task input, the identity of the consumer that submitted the task, or the results of stages assigned to other workers. When an assignment stops being current — the task was cancelled, the lease expired, the worker relinquished the assignment, or the worker disconnected and the stage was reassigned — the gateway sends that worker the narrow `stage.cancel` message instead.

The task states are `queued`, `assigned`, `running`, `completed`, `failed`, and
`cancelled`, declared by `TaskState` in
[`packages/protocol/src/task/task_types.ts`](../packages/protocol/src/task/task_types.ts).
The gateway sets every one of them: `running` when a worker accepts the
assignment it was given, and `cancelled` when a task is cancelled.

## Stage payloads and flows

### Formula flow

The formula task sequence is:

```text
consumer --task.submit--> gateway
gateway --stage.assign(stage_dev_formula_multiply)--> worker A
worker A --stage.result(number)--> gateway
gateway --stage.assign(stage_dev_formula_add)--> worker B
worker B --stage.result(number)--> gateway
gateway --task.updated(completed)--> consumer
```

The current formula stages multiply the input by `2` and then add `7`.

### Sharded language-model flow

The sharded language-model task sequence cycles through three shards:

```text
stage_llm_qwen3_0_6b_shard1of3 -> stage_llm_qwen3_0_6b_shard2of3 -> stage_llm_qwen3_0_6b_shard3of3
                               -> stage_llm_qwen3_0_6b_shard1of3 -> ...
```

The first assignment carries the prompt in `LlmStagePayload.text`. Intermediate
assignments carry encoded boundary tensors, token identifiers, and the token
position. The final shard returns generated text and sets `done: true` when
generation is complete. When `done` is false, the final shard returns the next
token and the gateway starts another cycle at `stage_llm_qwen3_0_6b_shard1of3`.

An encoded tensor contains `dims`, `type`, and base64-encoded data. The current
JSON tensor encoding is a probe format and is not a final compatibility
contract.

### Chrome built-in language-model flow

The task that uses the language model built into the browser has one stage:

```text
stage_llm_gemma_nano_chrome_full
```

The assignment carries the prompt in `LlmStagePayload.text`. The browser delivers
its answer in pieces, and how many stage runs those pieces are read in is decided
by the `isStreaming` generation setting the consumer submitted.

A task that asked for nothing has every piece read by one run, which answers with
the complete answer in `text` and `done: true`. The pipeline sets
`repeatsUntilDone`, and it is that `done: true` which ends the task on the first
run. One answer therefore costs one `stage.assign` and one `stage.result`,
however long it is.

A task that asked for its answer in pieces has one piece read per run. Each such
result carries that one piece in `newText` and sets `isContinuation: true`, and
the generation stays open in the tab that is reading it. The gateway assigns the
stage again, sending back a payload that carries `isContinuation: true` and no
prompt, and the run that receives it carries on the answer its predecessor left.
The last run answers with the whole answer in `text` and `done: true`, carrying
no piece, because every piece has already been reported.

`isContinuation` is what tells the two kinds of run apart. The stage is a single
stage that runs again and again, so a run that starts an answer and a run that
carries one on arrive under the same stage name and differ in nothing else. A
worker asked to carry on an answer it is not holding fails the stage, rather than
starting a second answer to a prompt it was not sent.

The answer lives in the memory of the tab producing it, so a run that carries an
answer on has to reach the tab that holds it. That is the same requirement the
sharded pipeline has for its key-value cache, and it is met the same way: the
stage sets `prefersSameWorkerOnRetry`, and the gateway records which device ran
each stage. The gateway does not place a payload carrying `isContinuation: true`
on any other device: rather than send it somewhere it can only fail, the gateway
puts the task back in the `queued` state and waits for the device holding the
answer, which the submission deadline bounds. A run that does reach a tab holding
no answer fails the stage, and a failed stage fails the task at once — the
`--max-attempts` bound applies to a lease running out or a worker disconnecting,
not to a failure a worker reports.

A run that reads a whole answer lasts as long as that answer takes; a run that
reads one piece returns as soon as it has it. The worker sends `stage.heartbeat`
throughout either, which moves the assignment lease along ahead of it, and a
`stage.cancel` stops the browser generating — including one that arrives while
the browser is still creating the model session, which is the slowest part of
starting an answer.

A worker holds each answer against the `taskId`, because that is what an answer
belongs to and because every run of it arrives under a new `stageAssignmentId`. The
answer records which assignment is currently reading it, and only that one may
release it, because one tab can hold two runs of the same task at once: a lease
that expires while a run is under way has the gateway assign the stage again,
and this stage asks for that retry to come back to the same tab. The gateway
sends no `stage.cancel` when it assigns the stage again to the same tab, since
telling that tab to let go of the answer a moment before asking it to carry on
from that same answer would destroy it. A run that is replaced while it waits for
a piece hands what it read to the run that replaced it, so no piece is lost.

An answer left open between runs is given up if no run comes back for it within
five minutes. A task can end without the tab ever being told — the gateway only
cancels an assignment, and between two runs there is none — and without this the
browser would generate an answer nobody will read for as long as the page stays
open. Losing the connection to the gateway gives up every open answer at once,
for the same reason: no run can arrive over a connection that is gone.

### The other complete-model flows

Two further stages carry an answer the same way, in the same message shapes and
under the same rules as the flow above, and neither needs a separate account
here: `stage_llm_qwen3_5_0_8b_full`, which runs a model the worker browser tab
downloads and holds itself, and `stage_llm_llama3_2_1b_full`, which either does
the same or forwards the prompt to a language-model server running on the
worker's own device, depending on which of the two kinds of worker this project
can run it — a worker browser tab, or a native worker from
[`packages/worker_openai`](../packages/worker_openai) — the gateway assigned it
to.

What differs between the three is only what holds the answer while it is being
read. It is a browser-managed model session for the flow above, a loaded model in
the tab's own memory for Qwen3.5-0.8B, and, for Llama 3.2 1B Instruct, a loaded
model in the tab's own memory when a worker browser tab runs it or an open
request to a local server when a native worker runs it instead. Each of these
lives in the memory of the one worker producing it, which is why every one of
these stages sets `prefersSameWorkerOnRetry`, and each is ended by a
`stage.cancel`, by a failed stage, by the five-minute idle timeout, and by the
connection to the gateway closing.

`task_type_llm_llama3_2_3b_full` was a fourth such flow, forwarding the prompt
to a local server the same way `stage_llm_llama3_2_1b_full` now can, until
[issue #154](https://github.com/webai-at-home/webai-at-home/issues/154) retired
it.

## Validation and errors

The shared protocol package validates task input at the gateway boundary. The
gateway rejects malformed task input with `error`. The gateway also rejects:

- stage results or stage failures from a client that is not a registered worker;
- a stage result that is not the task's expected next stage;
- a `task.get` request for an unknown task.

The worker reports computation errors with `stage.failed`. The gateway marks the
task as `failed` and broadcasts the failure. A disconnected worker is removed
from the registry, and its unfinished assignment is retried on another worker.

## Related implementation

- Shared message types: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts)
- Gateway routing and scheduling: [`packages/gateway/src/cli.ts`](../packages/gateway/src/cli.ts)
- Task state and stage sequencing: [`packages/gateway/src/task/task_store.ts`](../packages/gateway/src/task/task_store.ts)
- Worker registration and stage execution, in a browser tab: [`packages/worker_webpage/web/src/main.ts`](../packages/worker_webpage/web/src/main.ts)
- Worker registration and stage execution, in a command line process: [`packages/worker_openai/src/libs/gateway_worker_client.ts`](../packages/worker_openai/src/libs/gateway_worker_client.ts)
- Consumer registration and task submission: [`packages/consumer_cli/src/gateway_connection/consumer_client.ts`](../packages/consumer_cli/src/gateway_connection/consumer_client.ts)

## Open protocol decisions

The following decisions should be made before treating this document as a
stable public protocol:

- the compatibility rules for a future protocol version, now that every frame states the version it was written for;
- authentication and authorization for consumers, workers, and observers, replacing the single shared development token described above, which identifies every client as the same authenticated identity;
- task ownership and which consumers may receive `task.updated`;
- whether the completed stage values in `task.snapshot` should also be bounded, since they still grow with the number of stages a language-model task runs;
- acknowledgement, timeout, retry, and reassignment rules;
- validation schemas for every message and for stage payloads;
- size limits and a production encoding for tensors;
- whether signalling is still required when direct browser connections are
  introduced;
- privacy and retention rules for prompts, results, and logs.
