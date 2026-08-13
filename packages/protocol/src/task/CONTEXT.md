# Directory Context: `/packages/protocol/src/task`

## Purpose

What a task is: the work a consumer submits, the pipeline of stages it runs through, the history it may carry in place of one prompt, and the state the gateway holds about it.

## Key Exports & Entry Points

- `task_types.ts`: `TaskState`, `TaskType`, `TaskInput`, `GenerationSettings`, `Task`, and the task snapshot, task update, stage assignment, and task event shapes.
- `pipeline_types.ts`: `StageName`, `PipelineStage`, `PipelineSpecification` — the stage sequence a task runs, as stated by a pipeline specification.
- `history_types.ts`: `HistoryInput`, `HistoryMessage`, `ToolDeclaration`, `ToolCall`.
- `task_projection.ts`: `TaskProjection`, which builds the two task shapes that travel over the connection.
- `generation_control_support.ts`: `GenerationControlSupport`, recording which task type honours which generation control.

## Rules

- `TaskType` and `StageName` follow [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md); adding a name here means adding its row there too.
- `generation_control_support.ts` is the one place recording which task type honours which generation control. A consumer reads it before submitting rather than keeping a list of its own.
- `GenerationSettings` carries each of the five generation controls exactly as the consumer asked for it, and never translated for the engine that will run the task.
- Nothing here imports from `../message/`: `../message/` imports task and pipeline shapes from here, never the other way, because a task shape must not depend on the message that happens to carry it.

## Background

- `GenerationSettings` and `generation_control_support.ts` come from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
- The tool declaration and tool call shapes in `history_types.ts` come from [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78).
