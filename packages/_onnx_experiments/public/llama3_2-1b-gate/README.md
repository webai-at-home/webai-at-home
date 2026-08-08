# Llama 3.2 1B Instruct · Issue #154 de-risk gate

Loads [`onnx-community/Llama-3.2-1B-Instruct-ONNX`](https://huggingface.co/onnx-community/Llama-3.2-1B-Instruct-ONNX)
with [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the
`q4f16` quantization, and runs six phases in the browser.

This page is milestone 0's de-risk gate for
[issue #154](https://github.com/webai-at-home/webai-at-home/issues/154): can `@huggingface/transformers` download,
load, and generate from this export on the WebGPU backend, inside a real browser tab, and does the ungated
repository actually download without a Hugging Face access token?

- **Phase 0** — reports whether a WebGPU adapter exists, whether it supports 16-bit floating point shaders
  (`shader-f16`, which `q4f16` needs), and the free storage this browser reports before the download starts.
- **Model load** — measures the download and load time, and the bytes reported downloaded per file from the
  `progress_callback`, so a cold-cache run can be told apart from a warm-cache run.
- **Phase 1** — tokenizes a plain prompt string, and the same prompt with the chat template applied, and reports
  the exact token count both ways.
- **Phase 1b** — renders a system message and a user message through the chat template with `tokenize: false`, and
  checks that the system instruction's literal text appears in the rendered template.
- **Phase 2** — generates with a generous cap and lets the model stop on its own, then checks whether the last
  generated token id is in `eos_token_id`, and reports tokens per second.
- **Phase 3** — generates with `max_new_tokens: 5`, small enough that the cap is what stops it, not the model.
- **Phase 4** — calls `InterruptableStoppingCriteria.interrupt()` from inside the token callback, after 3 tokens,
  the same way a real stage's `clearGeneration`/`release` would, and checks `criteria.interrupted`.
- **Phase 5** — runs a real generation from a system message and a user message together, and checks that the
  answer actually followed the system instruction, rather than only inspecting the rendered template string as
  Phase 1b did.

Llama 3.2 1B Instruct's chat template has no thinking mode, so unlike the Qwen3.5 gates this page passes no
`enable_thinking` option to `apply_chat_template` or to generation.

## Run

Start the dev server from the package root and open `llama3_2-1b-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model files are cached by the browser (IndexedDB), so a browser that already ran this gate once does not
re-download them on a later page load — reload the page to measure a warm-cache load time against the first run's
cold-cache load time. To force a true cold-cache download again, clear the `webai-onnx-experiments` IndexedDB
database in the browser's developer tools.

See [`../../README.md`](../../README.md) for the other experiments in this package.
