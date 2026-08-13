# Environment variables

This document is the one authoritative place that says which environment variables `webai-at-home` reads, which program reads each one, and how a variable relates to the command line option that configures the same thing. It exists because the same setting used to be called two different names in two different places, with neither place mentioning the other, which is [issue #138](https://github.com/webai-at-home/webai-at-home/issues/138).

The companion document [`naming_scheme.md`](./naming_scheme.md) covers a different kind of name: the task, task type, pipeline, and stage identifiers the gateway, the consumers, and the workers exchange in the protocol. An environment variable is not one of those, so the two documents do not overlap.

## Which programs read environment variables at all

This is the fact that makes the rest of the document readable, and it is the one most easily got wrong:

- `packages/worker_openai` and `packages/consumer_cli` read environment variables directly, as a fallback behind their own command line options.
- `packages/gateway` and `packages/consumer_openai` read **no** environment variables at all. They read command line options only. Setting a variable in the environment of either of these two programs does nothing.
- `packages/worker_webpage` runs in a browser tab, which has no environment at all. It reads query parameters of the page URL instead: `gatewayUrl`, `authToken`, `workerName`, `enabledStages`, and `stageNames`.

So a variable that appears to be ignored is usually being set for a program that never reads it. Pass a command line option to that program instead, or set the variable in the container environment described below, where [`docker-entrypoint.sh`](../packages/docker_server/docker/docker-entrypoint.sh) turns it into the matching command line option.

## The precedence rule

Every environment variable a program reads sits in the middle of the same three-step order, and none of them ever wins over an explicit command line option:

1. The command line option, when it is given.
2. The environment variable, when it is set to a non-empty value.
3. The built-in default.

## Reaching the central gateway

These two variables say which central gateway to connect to and how to authenticate with it. Both are read by the programs that connect to a gateway, and both carry the same name everywhere in the repository, so one pair of exported variables points every program on a machine at the same gateway:

| Variable | Read by | Command line option it stands behind | Default |
| --- | --- | --- | --- |
| `GATEWAY_WS_URL` | `packages/worker_openai`, `packages/consumer_cli` | `-u, --url` | `wss://webai-gateway.dash-menu.com/` |
| `GATEWAY_AUTH_TOKEN` | `packages/worker_openai`, `packages/consumer_cli` | `-a, --auth-token` | `development-token` |

`packages/consumer_openai` connects to a gateway too, but reads neither variable: it takes `-u, --gateway-url` and `-t, --auth-token` on the command line only.

`GATEWAY_AUTH_TOKEN` names one token seen from two sides. On a machine running a client, it is the token that client presents. In the container, it is the token the gateway requires. Those are the same value in any working deployment — the gateway requires exactly what the clients present — which is why one name serves both, and why the container variable and the client variable were deliberately merged rather than kept apart.

## Reaching the local server behind `packages/worker_openai`

These say which server speaking the OpenAI-compatible API `packages/worker_openai` forwards its assigned stage to — LM Studio on the same machine, or a hosted API elsewhere — and how to authenticate with it. Unlike the two gateway variables above, neither has a built-in default here: `packages/worker_openai` stops with an error rather than guess which server to reach when neither the command line option nor the environment variable is given.

| Variable | Read by | Command line option it stands behind | Default |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | `packages/worker_openai` | `-b, --openai-base-url` | none, required |
| `OPENAI_API_KEY` | `packages/worker_openai` | `-k, --openai-api-key` | none, meaning no `Authorization` header is sent at all, which is what a local server such as LM Studio expects |

`packages/openai_api_tool` reads the same two names for the same purpose, on its own subcommands, with defaults of its own — see the table below. Neither program's default carries over to the other: what one falls back to is not what the other falls back to, only the variable name is shared.

## The container environment

`packages/docker_server` runs the gateway and a static file server for the built worker page inside one container, and neither of those two reads environment variables of its own. [`docker-entrypoint.sh`](../packages/docker_server/docker/docker-entrypoint.sh) is the translator: it reads the container's environment and passes each value as a command line option.

| Variable | Passed as | Default |
| --- | --- | --- |
| `GATEWAY_PORT` | the gateway's `--port` | `8787` |
| `GATEWAY_AUTH_TOKEN` | the gateway's `--auth-token` | `development-token` |
| `GATEWAY_STATE_FILE` | the gateway's `--state-file` | `/data/gateway-state.json` |
| `GATEWAY_ACCOUNT_FILE` | the gateway's `--account-file` | `/data/gateway-accounts.json` |
| `GATEWAY_LEDGER_FILE` | the gateway's `--ledger-file` | `/data/gateway-ledger.jsonl` |
| `WORKER_PORT` | the port the built worker page is served on | `8789` |

`GATEWAY_WS_URL` is not in this table, and is not read by the container. It was, while `packages/consumer_openai` ran inside the container and needed to be told which gateway to use; `packages/consumer_openai` was removed from the image in [commit c26a9b1](https://github.com/webai-at-home/webai-at-home/commit/c26a9b1) for the reasons given in [issue #139](https://github.com/webai-at-home/webai-at-home/issues/139), and nothing in the container has needed the variable since.

Set `GATEWAY_AUTH_TOKEN` to a real value in anything but local testing. The default `development-token` is the same default the gateway, the clients, and the worker browser page all fall back to on their own, so leaving it unset only works because every part agrees on the same well-known placeholder.

## Variables of the examples and the tests

These configure example programs and tests rather than the cluster itself. None of them is about the central gateway.

| Variable | Read by | Meaning | Default |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | every example in `packages/openai_api_tool/examples` | Base URL of the OpenAI-compatible server the example sends its request to | `http://localhost:8788/v1` |
| `OPENAI_API_KEY` | the same examples, and every subcommand of `packages/openai_api_tool` | Key presented to that server | `no-key-required` |
| `WEBAI_LOCAL_MODEL_BASE_URL` | `packages/consumer_openai/tests/real_llm_llama3_2_1b_full_native_worker.test.ts` | Base URL of the local model server the test needs running | `http://localhost:1234/v1` |
| `WEBAI_LOCAL_MODEL` | the same test | Which model that server is asked for | `llama-3.2-1b-instruct` |
| `REAL_TEST_HEADED`, `REAL_TEST_DEVTOOLS`, `REAL_TEST_SLOW` | the `real_*` tests in `packages/consumer_openai/tests` | Whether to show the browser, open its developer tools, and slow each action down, when watching a test run | unset, meaning headless, no developer tools, full speed |

## The naming convention

Two prefixes, distinguished by what the variable is about rather than by which program reads it:

- `GATEWAY_` names something about the central gateway: which one to reach, what it requires, and how it is configured inside the container.
- `WEBAI_` names one of this project's other settings, which is why `WEBAI_LOCAL_MODEL_BASE_URL` and `WEBAI_LOCAL_MODEL` keep that prefix and the two gateway variables do not.

`OPENAI_API_KEY` and `OPENAI_BASE_URL` carry neither prefix on purpose: each is the conventional name of a setting belonging to another program, so an operator who already exports it for other tools does not have to export it again under a project-specific name. `OPENAI_BASE_URL` was renamed from `WEBAI_OPENAI_BASE_URL` for the same reason in [issue #163](https://github.com/webai-at-home/webai-at-home/issues/163).

Two names for the gateway's bearer token existed until [issue #138](https://github.com/webai-at-home/webai-at-home/issues/138): `WEBAI_AUTH_TOKEN`, read by the clients, and `GATEWAY_AUTH_TOKEN`, used by the container. They were merged under `GATEWAY_AUTH_TOKEN`, and nothing answers to `WEBAI_AUTH_TOKEN` any more. The gateway's WebSocket URL had the same split, between `WEBAI_GATEWAY_URL` and `GATEWAY_WS_URL`, and was merged under `GATEWAY_WS_URL` in [commit 19269e9](https://github.com/webai-at-home/webai-at-home/commit/19269e9). No compatibility aliases were kept in either case: there is no release of this project, so nothing outside this repository can be exporting the old names.
