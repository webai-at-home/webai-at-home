# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this page can run, the list of stages it can offer, and the readers of generated text a stage helper needs.

## Key Exports & Entry Points

- `stage_catalog.ts`: the stages this page can offer.
- `tool_call_reader.ts`, `gemma_4_e2b_tool_call_reader.ts`: the tool calls Qwen3.5 and Gemma 4 E2B write.
- `chat_template_tools.ts`, `gemma_4_e2b_history_messages.ts`: a history's tools and messages, as a chat template reads them.
- `stop_sequence_watcher.ts`, `thought_channel_cut.ts`: a stop sequence kept without being forwarded, and a model's own thinking cut out of an answer.
- `model_download_progress.ts`: the steps reported while a model downloads.
- `structured_output/`: making a model write the shape a consumer asked for.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named as [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md) says, registered in `stage_catalog.ts`.
- The Transformers.js stage helpers report an exact `promptTokenCount`, `completionTokenCount`, and `stopReason`; `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`.
- A stage helper acts only on the controls its task type's entry in `generation_control_support.ts` names, and that entry holds only what a live run observed.
- A stop sequence goes through `StopSequenceWatcher`, never one chunk at a time: it can straddle two, and a forwarded chunk cannot be recalled.
- A stage helper samples only for an answer asking for a temperature or a `topP`, so a consumer asking for nothing still gets greedy decoding.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` and `stage_helper_llm_gemma_4_e2b_full.ts` read `reasoningEffort` as `enable_thinking`: `none` off, any level above it on, nothing asked for does not think. An answer that thought is reported whole, with its thinking cut out ([#192](https://github.com/webai-at-home/webai-at-home/issues/192), [#223](https://github.com/webai-at-home/webai-at-home/issues/223)).
- `stage_helper_llm_gemma_4_e2b_full.ts` asks for `webgpu` unconditionally and refuses without it: WebAssembly is too slow to be worth offering ([#211](https://github.com/webai-at-home/webai-at-home/issues/211)).
- Each tool call reader reads one format; Gemma 4 E2B's markers are special tokens, so its stage decodes with `skip_special_tokens: false` ([#216](https://github.com/webai-at-home/webai-at-home/issues/216)).
- This folder imports from no other folder of this package.

## Background

- Token counts and stop reasons come from [#150](https://github.com/webai-at-home/webai-at-home/issues/150) and [#154](https://github.com/webai-at-home/webai-at-home/issues/154).
- The control rules come from [#196](https://github.com/webai-at-home/webai-at-home/issues/196), which found Transformers.js acts on neither `top_p` nor a seed.
- Qwen3.5's tool call format was measured in [#115](https://github.com/webai-at-home/webai-at-home/issues/115).
