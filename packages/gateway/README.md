# `@webai/gateway`

Central HTTP and WebSocket gateway for the WebAI distributed pipeline.

The gateway authenticates and registers consumer and worker browser
connections, assigns pipeline stages, tracks task progress, persists task state
when configured, and relays signalling messages. Its home page observes
gateway activity without registering as a device. Built-in pipelines support
the development formula, Qwen3-0.6B sharded inference, Chrome's Gemma Nano
model, and complete Qwen3.5-0.8B and Llama 3.2 1B Instruct inference, each
held on one worker.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/gateway
```

The default port is `8787` and the default bearer token is
`development-token`. Use `--port` or `-p` to choose another port:

```sh
npm run dev --workspace @webai/gateway -- --port 9000
```

Other command-line options control assignment leases, queued-task deadlines,
retry attempts, durable state, authentication, per-principal task limits,
session lifetime, additional pipeline definitions, device activity
coalescing, and the accounting system. See
`npm run dev --workspace @webai/gateway -- --help` for the current option list.

## Accounting

The gateway owns the accounting database, which records contributed and consumed computation: one credit for every stage a worker completes, less one for every stage a consumer has run. [`docs/accounting_system.md`](../../docs/accounting_system.md) describes the whole system, and three options configure it.

| Option | Default | What it sets |
| --- | --- | --- |
| `--account-file <path>` | `~/.webai-at-home/gateway/gateway-accounts.json` | Where account profiles are kept. Profiles only: no balance and no history. |
| `--ledger-file <path>` | `~/.webai-at-home/gateway/gateway-ledger.jsonl` | The append-only ledger, one JSON object per line, appended to and never rewritten. |
| `--account-challenge-ms <number>` | `60000` | How long a challenge handed out for an account to sign stays usable. |

Both files are written at run time and are excluded from version control. The gateway opens the ledger before it accepts a single connection, reads it once to rebuild every balance, and reports how many accounts it holds:

```
Accounting ledger at /Users/someone/.webai-at-home/gateway/gateway-ledger.jsonl, holding 2 account(s)
Gateway listening on http://localhost:8787
```

A ledger line the gateway cannot read stops it, naming the line, rather than being skipped: a ledger that drops what it cannot parse reports a balance wrong by however much it dropped. A ledger with no file to write to is refused outright, because balances that vanish when the gateway restarts are worse than a gateway that will not start.

## Pages and endpoints

Each HTML page and its assets are stored in its own directory under `web/`. Browser TypeScript files use `src/main.ts`, and stylesheets use `css/main.css`.

- `/` or `/home` — gateway landing page. **About** in its navigation bar opens a panel naming which build of the gateway this server is running: the version number of `@webai/gateway`, read from its own `package.json` at build time rather than written into the markup by hand, and a link to `/health`, whose JSON body carries the git commit this build was made from. See [issue #159](https://github.com/webai-at-home/webai-at-home/issues/159).
- `/monitor` — live gateway monitor showing connected devices, tasks, stages, and recent events.
- `/ledger` — what every account has earned and spent, highest balance first. It is the one cluster-wide accounting view: every other accounting message answers for the asking connection's own account and no other, so this page connects as an observer, which is the only connection the gateway answers `accounting.summaries.get` for.
- `/debug` — index of the current gateway debug pages.
- `/debug_iframe` — page that displays the gateway home page and the standalone worker page in frames.
- `/debug_iframe_dev_formula` — formula-specific debug page with separate multiply and add worker frames.
- `/debug_iframe_llm_qwen3_0_6b_sharded` — language-model debug page with one worker frame for each shard.
- `/debug_iframe_llm_gemma_nano_chrome_full` — Gemma Nano debug page with one worker frame.
- `/debug_iframe_llm_qwen3_5_0_8b_full` — Qwen3.5-0.8B full-model debug page with one worker frame.
- `/debug_iframe_llm_llama3_2_1b_full` — Llama 3.2 1B Instruct full-model debug page with one worker frame.
- `/health` — JSON health response with the current worker count.
- `/diagnostics` — authenticated `POST` endpoint used by worker browsers to send diagnostic entries.

The WebSocket server uses the same port as the HTTP server. Every connection
must authenticate with the configured bearer token before it can register or
submit work. A connection may then prove which account it is, by signing a
value the gateway hands it, so the stages it completes or has run are recorded
against that account rather than against the shared development account. A worker browser page is served by
[`@webai/worker-webpage`](../worker_webpage); the gateway does not provide the
worker page itself.

Every open WebSocket connection is pinged every `--heartbeat-interval-ms`
(default `10000`), and a connection that has answered nothing for
`--heartbeat-timeout-ms` (default two times the interval, so `20000`) is
closed. This keeps an idle connection — a worker with no assignment, a
consumer waiting on a task, a dashboard page that is only watching — alive
through a reverse proxy placed in front of the gateway, since a reverse proxy
commonly closes a WebSocket connection that carries no traffic for as little
as sixty seconds.

The ping is also how the gateway notices a connection that is gone without
having said so, which is why the interval is ten seconds rather than the
thirty it used to be: worst case detection fell from about sixty seconds to
about twenty. See
[issue #176](https://github.com/webai-at-home/webai-at-home/issues/176).

The two settings are separate because they answer two separate questions. How
often a connection is pinged has to be short enough for the shortest idle
timeout any reverse proxy in front of this gateway uses. How long a silent
connection is tolerated is how quickly a worker that is gone without having
said so is noticed. A single number used to do both jobs, so neither could be
changed without changing the other.

| Option | Default |
| --- | --- |
| `--heartbeat-interval-ms <number>` | `10000` |
| `--heartbeat-timeout-ms <number>` | two times `--heartbeat-interval-ms` |

## The address a connection came from

The gateway records the address each device connected from, reading it once from the HTTP request that carried the WebSocket upgrade. A device never sends that address, so a worker cannot choose what is recorded for it. The address is part of the device record the gateway publishes, which is how `consumer_cli status` shows one address per worker. See [issue #183](https://github.com/webai-at-home/webai-at-home/issues/183).

A gateway reached directly, whether on `localhost` during development or through a port forwarding rule on a server, sees the address of the device itself, because a port forwarding rule rewrites the destination of a packet and never its source. An address such as `::ffff:127.0.0.1` is recorded in its plain `127.0.0.1` form, so one machine is not recorded two different ways depending on how the connection was made.

A gateway behind a reverse proxy sees the proxy on every connection instead, and the address of the device is then only in the `x-forwarded-for` header. That header is read solely when the gateway is started with `--trust-reverse-proxy`, because any client can write it, and a gateway that believed it unconditionally would let a worker name its own address.

| Option | Default |
| --- | --- |
| `--trust-reverse-proxy` | off, so the address of the connection itself is the one recorded |

## Build and test

```sh
npm run build --workspace @webai/gateway
npm run test --workspace @webai/gateway
```

For a production build, run `npm run build --workspace @webai/gateway` and
then `npm run start --workspace @webai/gateway`.

## Where the gateway keeps what it writes

Everything this gateway writes goes under `~/.webai-at-home/gateway/` by default: `gateway-state.json`, `gateway-accounts.json`, `gateway-ledger.jsonl`, and a `logs` folder holding this gateway's own message log for each run plus one relayed log per connected worker.

All four used to default to whatever directory the gateway was started from, which meant `npx webai-at-home gateway` left four files and a folder wherever the person happened to be standing. The account key pair of every other program in this repository has been kept under the home directory since [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170); this is the gateway's share of that same decision, made in [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171).

| Option | Default |
| --- | --- |
| `--state-file <path>` | `~/.webai-at-home/gateway/gateway-state.json` |
| `--account-file <path>` | `~/.webai-at-home/gateway/gateway-accounts.json` |
| `--ledger-file <path>` | `~/.webai-at-home/gateway/gateway-ledger.jsonl` |
| `--log-dir <path>` | `~/.webai-at-home/gateway/logs` |

[`packages/docker_server`](../docker_server/README.md) passes the first three explicitly, at `/data`, so a container keeps its own paths and is unaffected by these defaults.

A gateway that has been run by hand before this change has its old files sitting in the directory it was started from. On startup it says so, and names them, whenever such a file exists and the file it is now reading does not:

```
Note: gateway-ledger.jsonl exists in /home/someone/work, and is not being read. This gateway now
keeps its files under /home/someone/.webai-at-home/gateway instead of the directory it was started
from. Move the old files there, or name them with --state-file, --account-file and --ledger-file,
to go on using them.
```
