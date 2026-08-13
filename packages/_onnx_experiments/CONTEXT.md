# Directory Context: `/packages/_onnx_experiments`

## Purpose

Browser experiments for running language models with ONNX Runtime Web and Transformers.js. Each experiment is an independent browser page that downloads its model from Hugging Face, caches it in the browser, and generates entirely in the browser.

## Key Exports & Entry Points

- `public/index.html`: the home page linking to every experiment. Command to run this folder: `npm run dev --workspace @webai/onnx-experiments`.
- `public/onnxruntime_qwen3-0.6b-plain/` and `public/onnxruntime_qwen3-0.6b-with-shards/`: the Qwen3-0.6B model run whole and run as shards, which the sharded pipeline of the cluster is built on.
- `public/`: one further folder per experiment, per de-risk gate, and per measurement, each named after what it runs.
- `tools/qwen3_shard_export/`, `tools/weight_conversion/`, `tools/model_graphs/`: each with its own CONTEXT.md, and named in `tools/README.md`.
- `vite.config.js`: the routes serving the generated artifacts of the larger experiments from wherever they were written.

## Rules

- The leading underscore marks this package as an experiment. It is private, is not part of the root build script, and no working package may import from it.
- Each experiment is standalone: one folder under `public/` with its own `index.html` and `src/`. Do not add a shared library folder; copying a helper into a second experiment is preferred over coupling them.
- `tools/weight_conversion/` and `tools/model_graphs/` never import from each other. They meet only through the files on disk and the `manifest.json` and `graphs.json` describing them, which is the seam the whole design rests on.
- `npm test --workspace @webai/onnx-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.
- Model files and generated artifacts are never committed.

## Background

- Every folder here except `tools/qwen3_shard_export/` belongs to [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169), whose milestones name each gate and each measurement.
