# Directory Context: `/packages/protocol/src/stage`

## Purpose

The value one pipeline stage consumes and returns, how that value is first built, and how much of an answer may be reported while it is still being written.

## Key Exports & Entry Points

- `stage_payload_types.ts`: `StagePayload`, `LlmStagePayload`, and `EncodedTensor` — the value one pipeline stage consumes and returns.
- `stage_payload_factory.ts`: `StagePayloadFactory`, which builds the value a pipeline stage starts from.
- `generated_text.ts`: `GeneratedText`, which decides how much of an answer may be reported as it is written.

## Rules

- One payload type serves every stage of a pipeline, because the output of one stage is the input of the next and a separate type per stage would break that chain.
- `LlmStagePayload.promptTokenCount`, `.completionTokenCount`, and `.stopReason` are reported only by a worker whose engine really gives them, and are never estimated.
- `stopReason` is the worker's own word, not an OpenAI value. Translating it belongs to whichever consumer speaks the OpenAI Chat Completions interface.
- A tensor crossing the connection is an `EncodedTensor`, never a raw typed array, because a stage may run in a browser tab and a browser tab and a Node.js process do not share memory.

## Background

- The token count and stop reason fields come from milestone 2 of [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
