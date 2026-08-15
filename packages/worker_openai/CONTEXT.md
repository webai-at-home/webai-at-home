# Directory Context: `/packages/worker_openai`

## Purpose

A worker that runs a model by forwarding its assigned stage to a locally running server speaking the OpenAI-compatible Chat Completions API, such as LM Studio. Unlike `@webai/worker-webpage`, it is a Node.js command line process rather than a browser tab: it never downloads or runs a model itself.

## Key Exports & Entry Points

- `src/cli.ts`: the command line program. Command to run this folder: `npm run dev --workspace @webai/worker-openai`, or `npm run sample:lmstudio --workspace @webai/worker-openai` against LM Studio.
- `src/libs/`: the connection to the central gateway, the connection supervisor, the calls to the local server, the stage offer, and the lease heartbeat.
- `src/stages/`: one `stage_helper_<stage name>.ts` file per stage this worker runs.

## Rules

- Which local server runs the model is a command line option, never part of a stage or task type name. The stage is named `full` because the model is held complete on one device, following [`docs/naming_scheme.md`](../../docs/naming_scheme.md).
- Message shapes come from `@webai/protocol` and are never restated here.
- The worker side of the protocol is implemented twice, here and in [`packages/worker_webpage`](../worker_webpage), because one runs in Node.js and the other in a browser tab. Keep the two in step when the protocol changes.
- `GatewayWorkerClient` speaks the protocol over exactly one connection, so anything outliving one connection belongs in `GatewayConnectionSupervisor`, which builds a new socket and a new client per attempt.
- A stage reports the exact token counts and stop reason the local server sends, and leaves a `finish_reason` it does not recognise untranslated rather than guessing.
- A task type's contract cannot depend on which of its possible workers is assigned a task, so `task_type_llm_llama3_2_1b_full` is registered in `controlsByTaskType` as honouring the three a worker browser tab was proved to honour — `temperature`, `maximumOutputTokenCount`, and `stopSequences` — and not the `topP` and `randomSeed` only this worker could forward.

## Background

- Token counts and stop reasons come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150); generation control forwarding from [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151); the connection lifetime rule from [issue #158](https://github.com/webai-at-home/webai-at-home/issues/158).
