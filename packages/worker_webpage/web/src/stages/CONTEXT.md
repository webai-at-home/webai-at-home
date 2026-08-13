# Directory Context: `/packages/worker_webpage/web/src/stages`

## Purpose

One stage helper per stage this browser page can run, the fixed list of every stage it can offer, and reading the tool calls a model writes out as generated text rather than as a structured field.

## Key Exports & Entry Points

- `stage_catalog.ts`: `StageCatalog`, the fixed list of every stage this worker webpage can offer to run.
- `stage_helper_dev_formula.ts`: runs the development formula stages, for testing the pipeline without a model.
- `stage_helper_llm_qwen3_0_6b_sharded.ts`: runs one Qwen3-0.6B shard stage.
- `stage_helper_llm_qwen3_5_0_8b_full.ts`, `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_gemma_nano_chrome_full.ts`: run a complete model, one browser engine each.
- `tool_call_reader.ts`: `ToolCallReader`, which reads the tool calls Qwen3.5 writes out of its generated text.

## Rules

- Adding a stage means adding one `stage_helper_<stage name>.ts` file whose name is the stage name from [`docs/naming_scheme.md`](../../../../../docs/naming_scheme.md), and registering it in `stage_catalog.ts`.
- `stage_helper_llm_qwen3_5_0_8b_full.ts` and `stage_helper_llm_llama3_2_1b_full.ts` report an exact `promptTokenCount`, `completionTokenCount`, and `stopReason`, confirmed live by their own milestone 0 de-risk gate. `stage_helper_llm_gemma_nano_chrome_full.ts` reports only `stopReason`, because this engine has no prompt or completion token count to report at all.
- `WorkerStageOffer.offeredStages` in `../connection/` keeps each whole-model stage's names in its own list, so `WorkerPage.prepareOfferedStages` in `main.ts` downloads only the model a tab actually offers.
- This folder imports from no other folder of this package.

## Background

- The token count and stop reason gates come from [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150) and [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
