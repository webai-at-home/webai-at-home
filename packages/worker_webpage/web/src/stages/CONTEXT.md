# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this browser page can run, the fixed list of every stage it can offer, and the two readers of generated text a stage helper needs: for tool calls and for stop sequences.

## Key Exports & Entry Points

- `stage_catalog.ts`: `StageCatalog`, the fixed list of every stage this page can offer to run.
- `stage_helper_dev_formula.ts`: the development formula stages, for testing the pipeline without a model.
- `stage_helper_llm_qwen3_0_6b_sharded.ts`: one Qwen3-0.6B shard stage, its sampler written by hand over the logits.
- `stage_helper_llm_qwen3_5_0_8b_full.ts`, `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_gemma_nano_chrome_full.ts`: one complete model and one browser engine each.
- `tool_call_reader.ts`: `ToolCallReader`, reading the tool calls Qwen3.5 writes out of its generated text.
- `stop_sequence_watcher.ts`: `StopSequenceWatcher`, stopping an answer at a consumer's stop sequence without forwarding it.
- `model_download_progress.ts`: `ModelDownloadProgress`, the steps those three report while a model downloads.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named for the stage in [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md), registered in `stage_catalog.ts`.
- The two Transformers.js stage helpers report an exact `promptTokenCount`, `completionTokenCount`, and `stopReason`; `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`, having no token count.
- `WorkerStageOffer.offeredStages` in `../connection/` keeps each whole-model stage's names in its own list, so `WorkerPage.prepareOfferedStages` downloads only the model a tab actually offers.
- A stage helper acts only on the generation controls its task type's entry in `generation_control_support.ts` names, and that entry holds only what a gate observed live.
- A stop sequence is applied through `StopSequenceWatcher`, never one chunk at a time: it can straddle two chunks, and a forwarded chunk cannot be recalled.
- A stage helper samples only for an answer asking for a temperature above zero or a `topP`, so greedy decoding stays what a consumer asking for nothing receives.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` reads `reasoningEffort` as `enable_thinking`: `none` turns thinking off, every level above it turns thinking on, and an answer asking for nothing does not think ([issue #192](https://github.com/webai-at-home/webai-at-home/issues/192)).
- This folder imports from no other folder of this package.

## Background

- Token counts and stop reasons come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
- The generation control rules come from [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196), whose gate found Transformers.js acts on neither `top_p` nor a seed.
