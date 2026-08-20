# Directory Context: `/packages/worker_webpage/web/src/stages/structured_output`

## Purpose

Making a model write the shape a consumer asked for: turning the `responseFormat` carried on a task into the `logits_processor` and `stopping_criteria` a `@huggingface/transformers` generation call already takes.

## Key Exports & Entry Points

- `response_constraint_builder.ts`: `ResponseConstraintBuilder.warmup` and `.build`, the only two calls a stage helper makes.
- `sampled_token_forwarder.ts`: `SampledTokenForwarder`, which makes the `onTokensSampled` calls the installed runtime does not.

## Rules

- Every constraint is built here and never in a stage helper, so the two decisions below are made once for every stage that ever honours a shape.
- A `json_schema` is handed to `@huggingface/transformers-response-constraint` with all three of its `x-guidance` options added to the root, overwriting whatever the consumer sent: `whitespace_flexible: false`, `key_separator: ': '`, and `item_separator: ', '`. Without the first, greedy decoding has a fixed point wherever JSON allows whitespace and the answer never arrives; without the other two, the model is denied the space it wanted and writes a worse answer instead.
- A `json_object` is handed over as it stands, and never rewritten as the `json_schema` of `{"type":"object"}` to reach that control. Reaching it costs the answer itself.
- The forwarder stands aside the moment `LogitsProcessorList` carries `onTokensSampled`, because a grammar told about the same token twice consumes it twice.
- This folder imports from no other folder of this package.

## Background

- Both rules above are what live runs measured, against Gemma 4 E2B on WebGPU, in milestones 0 and 3 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221): five of seven schemas ran to the token limit writing whitespace with `whitespace_flexible` left at its default; the same one-string schema answered `{"city": ", "}` with only the whitespace closed and `{"city": "Paris"}` with the separators beside it; and asked for any object at all, the model wrote a whole nested object under `json_object` against `{"weather":{}}` under `{"type":"object"}` with the whitespace closed. Milestone 0's raw answers are in [`packages/_onnx_experiments/public/gemma4-e2b-response-constraint-measurement`](../../../../../_onnx_experiments/public/gemma4-e2b-response-constraint-measurement/).
- This folder is milestone 3 of the same issue. The package it wraps is checked in at [`packages/transformers_response_constraint`](../../../../../transformers_response_constraint/), for the reasons milestone 1 records there.
