# Directory Context: `/`

## Purpose

The root of an npm workspaces monorepo exploring whether idle web browsers can work together to run a language model too large for any one volunteer device. A gateway holds a queue of tasks, splits each into a pipeline of stages, and gives every stage to a connected browser tab.

## Key Exports & Entry Points

- `package.json`: the npm workspaces root. `npm run build` builds `@webai/protocol` first, then the packages depending on it; `npm test` type checks this folder's own tests, runs the documentation link test, and then runs every workspace's tests, each of which type checks itself first.
- [`packages/protocol`](packages/protocol/): the shared definitions every other package depends on.
- [`packages/gateway`](packages/gateway/): the coordinator gateway.
- [`packages/worker_webpage`](packages/worker_webpage/), [`packages/worker_openai`](packages/worker_openai/): the two workers.
- [`packages/consumer_cli`](packages/consumer_cli/), [`packages/consumer_openai`](packages/consumer_openai/): the two ways to submit a task.
- [`packages/webai_at_home_cli`](packages/webai_at_home_cli/): the published `webai-at-home` program.
- [`packages/_openai_api_tool_TOREMOVE`](packages/_openai_api_tool_TOREMOVE/), [`packages/docker_server`](packages/docker_server/), [`packages/flow_viewer`](packages/flow_viewer/), and the `packages/_*` experiments, among them [`packages/_codex_experiments`](packages/_codex_experiments/), which runs the Codex command-line program against a small local model.

## Rules

- Every task, task type, pipeline, stage, and computation name follows [`docs/naming_scheme.md`](docs/naming_scheme.md), the one authoritative place for those names.
- Never abbreviate a name, anywhere.
- A message shape crossing a process boundary belongs in [`packages/protocol`](packages/protocol/), validated with Zod there, and is never restated in the gateway, a consumer, or a worker.
- A package folder name is `snake_case`, with a leading underscore for an experiment; its npm package name is `@webai/` plus the same words in `kebab-case`.
- A file added under [`docs/`](docs/) is linked from [`README.md`](README.md) or another documentation file, which is how a reader and the documentation link test find it.
- A package that runs tests type checks before it runs them, with a `test` script reading `npm run typecheck && …`, and its `tsconfig.json` includes its own `tests/` folder.

## Background

- The agent instructions for this repository are in [`AGENTS.md`](AGENTS.md). Read that file as well as this one.
- The type check in front of every `test` script comes from [issue #220](https://github.com/webai-at-home/webai-at-home/issues/220), where three type errors sat unseen in `@webai/consumer-openai` because `npx tsx --test` strips types rather than checking them.
