# Directory Context: `/packages/consumer_openai/src/libs`

## Purpose

Runs one cluster task per request over one gateway connection, reads which models the cluster can currently run, and reads this server's own command line options and environment variables.

## Key Exports & Entry Points

- `cluster_task_runner.ts`: `ClusterTaskRunner`, which runs one cluster task per request over one gateway connection, on top of `ConsumerClient` from `@webai/consumer-cli`.
- `model_availability.ts`: `ModelAvailability`, which of the offered models the connected workers can currently run, on top of `ClusterCapacityReader` from `@webai/consumer-cli`.
- `server_settings.ts`: `ServerSettings`, this server's command line options, read once and typed.

## Rules

- `ClusterTaskRunner` is the only place that submits a task to the gateway; `../http/openai_routes.ts` calls it rather than reaching `ConsumerClient` directly.
- `ModelAvailability` estimates nothing of its own: whether a model can be run is what `consumer_cli capacity` answers, and the two must never disagree.
- Nothing here holds a copy of the cluster's device list; `ModelAvailability` takes one snapshot per call and closes the connection again.
- Every new command line option or environment variable is added to `server_settings.ts` and documented in [`docs/environment_variables.md`](../../../../docs/environment_variables.md).
- `usage` on the answer `ClusterTaskRunner.run` returns is present only when the worker reported both `promptTokenCount` and `completionTokenCount`; it is never estimated.

## Background

- The `usage` rule comes from milestone 2 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- `model_availability.ts` and the two rules about it come from [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
