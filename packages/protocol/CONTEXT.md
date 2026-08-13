# Directory Context: `/packages/protocol`

## Purpose

The shared message, task, pipeline, account, and device definitions of `webai-at-home`, with Zod validation. Every shape crossing a process boundary is defined here once, so the gateway, the consumers, and the workers cannot disagree about it.

## Key Exports & Entry Points

- `src/index.ts`: the entry point imported as `@webai/protocol`. It re-exports and holds no definitions of its own, and five further subpaths exist: `/envelope`, `/message_logger`, `/task_projection`, `/session_renewal`, `/reconnect_backoff`.
- `src/task/`, `src/message/`, `src/accounting/`, `src/stage/`: one folder per subject.
- Command to build this folder: `npm run build --workspace @webai/protocol`.

## Rules

- This package depends on no other package of this repository, because every other depends on it and a dependency in the other direction would be a cycle.
- Every definition lives in the file of its own subject, and code here imports from that file directly, never through `src/index.ts`.
- A new definition is added to its subject file first, then re-exported from `src/index.ts` under the section separator of its domain.
- Every shape travelling over the wire is a Zod schema, and its TypeScript type is derived from the schema rather than written twice.
- `TaskType` and the stage names it accepts follow [`docs/naming_scheme.md`](../../docs/naming_scheme.md); adding a task type here means adding its row there too.
- `stopReason` on `LlmStagePayload` is the worker's own word, not an OpenAI value: translating it belongs to whichever consumer speaks the OpenAI Chat Completions interface.
- `session_renewal.ts` and `reconnect_backoff.ts` hold the two timing rules every long-lived client shares, so no two programs disagree about how hard they lean on one gateway.
- `generation_control_support.ts` is the one place recording which task type honours which generation control; a consumer reads it rather than keeping its own list.

## Background

- Token counts and stop reasons come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150), the timing rules from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158), `GenerationSettings` from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
