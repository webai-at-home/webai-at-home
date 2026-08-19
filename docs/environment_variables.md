# Environment variables

This document is the one authoritative place that says which environment variables `webai-at-home` reads, which program reads each one, and how a variable relates to the command line option that configures the same thing. It exists because the same setting used to be called two different names in two different places, with neither place mentioning the other, which is [issue #138](https://github.com/webai-at-home/webai-at-home/issues/138).

The companion document [`naming_scheme.md`](./naming_scheme.md) covers a different kind of name: the task, task type, pipeline, and stage identifiers the gateway, the consumers, and the workers exchange in the protocol. An environment variable is not one of those, so the two documents do not overlap.

## Which programs read environment variables at all

This is the fact that makes the rest of the document readable, and it is the one most easily got wrong:

- `packages/worker_openai`, `packages/consumer_cli`, `packages/consumer_openai` and `packages/gateway` all read environment variables directly, as a fallback behind their own command line options. The last two did not until [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171): exporting the two gateway variables used to configure two of the four programs on a machine and silently do nothing to the other two.
- `packages/worker_webpage` runs in a browser tab, which has no environment at all. It reads query parameters of the page URL instead: `gatewayUrl`, `authToken`, `workerName`, `enabledStages`, and `stageNames`.

The container is still the place to set these for a deployment, where [`docker-entrypoint.sh`](../packages/docker_server/docker/docker-entrypoint.sh) turns each one into the matching command line option. It keeps doing that whether or not the program it starts also reads the variable itself, since an explicit option wins over the variable either way and the two carry the same value.

## The precedence rule

Every environment variable a program reads sits in the middle of the same three-step order, and none of them ever wins over an explicit command line option:

1. The command line option, when it is given.
2. The environment variable, when it is set to a non-empty value.
3. The built-in default.

## Reaching the central gateway

These two variables say which central gateway to connect to and how to authenticate with it. Both are read by the programs that connect to a gateway, and both carry the same name everywhere in the repository, so one pair of exported variables points every program on a machine at the same gateway:

| Variable | Read by | Command line option it stands behind | Default |
| --- | --- | --- | --- |
| `GATEWAY_WS_URL` | `packages/worker_openai`, `packages/consumer_cli`, `packages/consumer_openai` | `-u, --gateway-url` | `wss://webai-gateway.dash-menu.com/` |
| `GATEWAY_AUTH_TOKEN` | `packages/worker_openai`, `packages/consumer_cli`, `packages/consumer_openai`, `packages/gateway` | `-a, --auth-token` | `development-token` |

`packages/gateway` reads `GATEWAY_AUTH_TOKEN` but deliberately not `GATEWAY_WS_URL`. `GATEWAY_WS_URL` names which gateway to connect to, and this program is the gateway, so it has none to connect to. It is the one program in the table that reads one of the pair and not the other, and that is on purpose rather than an omission.

`GATEWAY_AUTH_TOKEN` names one token seen from two sides. On a machine running a client, it is the token that client presents. In the container, it is the token the gateway requires. Those are the same value in any working deployment — the gateway requires exactly what the clients present — which is why one name serves both, and why the container variable and the client variable were deliberately merged rather than kept apart.

## Reaching the local server behind `packages/worker_openai`

These say which server speaking the OpenAI-compatible API `packages/worker_openai` forwards its assigned stage to — LM Studio on the same machine, or a hosted API elsewhere — and how to authenticate with it.

| Variable | Read by | Command line option it stands behind | Default |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | `packages/worker_openai` | `-b, --openai-base-url` | `http://localhost:1234/v1`, LM Studio's own default address |
| `OPENAI_API_KEY` | `packages/worker_openai` | `-k, --openai-api-key` | none, meaning no `Authorization` header is sent at all, which is what a local server such as LM Studio expects |

`packages/_openai_api_tool_TOREMOVE` reads the same two names for the same purpose, on its own subcommands, with defaults of its own — see the table below. Neither program's default carries over to the other: what one falls back to is not what the other falls back to, only the variable name is shared.

## The container environment

`packages/docker_server` runs the gateway and a static file server for the built worker page inside one container. [`docker-entrypoint.sh`](../packages/docker_server/docker/docker-entrypoint.sh) is the translator: it reads the container's environment and passes each value as a command line option. The gateway now also reads `GATEWAY_AUTH_TOKEN` on its own, so that one variable reaches it whether or not the translator is in the way; every other variable in the table below reaches it only through the translator.

| Variable | Passed as | Default |
| --- | --- | --- |
| `GATEWAY_PORT` | the gateway's `--port` | `8787` |
| `GATEWAY_AUTH_TOKEN` | the gateway's `--auth-token` | `development-token` |
| `GATEWAY_STATE_FILE` | the gateway's `--state-file` | `/data/gateway-state.json` |
| `GATEWAY_ACCOUNT_FILE` | the gateway's `--account-file` | `/data/gateway-accounts.json` |
| `GATEWAY_LEDGER_FILE` | the gateway's `--ledger-file` | `/data/gateway-ledger.jsonl` |
| `GATEWAY_TRUST_REVERSE_PROXY` | the gateway's `--trust-reverse-proxy`, when it is set to `true` | `false` |
| `WORKER_PORT` | the port the built worker page is served on | `8789` |

Set `GATEWAY_TRUST_REVERSE_PROXY` to `true` in any deployment reached over TLS on a domain name, because a reverse proxy terminates that connection and the container then sees the proxy on every connection instead of the device. Every worker is recorded at one single address until this is set, and `consumer_cli status` shows that one address for all of them. See [issue #183](https://github.com/webai-at-home/webai-at-home/issues/183).

`GATEWAY_WS_URL` is not in this table, and is not read by the container. It was, while `packages/consumer_openai` ran inside the container and needed to be told which gateway to use; `packages/consumer_openai` was removed from the image in [commit c26a9b1](https://github.com/webai-at-home/webai-at-home/commit/c26a9b1) for the reasons given in [issue #139](https://github.com/webai-at-home/webai-at-home/issues/139), and nothing in the container has needed the variable since.

Set `GATEWAY_AUTH_TOKEN` to a real value in anything but local testing. The default `development-token` is the same default the gateway, the clients, and the worker browser page all fall back to on their own, so leaving it unset only works because every part agrees on the same well-known placeholder.

## Variables of the examples and the tests

These configure example programs and tests rather than the cluster itself. None of them is about the central gateway.

| Variable | Read by | Meaning | Default |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | every example in `packages/openai_test/examples` | Base URL of the OpenAI-compatible server the example sends its request to | `http://localhost:8788/v1` |
| `OPENAI_API_KEY` | the same examples, and every subcommand of `packages/_openai_api_tool_TOREMOVE` | Key presented to that server | `no-key-required` |
| `WEBAI_LOCAL_MODEL_BASE_URL` | `packages/consumer_openai/tests/real_llm_llama3_2_1b_full_native_worker.test.ts` | Base URL of the local model server the test needs running | `http://localhost:1234/v1` |
| `WEBAI_LOCAL_MODEL` | the same test | Which model that server is asked for | `llama-3.2-1b-instruct` |
| `REAL_TEST_HEADED`, `REAL_TEST_DEVTOOLS`, `REAL_TEST_SLOW` | the `real_*` tests in `packages/consumer_openai/tests` | Whether to show the browser, open its developer tools, and slow each action down, when watching a test run | unset, meaning headless, no developer tools, full speed |

## The naming convention

Two prefixes, distinguished by what the variable is about rather than by which program reads it:

- `GATEWAY_` names something about the central gateway: which one to reach, what it requires, and how it is configured inside the container.
- `WEBAI_` names one of this project's other settings, which is why `WEBAI_LOCAL_MODEL_BASE_URL` and `WEBAI_LOCAL_MODEL` keep that prefix and the two gateway variables do not.

`OPENAI_API_KEY` and `OPENAI_BASE_URL` carry neither prefix on purpose: each is the conventional name of a setting belonging to another program, so an operator who already exports it for other tools does not have to export it again under a project-specific name. `OPENAI_BASE_URL` was renamed from `WEBAI_OPENAI_BASE_URL` for the same reason in [issue #163](https://github.com/webai-at-home/webai-at-home/issues/163).

Two names for the gateway's bearer token existed until [issue #138](https://github.com/webai-at-home/webai-at-home/issues/138): `WEBAI_AUTH_TOKEN`, read by the clients, and `GATEWAY_AUTH_TOKEN`, used by the container. They were merged under `GATEWAY_AUTH_TOKEN`, and nothing answers to `WEBAI_AUTH_TOKEN` any more. The gateway's WebSocket URL had the same split, between `WEBAI_GATEWAY_URL` and `GATEWAY_WS_URL`, and was merged under `GATEWAY_WS_URL` in [commit 19269e9](https://github.com/webai-at-home/webai-at-home/commit/19269e9). No compatibility aliases were kept in either case: there is no release of this project, so nothing outside this repository can be exporting the old names.
