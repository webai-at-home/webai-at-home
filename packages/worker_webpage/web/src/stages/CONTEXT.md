# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this browser page can run, the fixed list of every stage it can offer, and the readers of generated text a stage helper needs, for tool calls and for stop sequences.

## Key Exports & Entry Points

- `stage_catalog.ts`: the fixed list of every stage this page can offer to run.
- `stage_helper_dev_formula.ts`: the development formula stages, exercising the pipeline with no model.
- `stage_helper_llm_qwen3_0_6b_sharded.ts`: one Qwen3-0.6B shard, its sampler written by hand over the logits.
- `stage_helper_llm_qwen3_5_0_8b_full.ts`, `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_gemma_4_e2b_full.ts`, `stage_helper_llm_gemma_nano_chrome_full.ts`: three complete models and one browser engine.
- `tool_call_reader.ts`: reading the tool calls Qwen3.5 writes out of its generated text.
- `stop_sequence_watcher.ts`: stopping an answer at a consumer's stop sequence without forwarding it.
- `model_download_progress.ts`: the steps a stage helper reports while a model downloads.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named as [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md) says, registered in `stage_catalog.ts`.
- The Transformers.js stage helpers report an exact `promptTokenCount`, `completionTokenCount`, and `stopReason`; `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`, having no token count.
- `WorkerStageOffer.offeredStages` in `../connection/` keeps each whole-model stage in its own list, so a tab downloads only the model it actually offers.
- A stage helper acts only on the controls its task type's entry in `generation_control_support.ts` names, and that entry holds only what a gate observed live.
- A stop sequence goes through `StopSequenceWatcher`, never one chunk at a time: it can straddle two, and a forwarded chunk cannot be recalled.
- A stage helper samples only for an answer asking for a temperature or a `topP`, so a consumer asking for nothing still gets greedy decoding.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` reads `reasoningEffort` as `enable_thinking`: `none` off, any level above it on, nothing asked for does not think ([#192](https://github.com/webai-at-home/webai-at-home/issues/192)).
- `stage_helper_llm_gemma_4_e2b_full.ts` asks for `webgpu` unconditionally and refuses without it. WebAssembly would be too slow to be worth offering ([issue #211](https://github.com/webai-at-home/webai-at-home/issues/211)).
- This folder imports from no other folder of this package.

## Background

- Token counts and stop reasons come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [#154](https://github.com/webai-at-home/webai-at-home/issues/154).
- The control rules come from [#196](https://github.com/webai-at-home/webai-at-home/issues/196), whose gate found Transformers.js acts on neither `top_p` nor a seed.
