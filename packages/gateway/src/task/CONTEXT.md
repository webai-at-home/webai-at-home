# Directory Context: `/packages/gateway/src/task`

## Purpose

The queue of tasks, the placement of pipeline stages onto connected workers, and the handling of every validated message a connected client sends.

## Key Exports & Entry Points

- `task_store.ts`: `TaskStore`, which holds every task and its stage assignments, and keeps them on disk.
- `task_scheduler.ts`: `TaskScheduler`, which places task stages on workers, retries them, and reports task progress.
- `stage_policy_resolver.ts`: `StagePolicyResolver`, which decides the lease and the retry placement for one stage.
- `pipeline_registry.ts`: `PipelineRegistry` and `builtinPipelineSpecifications`, the pipeline definitions a task may be run against.
- `client_message_handler.ts`: `ClientMessageHandler`, which acts on each validated message a connected client sends.
- `session_registry.ts`: `SessionRegistry`, holding one `Session` per connection.

## Rules

- `builtinPipelineSpecifications` in `pipeline_registry.ts` is the one place declaring a pipeline identifier and its stage names, each following [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md), to which a new pipeline is added too.
- Message and task shapes come from `@webai/protocol` and are never restated here.
- `TaskStore` is the only writer of task state to disk; every other file in this folder reads a task through it rather than keeping a copy of its own.

## Background

- Nothing here needs a longer reason than the rule itself gives.
