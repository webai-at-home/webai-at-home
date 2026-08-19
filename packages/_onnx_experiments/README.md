# `@webai/onnx-experiments`

Browser experiments for running language models with ONNX Runtime Web and
Transformers.js. The package is private and is not included in the root build
script because the experiments are independent browser applications.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/onnx-experiments
```

Open the local URL printed by Vite. The home page links to the Qwen3-0.6B,
SmolLM2-360M, and Gemma 4 experiments, including plain and sharded ONNX
Runtime versions. Model files are downloaded by the browser from Hugging Face
and cached by the browser; inference stays in the browser.

## Build and type check

```sh
npm run typecheck --workspace @webai/onnx-experiments
npm run build --workspace @webai/onnx-experiments
npm run preview --workspace @webai/onnx-experiments
```

The Vite build has separate HTML inputs for every experiment. The sharded
Qwen3 experiment also needs the generated shard files; see
[`tools/README.md`](tools/README.md) before opening that experiment.

## Experiments

- [`public/qwen3-0.6b`](public/qwen3-0.6b) — Qwen3-0.6B through Transformers.js.
- [`public/onnxruntime_qwen3-0.6b-with-shards`](public/onnxruntime_qwen3-0.6b-with-shards) — three ONNX shards.
- [`public/onnxruntime_qwen3-0.6b-plain`](public/onnxruntime_qwen3-0.6b-plain) — one ONNX model.
- [`public/smoll2-360m`](public/smoll2-360m) — SmolLM2-360M through Transformers.js.
- [`public/gemma4-e2b-it`](public/gemma4-e2b-it) — Gemma 4 E2B-it through Transformers.js.
- [`public/qwen3_5-0.8b-gate`](public/qwen3_5-0.8b-gate) — Qwen3.5-0.8B through Transformers.js, issue #96 de-risk gate.
- [`public/qwen3_5-2b`](public/qwen3_5-2b) — Qwen3.5-2B through Transformers.js.
- [`public/qwen3_5-tool-calls-gate`](public/qwen3_5-tool-calls-gate) — Qwen3.5-0.8B tool calls through the chat template, issue #115 de-risk gate.
- [`public/gemma4-e2b-tool-calls-gate`](public/gemma4-e2b-tool-calls-gate) — Gemma 4 E2B tool calls through the chat template, on WebGPU only, issue #216 de-risk gate.
- [`public/matmulnbits-owned-webgpu-buffer-gate`](public/matmulnbits-owned-webgpu-buffer-gate) — `MatMulNBits` reading 4-bit weights out of a WebGPU buffer this project overwrites between calls, issue #169 milestone 0 de-risk gate. Downloads no model.
- [`public/browser-storage-and-webgpu-buffer-measurements`](public/browser-storage-and-webgpu-buffer-measurements) — what one page may keep on disk, how fast an expert-sized block reaches a WebGPU buffer, and how much WebGPU buffer memory one page can hold, issue #169 milestone 2. Downloads no model.

The experiment pages are measurements and demonstrations, not production
model-serving endpoints.
