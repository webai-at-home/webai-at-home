# Directory Context: `/packages/protocol/src/task`

## Purpose

What a task is: the work a consumer submits, the stages it runs through, the history it may carry in place of one prompt, the shape its answer must take, and the state the gateway holds.

## Key Exports & Entry Points

- `task_types.ts`: `TaskState`, `TaskType`, `TaskInput`, `GenerationSettings`, `Task`, and the snapshot, update, assignment, and event shapes.
- `pipeline_types.ts`: `StageName`, `PipelineStage`, `PipelineSpecification` — the stages a task runs.
- `history_types.ts`: `HistoryInput`, `HistoryMessage`, `ToolDeclaration`, `ToolCall`.
- `task_projection.ts`: `TaskProjection`, building the two task shapes that travel over the connection.
- `generation_control_support.ts`: `GenerationControlSupport`, which task type honours which generation control.
- `structured_output_support.ts`: `StructuredOutputSupport`, which task type honours which response format, and `ResponseFormat`, one shape asked for.
- `json_schema_compiler.ts`, `json_schema_grammar.ts`: a schema becomes nodes, and an answer is read against them character by character.

## Rules

- `TaskType` and `StageName` follow [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md); a name added here gets a row there.
- `generation_control_support.ts` and `structured_output_support.ts` are the one place recording what a task type honours, read by a consumer before it submits rather than copied.
- An entry in either table is what a live run observed, and a row widens only once every worker of that task type has been measured keeping it ([#219](https://github.com/webai-at-home/webai-at-home/issues/219)).
- `GenerationSettings` carries each generation control exactly as asked for, never translated for the engine that runs it. `responseFormat` is refused against `structured_output_support.ts` instead.
- The schema reader lives here rather than in a worker, because the consumer refusing a schema, the worker browser tab masking against it, and the native worker checking the answer must agree what it means. Two copies drift, and the drift is an answer said to match a schema it breaks.
- `JsonSchemaCompiler` refuses every keyword it cannot enforce while the answer is written, rather than enforcing the part it understands.
- Nothing here imports from `../message/`: that folder imports task shapes from here and never the other way, so a task shape cannot depend on the message carrying it.

## Background

- `GenerationSettings` and `generation_control_support.ts` come from [#151](https://github.com/webai-at-home/webai-at-home/issues/151); `structured_output_support.ts` from [#191](https://github.com/webai-at-home/webai-at-home/issues/191); `responseFormat` from milestone 2 of [#219](https://github.com/webai-at-home/webai-at-home/issues/219), and the two schema files from its milestone 6.
- The tool declaration and tool call shapes in `history_types.ts` come from [#78](https://github.com/webai-at-home/webai-at-home/issues/78).
