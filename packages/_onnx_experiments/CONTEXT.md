# Directory Context: `/packages/_onnx_experiments`

## Purpose

Browser experiments for running language models with ONNX Runtime Web and Transformers.js. Each experiment is an independent browser page that downloads its model from Hugging Face, caches it in the browser, and generates entirely in the browser.

## Key Exports & Entry Points

- `public/index.html`: the home page that links to every experiment. `npm run dev --workspace @webai/onnx-experiments` serves it with Vite.
- `public/onnxruntime_qwen3-0.6b-plain/` and `public/onnxruntime_qwen3-0.6b-with-shards/`: the Qwen3-0.6B model run whole and run as shards, which is what the sharded pipeline of the cluster is built on.
- `public/qwen3-0.6b/`, `public/qwen3_5-0.8b-gate/`, `public/qwen3_5-usage-metadata-gate/`, `public/qwen3_5-2b/`, `public/smoll2-360m/`, and `public/gemma4-e2b-it/`: one experiment per model.
- `tools/verify_qwen3_shards.mjs`: checks the Qwen3 shard files outside the browser.
- `public/matmulnbits-owned-webgpu-buffer-gate/`: the issue #169 milestone 0 de-risk gate. It downloads no model and builds its one-node ONNX graph as protocol buffer bytes in the browser.

## Local Rules & Boundaries

- The leading underscore in the folder name marks this package as an experiment. It is private, is not part of the root build script, and no working package may import from it.
- Each experiment is standalone: one folder under `public/` holding its own `index.html` and `src/`. Do not add a shared library folder across experiments; copying a helper into a second experiment is preferred over coupling them.
- `npm test --workspace @webai/onnx-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.
- Model files are never committed. The browser downloads them from Hugging Face and caches them.
