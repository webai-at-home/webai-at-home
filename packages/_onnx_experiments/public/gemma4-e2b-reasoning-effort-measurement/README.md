# Gemma 4 E2B · reasoningEffort measurement · issue #223 milestone 0, half one

The de-risk test of [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223), run before any implementation code is written. It is half one of milestone 0; half two runs through the native worker and is not a browser page.

`task_type_llm_gemma_4_e2b_full` does not honour `reasoningEffort`, and its worker browser tab denies thinking unconditionally rather than as a decision a consumer can make. [`stage_helper_llm_gemma_4_e2b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts) passes `enable_thinking: false` in three places — in the prompt token count, in the pipeline call, and in the rendered prompt of a history that declared tools — written out as a literal, whatever the consumer asked for.

## The one assumption being tested

**Gemma 4 E2B's chat template reads `enable_thinking`, so that a worker browser tab can turn thinking on and off at all.**

If the template ignores the option, the browser tab can express nothing, the intersection of the two kinds of worker is empty, and the row stays without `reasoningEffort` however well the native worker forwards the field. That outcome is a result and not a failure — but it has to be measured rather than inferred from the option being passed today, because passing an option a template ignores looks exactly like passing one it reads.

It is the measurement [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) already used on Qwen3.5-0.8B: render the same history through the chat template both ways and compare the prompts token for token. There, `false` closed the thinking block in the prompt and `true` left it open, 43 tokens against 41. Two identical prompts here would end the issue.

## How to run it

```bash
npm run dev --workspace @webai/onnx-experiments
```

Then open `/gemma4-e2b-reasoning-effort-measurement/` and press the button.

**In a real Chrome, not in an embedded browser pane.** The model is about 3111 megabytes and an embedded pane caps an origin near 2.9 gigabytes, so the download fails there before anything is measured. The page refuses to run on WebAssembly: a WebAssembly answer would look like a working measurement and would say nothing about the path a worker browser tab takes.

The model files are cached in IndexedDB under the same database name every other experiment in this package uses, so a browser that has already run the generation controls measurement or the tool calls measurement downloads nothing again.

## The phases

| Phase | Asks | What honouring looks like |
| --- | --- | --- |
| 1 | Is this really running on WebGPU? | An adapter with `shader-f16`, and no dropped execution provider warning. |
| 2 | Does the chat template read `enable_thinking`? | Two different prompts, in text and in token count, for a history that declared no tool and for a history that declared one. |
| 3 | With thinking on, does the model think, close its thinking, and answer? | A thought channel opened, closed, and answer text after it, inside the 1024-token limit the real stage runs. |
| 4 | What does thinking cost? | Read off the runs phase 3 already made: tokens and wall-clock, with thinking on against with it off. |

Phase 2 can end the issue on its own, and the page stops there when it does.

Phase 3 is what decides whether honouring the control is worth anything. A model that opens a thought channel and never closes it inside the token limit writes no answer at all, and a consumer asking for `high` would receive nothing — which is what Qwen3.5-0.8B did in issue #192, running to a 2048-token limit in 63.8 seconds without ever closing its thinking block. Every generation on this page runs under `MAX_NEW_TOKENS = 1024`, the exact number the real stage helper uses, because a measurement made under a different limit could not answer that question.

Phase 3 asks two questions, one with a settled answer and one with a step to work out, because a model that thinks on both is thinking because the template told it to rather than because the question asked for it.

## What the result is for

Milestone 3 of issue #223 enters into [`generation_control_support.ts`](../../../protocol/src/task/generation_control_support.ts) what **both** kinds of worker keep. The native worker forwards `reasoning_effort` verbatim already, proved live for `task_type_llm_qwen3_5_0_8b_full` in [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) and measured for this model in half two of milestone 0, so the intersection is decided largely by what this page finds.

The precedent for what honouring looks like is `StageHelperLlmQwen3_5_0_8bFull.isThinkingEnabled`: nothing asked means no thinking, `none` means no thinking, and every level above `none` reads the same, because on or off is all a chat template can express.

The other five generation controls are out of scope here and were measured by [issue #222](https://github.com/webai-at-home/webai-at-home/issues/222), whose page sits beside this one.

## Result

Run on 21 August 2026, in Google Chrome on an Apple `metal-3` adapter, on WebGPU, with no execution provider dropped. The whole raw record of both runs is in the milestone 0 comment of [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223).

**Phase 2 — the chat template reads `enable_thinking`, on both paths.**

| History | `enable_thinking: false` | `enable_thinking: true` | Same text? |
| --- | --- | --- | --- |
| declared no tool | 22 tokens | 29 tokens | no |
| declared one tool | 84 tokens | 86 tokens | no |

The `true` render opens a system turn the `false` render does not have, and puts `<|think|>` at the top of it: `"<bos><|turn>system\n<|think|>\n<turn|>\n<|turn>user\n…"` against `"<bos><|turn>user\n…"`. So a worker browser tab can turn thinking on and off, and the assumption this page exists to test holds.

**Phase 3 — the model thinks, closes its thinking, and answers.**

| Question | `enable_thinking` | Completion tokens | Thought channel | Answer |
| --- | --- | --- | --- | --- |
| the settled question | false | 8 | not opened | `"The capital of France is Paris."` |
| the settled question | true | 114 | opened and closed | `"The capital of France is Paris."` |
| the reasoned question | false | 8 | not opened | `"Nine pens cost 6 euros."` |
| the reasoned question | true | 327 | opened and closed | `"Nine pens cost 6 euros."` |

This is the opposite of what issue #192 found on Qwen3.5-0.8B, where thinking ran to a 2048-token limit without ever closing and no answer was ever begun. Here every thinking run closed its channel and wrote its answer well inside the 1024-token limit the real stage runs, and wrote the same answer it wrote without thinking. The model thinks on the settled question as readily as on the reasoned one, so it thinks because the template told it to rather than because the question asked for it.

**Phase 4 — what thinking costs.** 114 tokens against 8 on the settled question, and 327 against 8 on the reasoned one: between fourteen and forty times the completion tokens, for the same answer.

The page was run twice, and the completion token counts were identical both times — this generation is greedy and reproduces exactly. The wall-clock did not: the 327-token run took 16.1 seconds in the first run and 101.9 seconds in the second, on the same machine and the same adapter. Read the token counts on this page and treat the seconds as one machine on one day.

## What the second half of milestone 0 found

Half two is not this page. It sent the same question to Ollama serving `gemma4:e2b` on `http://localhost:11434/v1`, which is the server `packages/worker_openai`'s own `sample:ollama:gemma4_e2b` script points at, once with no `reasoning_effort` field and once per level.

| `reasoning_effort` sent | Prompt tokens | Completion tokens | Reasoning returned |
| --- | --- | --- | --- |
| no field at all | 29 | 114 | yes, 415 characters |
| `none` | 22 | 8 | no |
| `minimal` | 29 | 114 | yes, 415 characters |
| `low` | 29 | 114 | yes, 415 characters |
| `medium` | 29 | 114 | yes, 415 characters |
| `high` | 29 | 114 | yes, 415 characters |
| `xhigh` | 29 | 114 | yes, 415 characters |

Nothing was refused, and the field is genuinely read rather than dropped: a seventh level is answered with HTTP 400 and the message `invalid reasoning value: "not_a_level" (must be "minimal", "low", "medium", "high", "xhigh", "ultra", "max", or "none")`.

Those prompt and completion token counts are the same 22, 29, 8 and 114 this page measured in the browser tab, and the reasoning text is the same `Thinking Process:` text the browser tab generated. Both kinds of worker are reading the same chat template switch, and both express exactly `none` against everything else — which is the coarseness `StageHelperLlmQwen3_5_0_8bFull.isThinkingEnabled` already declares.

One thing the two workers do **not** agree on: a request that asked for nothing. The browser tab passes `enable_thinking: false` and does not think; the native worker sends no field, and Ollama thinks. Same task type, same request, 8 completion tokens against 114. Milestone 1 keeps the browser tab's default as it is, which is what leaves today's answers byte for byte unchanged, so the disagreement is recorded here rather than closed here.
