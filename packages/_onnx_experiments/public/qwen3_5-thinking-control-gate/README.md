# Qwen3.5-0.8B · Issue #192 thinking control de-risk gate

Loads [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision and `q4f16` quantization as
[`stage_helper_llm_qwen3_5_0_8b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts),
and runs two generations in the browser.

This page is the gate for [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192): is
`enable_thinking` a real control in Transformers.js, or is it accepted and dropped the way LM Studio 0.4.20 drops
`chat_template_kwargs`?

The question has to be answered before a consumer may be given a `reasoning_effort` control. A task type's contract is
the intersection of what all of its workers honour, so `task_type_llm_qwen3_5_0_8b_full` can only honour that control
if the worker browser tab honours it too, and that tab hardcodes `enable_thinking: false` in three places today.

- **Phase 1** — renders the chat template both ways and reports whether the two rendered prompts differ at all. If they
  do not, the control is accepted and dropped and the other two phases mean nothing.
- **Phase 2** — generates with `enable_thinking: false`, the setting the stage hardcodes today, so that the behaviour
  that must stay reachable is measured rather than assumed unchanged.
- **Phase 3** — generates with `enable_thinking: true` under a generous cap, to see whether the browser tab shows the
  same runaway that issue #192 measured against LM Studio.

Every phase asks the model the exact history
[`multi_turn.ts`](../../../openai_conformance_test_TOREMOVE/src/tests/chat/multi_turn.ts) sends, because that is the
conformance test issue #192 reports as failing.

## Run

Start the dev server from the package root and open `qwen3_5-thinking-control-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model files are cached by the browser (IndexedDB), so a browser that already ran
[`qwen3_5-usage-metadata-gate`](../qwen3_5-usage-metadata-gate/) does not re-download them.

See [`../../README.md`](../../README.md) for the other experiments in this package.
