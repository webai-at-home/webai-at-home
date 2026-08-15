# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this browser page can run, the fixed list of every stage it can offer, and the two readers of generated text a stage helper needs: for tool calls, and for stop sequences.

## Key Exports & Entry Points

- `stage_catalog.ts`: `StageCatalog`, the fixed list of every stage this worker webpage can offer to run.
- `stage_helper_dev_formula.ts`: runs the development formula stages, for testing the pipeline without a model.
- `stage_helper_llm_qwen3_0_6b_sharded.ts`: runs one Qwen3-0.6B shard stage.
- `stage_helper_llm_qwen3_5_0_8b_full.ts`, `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_gemma_nano_chrome_full.ts`: run a complete model, one browser engine each.
- `tool_call_reader.ts`: `ToolCallReader`, which reads the tool calls Qwen3.5 writes out of its generated text.
- `stop_sequence_watcher.ts`: `StopSequenceWatcher`, which stops an answer at a consumer's stop sequence without forwarding the stop sequence.
- `model_download_progress.ts`: `ModelDownloadProgress`, the progress steps the three stage helpers above report while their model downloads and loads.

## Rules

- Adding a stage means adding one `stage_helper_<stage name>.ts` file whose name is the stage name from [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md), and registering it in `stage_catalog.ts`.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` and `stage_helper_llm_llama3_2_1b_full.ts` report an exact `promptTokenCount`, `completionTokenCount`, and `stopReason`, confirmed live by their own de-risk gate. `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`, this engine having no token count to report.
- `WorkerStageOffer.offeredStages` in `../connection/` keeps each whole-model stage's names in its own list, so `WorkerPage.prepareOfferedStages` in `main.ts` downloads only the model a tab actually offers.
- A stage helper acts only on the generation controls its task type's entry in `@webai/protocol`'s `generation_control_support.ts` names, and that entry names only what a de-risk gate observed live.
- A stop sequence is applied through `StopSequenceWatcher`, never one chunk at a time: a stop sequence can straddle two chunks, and a chunk once forwarded cannot be taken back.
- A stage helper samples only for an answer that asked for a temperature, so greedy decoding stays what a consumer asking for nothing receives.
- This folder imports from no other folder of this package.

## Background

- The token count and stop reason gates come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
- The generation control rules come from [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196), whose gate found `@huggingface/transformers` acts on neither `top_p` nor a seed.
