# Qwen3.5-0.8B · Issue #226 thinking cut measurement

Loads [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision, `q4f16` quantization, and WebGPU device as
[`stage_helper_llm_qwen3_5_0_8b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts),
and generates three times in the browser.

This page is the measurement for [issue #226](https://github.com/webai-at-home/webai-at-home/issues/226): the stage
helper sends the model's own thinking to the consumer as the answer, and before that thinking can be cut out, two
things have to be observed rather than assumed.

- Does the closing `</think>` marker survive `skip_special_tokens: true`, which is the decoding the stage helper
  serves a consumer? A cut made on the text can only find a marker that is still there. This is the difference from
  [`qwen3_5-thinking-control-gate`](../qwen3_5-thinking-control-gate/), which decoded with `false`.
- Does this model ever close its thinking at all? Issue #192 and issue #226 both recorded runs reaching their cap
  still thinking, and a cut can only be read against a run that closed.

Each phase also applies the proposed cut — the model's own chat template line,
`content.split('</think>')[-1].lstrip('\n')` — to the text it recorded, so the cut is read against what the model
really wrote.

## What it measured

Run on 2026-08-22, on WebGPU, against the pinned revision.

**Phase 1 — thinking on, `What is the capital of France?`, cap 2048.** 218 tokens in 25265 ms, well short of the cap.
The text holds no opening `<think>` marker, because the chat template writes that one into the generation prompt and
the prompt is not decoded into the answer. It holds a closing `</think>` marker, so **the marker survives
`skip_special_tokens: true`** — as the pinned `tokenizer.json` says it should, listing it as added token 248069 with
`special: false`, the same as `<tool_call>`. The marker arrived as one whole piece, `"</think>\n\n"`. The cut leaves
`"The capital of France is **Paris**."`, which is the answer alone.

**Phase 2 — thinking on, the issue #192 multi-turn history, cap 2048.** 2048 tokens in 82639 ms, the cap reached, no
closing marker anywhere. The cut leaves `""`. So a run that never closes its thinking holds no answer at all, and
`EmptyAnswerRefusal` refuses it rather than reporting silence as a finished answer.

**Phase 3 — thinking off, `What is the capital of France?`, cap 512.** 42 tokens in 2604 ms, no marker of either
kind, because the template closes the thinking block in the prompt itself. The cut leaves `""` — which is why the cut
must be applied only to a run that let the model think. Applied to every run, it would empty every answer this model
writes with thinking off.

## Run

Start the dev server from the package root and open `qwen3_5-thinking-cut-measurement/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model files are cached by the browser (IndexedDB), so a browser that already ran
[`qwen3_5-thinking-control-gate`](../qwen3_5-thinking-control-gate/) does not re-download them.

See [`../../README.md`](../../README.md) for the other experiments in this package.
