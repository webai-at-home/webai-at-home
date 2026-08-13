# WebAI@Home

## Goal

`webai-at-home` explores whether idle web browsers can work together to run a large language model that is too large for any one volunteer device.

The project treats computing time as a form of contribution. A person should be able to open a web page on an old laptop, phone, or other device and leave the page running. The browser then contributes one part of a shared inference pipeline, without installing an application or downloading the entire model.

The aim is to make volunteer computing for large language models as simple as visiting a web page. Many small contributions should combine into a useful service for a cause or community, reusing hardware that would otherwise sit idle.

## Blog posts

A written introduction to the project, from the idea to the architecture to the interface to the open question about browser tab throttling. See [`docs/blog_posts`](docs/blog_posts/README.md) for the full list:

1. [Inference Without Permission](docs/blog_posts/post_1_inference_without_permission.blog_post.md) — why running a language model should not require anyone's approval, and the smallest demonstration that two browser tabs can cooperate on one task.
2. [Designing for Workers That Disappear](docs/blog_posts/post_2_designing_for_workers_that_disappear.blog_post.md) — the architecture that follows from assuming every worker can vanish at any moment: leases, retries, stage placement, and pipelines as data.
3. [Change One Line](docs/blog_posts/post_3_change_one_line.blog_post.md) — the OpenAI-compatible server, what it reconciles between an always-available interface and a cluster of volunteers, and the questions that are still open.
4. [The Tab Nobody Is Watching](docs/blog_posts/post_4_the_tab_nobody_is_watching.blog_post.md) — the throttling experiments in `packages/_idle_experiments`: a hidden tab generates 2.7 times slower with no mitigation, and a quiet, near-inaudible tone recovers full speed.

## How the idea works

- A coordinator keeps a queue of batch requests. The requests can take hours rather than needing an immediate answer.
- The coordinator divides a model into sequential groups of layers and gives each group to a connected browser tab.
- Each browser downloads and caches only its assigned model part.
- Intermediate results move from one browser to the next through direct browser connections when possible.
- The coordinator measures each device and sizes assignments according to the device's available memory and speed.
- If a volunteer device disconnects, the unfinished work can be assigned to another device.

This project focuses on pipeline parallelism: each device runs a different section of the model. This approach passes one result between sections and is better suited to slow and uneven home internet connections than approaches that require every device to synchronise after every model operation.

The first implementation uses ONNX Runtime Web, with Web Neural Network API or Web Graphics Processing Unit API acceleration where available and WebAssembly as a Central Processing Unit fallback.

## Why batch work

`webai-at-home` is not intended to provide live chat response times. A generous deadline makes volunteer computing practical:

- disconnected tabs can be replaced;
- the coordinator can keep each stage busy with a queue of work;
- slow devices and network connections can still be useful;
- volunteers can contribute when their devices are available.

## Current state

This repository contains early experiments and a minimal distributed pipeline. The current gateway prototype runs five task types: a development formula, the Qwen3-0.6B model split into three shards across three worker browser tabs, the Gemma Nano model built into Chrome running in one worker browser tab, the complete Qwen3.5-0.8B model downloaded from Hugging Face and run in one worker browser tab, and the complete Llama 3.2 1B Instruct model, downloaded from Hugging Face and run either the same way or by a native worker process that forwards the prompt to a local server already running the model. The ONNX experiments test running model work directly in browsers, including a small Iris classifier and larger model experiments.

The central research questions are still open, especially result verification, browser tab throttling, volunteer and coordinator trust, and reliable model partitioning across very different devices.

## Repository layout

- [`packages/webai_at_home_cli`](packages/webai_at_home_cli/CONTEXT.md) — the single command line program published to the npm registry as `webai-at-home`, dispatching to the gateway, the OpenAI-compatible server, the native worker, and the command-line client below.
- [`packages/gateway`](packages/gateway/README.md) — coordinator HTTP and WebSocket gateway, scheduling, and home and worker pages.
- [`packages/protocol`](packages/protocol/README.md) — shared message and task definitions with validation.
- [`packages/consumer_cli`](packages/consumer_cli/README.md) — command-line client for submitting test tasks.
- [`packages/consumer_openai`](packages/consumer_openai/README.md) — OpenAI-compatible server, so a program that already talks to OpenAI can use the cluster by changing its base address.
- [`packages/worker_openai`](packages/worker_openai/README.md) — native worker process that runs its assigned stage by calling a local server speaking the OpenAI-compatible API, such as LM Studio.
- [`packages/openai_api_tool`](packages/openai_api_tool/README.md) — command-line tool that exercises and measures any server speaking the OpenAI-compatible API, this project's own and another machine's alike.
- [`packages/flow_viewer`](packages/flow_viewer/README.md) — flow viewer for inspecting recorded message traffic.
- [`packages/_onnx_experiments`](packages/_onnx_experiments/README.md) — browser experiments for ONNX Runtime Web.
- [`packages/_account_key_experiments`](packages/_account_key_experiments/README.md) — browser experiments about the signing key pair a participant's account is, and whether a real browser tab can hold one it cannot leak.
- [`packages/_tiny_iris_classifier`](packages/_tiny_iris_classifier/README.md) — small end-to-end browser inference example.
- [`packages/docker_server`](packages/docker_server/README.md) — Linux Docker image that runs the gateway and serves the built worker browser page.
- [`packages/worker_webpage`](packages/worker_webpage/README.md) — browser page that connects workers to the gateway.

## Documentation

- [`docs/tasks_and_stages.md`](docs/tasks_and_stages.md) — every kind of task the cluster can run and every stage each one needs.
- [`docs/protocol_by_role.md`](docs/protocol_by_role.md) — the messages the gateway, the consumers, and the workers exchange.
- [`docs/naming_scheme.md`](docs/naming_scheme.md) — how every task, task type, pipeline, and stage name is built.
- [`docs/environment_variables.md`](docs/environment_variables.md) — which environment variables exist, which program reads each one, and which programs read command line options only.
- [`docs/accounting_system.md`](docs/accounting_system.md) — how contributed and consumed computation are recorded: what an account is, what a credit is, and what the ledger holds.

## Run without cloning this repository

`npx webai-at-home <command>` runs one participant of the cluster without installing anything first. `gateway`, `consumer_openai` and `worker_openai` each run the command line program of the same name; every other command — `submit`, `status`, `capacity`, and the account commands — runs `consumer_cli`.

```sh
npx webai-at-home gateway
npx webai-at-home worker_openai --base-url http://localhost:1234/v1 --model llama-3.2-1b-instruct
npx webai-at-home submit "What is the capital of France?" --task_type llm_llama3_2_1b_full
```

The worker above expects an OpenAI-compatible server, such as [LM Studio](https://lmstudio.ai), already serving a model on `http://localhost:1234/v1`. Run `npx webai-at-home <command> --help` for a command's own options — every option a command line program in this repository already has, `--port`, `--url`, `--config_dir`, and the rest, works the same way through `npx webai-at-home`.

## Run the prototype

```sh
npm install
npm run dev --workspace @webai/gateway
npm run dev --workspace @webai/consumer-cli -- submit 5
```

Start the worker browser page with `npm run dev --workspace @webai/worker-webpage`. Open the worker page in two browser tabs, then open `http://localhost:8787/home` in another browser tab. The development formula pipeline multiplies the input by `2` and then adds `7`, so input `5` produces `17`. The gateway uses the development bearer token `development-token` by default; pass the same token in the worker page's `authToken` query parameter when it is not using that default.

The root build and test scripts cover the protocol, gateway, command-line consumer, and OpenAI-compatible consumer. Package READMEs document the additional browser, Docker, flow viewer, and experiment commands.

## Long-term direction

The intended next step is a small proof of concept using two or three older devices, a small quantised model, browser inference, and browser-to-browser connections. Measurements from that proof of concept will show whether the pipeline remains useful under real device churn, memory limits, and network latency.

See [issue #1](https://github.com/webai-at-home/webai-at-home/issues/1) for the full project concept and its open questions.

## License

[MIT](LICENSE)
