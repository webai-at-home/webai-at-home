# Docker image: Gateway and the worker page

A Linux Docker image that runs [`packages/gateway`](../gateway) and the built browser page from [`packages/worker_webpage`](../worker_webpage), served as static files so a worker browser tab can be opened straight from the container.

`packages/worker_webpage` is a browser page, not a server, so it cannot itself run inside the container as a worker. A completion request only returns an answer once at least one browser tab, running on some machine outside the container, has that page open and is connected to the gateway.

## The OpenAI-compatible server is not in this image

The OpenAI-compatible server from [`packages/consumer_openai`](../consumer_openai) used to run in this container and no longer does, because one deployment of that server is one account: the account charged for a task is the server's own, read from the `default.account_key.json` file in its `--config_dir`, and nothing in an OpenAI-compatible HTTP request carries an account identifier. Running it in a publicly reachable container therefore debits every caller's consumption to the account of whoever operates the container, and Version 1 of the accounting system has no balance floor to stop that — see [`docs/accounting_system.md`](../../docs/accounting_system.md) and [issue #139](https://github.com/webai-at-home/webai-at-home/issues/139).

Run `consumer_openai` yourself instead, with your own configuration directory holding your own account key pair, pointing it at this container's gateway:

```bash
npm run start --workspace @webai/consumer-openai -- \
  --gateway-url ws://localhost:8787 \
  --auth-token <GATEWAY_AUTH_TOKEN> \
  --config_dir <path to a directory holding your own default.account_key.json>
```

It then serves OpenAI-compatible requests on `http://localhost:8788/v1` as before, and the stages its tasks run are recorded against your account rather than the container operator's. [`packages/consumer_openai/README.md`](../consumer_openai/README.md) describes every option, and [`packages/consumer_cli`](../consumer_cli/README.md)'s `account_key` command generates the key pair that is the account.

## Ports

| Port | Service |
| --- | --- |
| `8787` | Gateway HTTP and WebSocket server ([`packages/gateway`](../gateway)) |
| `8789` | The built worker browser page ([`packages/worker_webpage`](../worker_webpage)), served as static files |

`8789` was added after the port the underlying issue names, `8787`, so the worker browser page a real end-to-end test needs is reachable from this same image, without running a separate `npm run dev --workspace @webai/worker-webpage` on the host.

## Layout

- [`package.json`](package.json) — the npm scripts below.
- [`docker/`](docker) — the container image definition: the [`Dockerfile`](docker/Dockerfile), its matching [`Dockerfile.dockerignore`](docker/Dockerfile.dockerignore), the [`docker-entrypoint.sh`](docker/docker-entrypoint.sh) it runs, and [`docker-compose.yml`](docker/docker-compose.yml).
- [`src/`](src) — code the image runs that is not one of the existing packages: [`static_server.mjs`](src/static_server.mjs), the worker page's static file server.

## npm scripts

[`package.json`](package.json) wraps the `docker` and `docker compose` commands used throughout this document, each already pointed at [`docker/docker-compose.yml`](docker/docker-compose.yml) and at the repository root as the Compose project directory, so none of these need the `-f` or `--project-directory` paths spelled out. Run them from this directory, or from anywhere in the repository with `--workspace @webai/docker-server`:

| Script | Runs | Does |
| --- | --- | --- |
| `npm run build` | `docker compose -f docker/docker-compose.yml --project-directory ../.. build` | Builds the image (see [Build](#build)) |
| `npm run start` | `docker compose -f docker/docker-compose.yml --project-directory ../.. up -d` | Starts the container in the background (see [Start](#start)) |
| `npm run stop` | `docker compose -f docker/docker-compose.yml --project-directory ../.. down` | Stops and removes the container (see [Shutdown](#shutdown)) |
| `npm run restart` | `docker compose -f docker/docker-compose.yml --project-directory ../.. restart` | Restarts the running container without rebuilding it |
| `npm run logs` | `docker compose -f docker/docker-compose.yml --project-directory ../.. logs -f` | Follows both programs' startup and error output (see [Logs](#logs)) |
| `npm test` | prints a pointer to this file | There is nothing to automate here; this only exists so the repository's root `npm test` (which runs every workspace's `test` script) does not fail on this package |

`npm run start` reads its environment variables and port mapping from [`docker/docker-compose.yml`](docker/docker-compose.yml) rather than from a command line, so edit that file (or override with `docker compose run -e ...`) to change them — see [Configuration](#configuration).

## Build

Build from the repository root, because the image needs the whole npm workspace (the root `package.json`, the root lockfile is not used — see the note in the [`Dockerfile`](docker/Dockerfile) — and every package's source):

```bash
docker build -f packages/docker_server/docker/Dockerfile -t webai-at-home .
```

Or with Compose:

```bash
docker compose -f packages/docker_server/docker/docker-compose.yml --project-directory . build
```

Or with the npm scripts below (already resolve the paths above): `npm run build --workspace @webai/docker-server`.

## Start

```bash
docker run -d --name webai-at-home \
  -p 8787:8787 -p 8789:8789 \
  -e GATEWAY_AUTH_TOKEN=change-me \
  -v webai-at-home-data:/data \
  webai-at-home
```

Or:

```bash
docker compose -f packages/docker_server/docker/docker-compose.yml --project-directory . up -d
```

Or with the npm scripts: `npm run start --workspace @webai/docker-server`.

The `/data` volume holds the gateway's durable task state file (`gateway-state.json` by default), its account profile file (`gateway-accounts.json` by default), and its accounting ledger file (`gateway-ledger.jsonl` by default), so queued and in-flight tasks, registered accounts, and every accounting entry survive a container restart.

## Configuration

Neither the gateway nor `consumer_openai` reads environment variables directly — both read command line options only. [`docker-entrypoint.sh`](docker/docker-entrypoint.sh) converts the environment variables below into the matching command line options when it starts each program. `consumer_openai` is not started here at all, and is mentioned because a run of it outside this container is configured the same way, by command line options rather than by any of the variables below.

| Variable | Default | Passed as |
| --- | --- | --- |
| `GATEWAY_PORT` | `8787` | the gateway's `--port` |
| `GATEWAY_AUTH_TOKEN` | `development-token` | the gateway's `--auth-token` — the bearer token every connection (workers, the home page, a `consumer_openai` run outside this container) must present |
| `GATEWAY_STATE_FILE` | `/data/gateway-state.json` | the gateway's `--state-file` |
| `GATEWAY_ACCOUNT_FILE` | `/data/gateway-accounts.json` | the gateway's `--account-file` |
| `GATEWAY_LEDGER_FILE` | `/data/gateway-ledger.jsonl` | the gateway's `--ledger-file` |
| `WORKER_PORT` | `8789` | the port the built worker page is served on |

[`docs/environment_variables.md`](../../docs/environment_variables.md) lists these variables alongside the ones `worker_openai` and `consumer_cli` read on a host machine, and says which programs read no environment variables at all.

**Set `GATEWAY_AUTH_TOKEN` to a real value in anything but local testing.** The default `development-token` is the same default the gateway, `consumer_openai`, and the worker browser page all fall back to on their own, so leaving it unset only works because every part agrees on the same well-known placeholder.

## Send an OpenAI-compatible request

Start `consumer_openai` yourself first, as shown in [The OpenAI-compatible server is not in this image](#the-openai-compatible-server-is-not-in-this-image), then:

```bash
curl http://localhost:8788/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "dev_formula", "messages": [{"role": "user", "content": "5"}]}'
```

`dev_formula` is the cluster's development formula task: it multiplies the submitted number by two in one stage and adds seven in the next, so `5` comes back as `17`. It needs no downloaded model and no graphics processor, so it is the quickest way to prove the whole path end to end. This only returns an answer once the two worker browser tabs below are connected — otherwise the request waits for `--connection-wait-ms` (5 seconds by default) and then reports that no worker is available, which is an expected answer in a cluster of volunteer browsers, not a fault.

## Open the gateway and connect a worker

- The gateway's home page: `http://localhost:8787/home`
- The worker browser page, built from `packages/worker_webpage` and served from this same container: `http://localhost:8789/?gatewayUrl=http://localhost:8787&authToken=<GATEWAY_AUTH_TOKEN>`

`dev_formula` uses two pipeline stages, so open the worker page in two separate browser tabs (on the host machine, or any machine that can reach the published ports) before sending a request.

## Check the container is up

```bash
curl http://localhost:8787/health
```

This is the gateway's own health endpoint, and it answers as soon as the gateway is accepting connections; it does not depend on a worker browser tab being connected.

## Logs

```bash
docker logs -f webai-at-home
```

or `npm run logs --workspace @webai/docker-server`, shows both programs' own startup and error output. The gateway also writes its own message log under `packages/gateway/logs` inside the container; read it with:

```bash
docker exec webai-at-home ls packages/gateway/logs
docker exec webai-at-home cat packages/gateway/logs/<file>
```

## Shutdown

```bash
docker stop webai-at-home
```

Or with the npm scripts: `npm run stop --workspace @webai/docker-server`.

The entrypoint script forwards `SIGTERM` to the gateway and the worker page's static file server, and the gateway already closes its own connections and servers on `SIGTERM` (see `Cli.shutdown` in [`packages/gateway/src/cli.ts`](../gateway/src/cli.ts)).

## Deploying this image to the public server

The public deployment runs this image on a virtual private server, managed by Coolify, and Coolify rebuilds it from a branch of this repository named `production`. Pushing to `main` deploys nothing. Deploying is one command, run when you decide the tip of `main` should go live:

```bash
git push origin main:production
```

Coolify receives the push through its GitHub webhook, rebuilds the image, and restarts the container.

Deployment is a deliberate step, and not something every push does, because restarting the container disconnects every worker browser tab connected to the gateway, and a worker browser tab does not connect again on its own — see [issue #149](https://github.com/webai-at-home/webai-at-home/issues/149) for the problem and [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158) for the automatic reconnection that would make a deployment cheap. The gateway's own durable state survives the restart, because the task state file, the account profile file, and the accounting ledger file all live on the `/data` volume described in [Start](#start).
