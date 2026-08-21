# Gemma 4 E2B · generation controls measurement · issue #222 milestone 0

The de-risk test of [issue #222](https://github.com/webai-at-home/webai-at-home/issues/222), run before any implementation code is written.

When this page was written, `task_type_llm_gemma_4_e2b_full` honoured no generation control. Its row in [`packages/protocol/src/task/generation_control_support.ts`](../../../protocol/src/task/generation_control_support.ts) is `[]`, and it is empty on purpose: that table holds what a live run observed and nothing else, and nothing about this model has been measured. This page is that measurement, and only that measurement.

## The one assumption being tested

**This model, in a real browser tab on WebGPU, acts differently when a control is asked for — and does so through `pipeline('text-generation', …)` of `@huggingface/transformers` 4.2.0, which is what `stage_helper_llm_gemma_4_e2b_full.ts` drives.**

The rows beside the empty one are not evidence about this model. [Issue #196](https://github.com/webai-at-home/webai-at-home/issues/196) found that `@huggingface/transformers` ignores `top_p` — proved with `top_k: 0` beside it, which removed the library's own filter to the 50 highest scoring tokens and left the answers as unfiltered noise while `top_p: 0.01` narrowed nothing — and that the library has no seed to give. Both findings were made on Qwen3.5-0.8B and on Llama 3.2 1B. If they hold here, this measurement enters three controls and not five.

## How to run it

```bash
npm run dev --workspace @webai/onnx-experiments
```

Then open `/gemma4-e2b-generation-controls-measurement/` and press the button.

**In a real Chrome, not in an embedded browser pane.** The model is about 3111 megabytes and an embedded pane caps an origin near 2.9 gigabytes, so the download fails there before anything is measured. The page refuses to run on WebAssembly: a WebAssembly answer would look like a working measurement and would say nothing about the path a worker browser tab takes.

The model files are cached in IndexedDB under the same database name every other experiment in this package uses, so a browser that has already run the tool calls measurement or the response constraint measurement downloads nothing again.

## The phases

| Phase | Asks | What honouring looks like |
| --- | --- | --- |
| 1 | Is this really running on WebGPU? | An adapter with `shader-f16`, and no dropped execution provider warning. |
| 2 | Does the model act on `temperature`? | Three identical answers at `temperature: 0` against three different ones at `temperature: 1.6`. |
| 3 | Does the model act on `top_p`? | `top_p: 0.01` with `top_k: 0` beside it narrows the answers that `temperature: 1.6` alone spread out. |
| 4 | Does the model act on a maximum output token count? | An answer cut at 8 tokens, and a longer one at 32. |
| 5 | Can a stop sequence be kept? | The answer ends where the stop sequence began, and the stop sequence is never forwarded. |
| 6 | Is there any seed to give at all? | An option whose name mentions a seed, and two identical answers under the same seed at a high temperature. |
| 7 | Does `do_sample: true` alone change an answer that asked for no temperature? | Two greedy runs that match, and a sampled run that matches them too. |
| 8 | What did the measurement cost? | Read off the runs already made: tokens, wall time, and tokens per second. |

Phase 7 is not one of the five controls. It decides how milestone 1 is allowed to write the call: `stage_helper_llm_qwen3_5_0_8b_full.ts` turns sampling on only for a request that asked for a temperature, and the reason is that a request asking for nothing must generate byte for byte the answer it generates today.

Phase 5 measures `StopSequenceWatcher`, because the pipeline call takes no stop sequence option. `src/stop_sequence_watcher.ts` is a character for character copy of the one the qwen stage helper already runs; milestone 1 reuses the original rather than this copy.

## What the result is for

Milestone 3 of issue #222 enters into `generation_control_support.ts` what **both** kinds of worker keep. The native worker forwards all six controls already, proved live against LM Studio 0.4.20 in milestone 0 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), so the intersection is decided entirely by what this page finds.

A control this page finds unhonoured stays out of the row. Writing a sampler by hand to gain one is what `task_type_llm_qwen3_0_6b_sharded` did, and issue #222 does not propose it.

`reasoningEffort`, the sixth control, is out of scope here and is measured by [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223).

## Result

Run on 21 August 2026, in Google Chrome on an Apple `metal-3` adapter, on WebGPU, with no execution provider dropped. 22 generations, 364 tokens, 106.9 seconds. The whole raw record is in the milestone 0 comment of [issue #222](https://github.com/webai-at-home/webai-at-home/issues/222).

| Control | Acted on | What was seen |
| --- | --- | --- |
| `temperature` | yes | One distinct answer of three at `temperature: 0`, three distinct of three at `temperature: 1.6`. |
| `top_p` | no | Three distinct answers with no `top_p`, three with `top_p: 0.01`, three with `top_p: 0.01` and `top_k: 0`. A `top_p` of 0.01 that was read would have answered as greedily as `temperature: 0` did. |
| `maximumOutputTokenCount` | yes | 8 asked for, 8 generated and cut off; 32 asked for, 18 generated, ending on its own. |
| `stopSequences` | yes | Stopped after 10 tokens against 18, and the stop sequence was never forwarded. |
| `randomSeed` | no | No option whose name mentions a seed among the nine the loaded generation configuration carries, and two different answers under the same seed. |

So the browser tab side of the intersection is **`temperature`, `maximumOutputTokenCount`, `stopSequences`**, which is the same three the Llama 3.2 1B row already holds — measured on this model rather than copied from that one.

Phase 7 found the settled question answered `"The capital of France is Paris."` in all four runs, greedy and sampled alike, so turning `do_sample` on did not change an answer that asked for no temperature. Milestone 1 still turns sampling on only for a request that asked for a temperature, following `stage_helper_llm_qwen3_5_0_8b_full.ts`: one settled prompt answering the same way is not a promise about every prompt.

One thing this run does not settle: whether `top_k: 0` removed the library's own filter to the 50 highest scoring tokens. Issue #196 saw that filter come off as unfiltered noise on two other models, and no such noise appeared here. It does not weaken the `top_p` result, which rests on `top_p: 0.01` failing to narrow anything at any of the three settings.
