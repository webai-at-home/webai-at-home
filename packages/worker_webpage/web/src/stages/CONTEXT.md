# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this page can run, and what the stage helpers share.

## Key Exports & Entry Points

- `stage_catalog.ts`: the stages this page can offer.
- `tool_call_reader.ts`, `gemma_4_e2b_tool_call_reader.ts`: the tool calls each model writes.
- `chat_template_tools.ts`, `gemma_4_e2b_history_messages.ts`: a history as a chat template reads it.
- `stop_sequence_watcher.ts`, `thought_channel_cut.ts`, `thinking_block_cut.ts`, `empty_answer_refusal.ts`: a stop sequence held back, thinking cut out, an answer that never began refused.
- `model_download_progress.ts`: the steps a model download reports.
- `structured_output/`: making a model write the shape asked for.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named as [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md) says, registered in `stage_catalog.ts`.
- The Transformers.js stage helpers report exact token counts and a real `stopReason`; `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`, always `end_of_sequence`.
- An answer holding no text fails the stage when that reason is `max_new_tokens`, and stands when it is anything else. `EmptyAnswerRefusal` holds that rule, not four copies of it ([#225](https://github.com/webai-at-home/webai-at-home/issues/225)).
- A stage helper acts only on the controls its task type's entry in `generation_control_support.ts` names.
- A stop sequence and a model's thinking are held back by `StopSequenceWatcher` and `ThinkingBlockCut`: either can straddle two chunks, and a forwarded chunk cannot be recalled.
- A stage helper samples only for an answer asking for a temperature or a `topP`; anything else gets greedy decoding.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` and `stage_helper_llm_gemma_4_e2b_full.ts` read `reasoningEffort` as `enable_thinking`: `none` off, anything above it on, nothing asked for off. Each cuts its own model's thinking out of its answer, on Gemma 4 E2B's channel tokens and on Qwen3.5-0.8B's `</think>` marker ([#226](https://github.com/webai-at-home/webai-at-home/issues/226)).
- `stage_helper_llm_gemma_4_e2b_full.ts` asks for `webgpu` unconditionally and refuses without it: WebAssembly is too slow to be worth offering ([#211](https://github.com/webai-at-home/webai-at-home/issues/211)).
- Each tool call reader reads one format; Gemma 4 E2B's markers are special tokens, so its stage decodes with `skip_special_tokens: false` ([#216](https://github.com/webai-at-home/webai-at-home/issues/216)).
- This folder imports from no other folder of this package.

## Background

- Token counts and stop reasons: [#150](https://github.com/webai-at-home/webai-at-home/issues/150), [#154](https://github.com/webai-at-home/webai-at-home/issues/154). The controls: [#196](https://github.com/webai-at-home/webai-at-home/issues/196). Tool call formats: [#115](https://github.com/webai-at-home/webai-at-home/issues/115).
