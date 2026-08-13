# Directory Context: `/packages/_onnx_experiments`

## Purpose

Browser experiments for running language models with ONNX Runtime Web and Transformers.js. Each experiment is an independent browser page that downloads its model from Hugging Face, caches it in the browser, and generates entirely in the browser.

## Key Exports & Entry Points

- `public/index.html`: the home page that links to every experiment. `npm run dev --workspace @webai/onnx-experiments` serves it with Vite.
- `public/onnxruntime_qwen3-0.6b-plain/` and `public/onnxruntime_qwen3-0.6b-with-shards/`: the Qwen3-0.6B model run whole and run as shards, which is what the sharded pipeline of the cluster is built on.
- `public/qwen3-0.6b/`, `public/qwen3_5-0.8b-gate/`, `public/qwen3_5-usage-metadata-gate/`, `public/qwen3_5-2b/`, `public/smoll2-360m/`, and `public/gemma4-e2b-it/`: one experiment per model.
- `tools/`: three folders, each with its own `CONTEXT.md`, and a `README.md` at the top naming what each is for.
  - `tools/qwen3_shard_export/`: the older, separate experiment behind `public/onnxruntime_qwen3-0.6b-with-shards/`.
  - `tools/weight_conversion/`: reads the published weights over HTTP range requests and writes this project's on-disk layout — the resident part in one file, one aligned block for each expert. All JavaScript.
  - `tools/model_graphs/`: builds every ONNX graph the browser runs, meaning everything that is not an expert weight, and gates each one against the reference implementation. All Python.
  - The last two never import from each other. They meet only through the files on disk and the `manifest.json` and `graphs.json` that describe them, which is the seam the whole design rests on.
- `public/matmulnbits-owned-webgpu-buffer-gate/`: the issue #169 milestone 0 de-risk gate. It downloads no model and builds its one-node ONNX graph as protocol buffer bytes in the browser.
- `public/expert-residency-layer/`: the issue #169 milestone 4 residency layer. It downloads the published Qwen3-30B-A3B expert blocks into the Origin Private File System and decides which experts are in graphics memory. The whole layer runs in one dedicated worker, because the synchronous access handle only exists there and an expert must reach graphics memory without crossing a thread.
- `public/olmoe-run-twice/`: issue #169 milestone 5 itself. A whole OLMoE-1B-7B-0924 generating in the browser with its 1024 experts on disk, run once with every expert resident and twice through the residency layer, requiring identical token identifiers. Its 5.25 gigabytes of artifacts are generated and are served by the development server from wherever they were written, through the `/olmoe-artifacts/` route in `vite.config.js`.
- `public/expert-block-graph-gate/`: the issue #169 milestone 5 de-risk gate. It runs one real converted expert block through the weightless expert graph, from WebGPU buffers, and requires the answer to sit inside a measured bracket and to come back bit for bit the same every time. Its `fixture/` folder is generated and is not committed.
- `public/qwen3-layer-graph-webgpu-gate/`: the issue #169 milestone 6 de-risk gate, written after the milestone had already gone wrong for want of it. It runs one decoder layer graph through the WebAssembly execution provider and through WebGPU on the same inputs, with OLMoE-1B-7B-0924 as the control that sets the scale rather than a tolerance written down by hand. It found a `Concat` of eight copies that Chrome's WebGPU device cannot compile, which fails by returning zeros without raising anything.
- `public/moe-experts-on-disk/`: issue #169 milestone 6 itself, and the deliverable of issue #168. Qwen3-30B-A3B generating in a browser on a machine whose graphics memory and main memory both cannot hold it, and the curve of model size against tokens each second with one line for each of the three places weights can live. Its artifacts are generated and are served through the `/moe-artifacts/` routes in `vite.config.js`.
- `public/browser-storage-and-webgpu-buffer-measurements/`: the issue #169 milestone 2 measurements of the storage quota, of the Origin Private File System, and of the WebGPU buffer limits. It downloads no model, and it is the only experiment here carrying a web application manifest and a service worker, because one of its measurements only exists when the page is installed.

## Local Rules & Boundaries

- The leading underscore in the folder name marks this package as an experiment. It is private, is not part of the root build script, and no working package may import from it.
- Each experiment is standalone: one folder under `public/` holding its own `index.html` and `src/`. Do not add a shared library folder across experiments; copying a helper into a second experiment is preferred over coupling them.
- `npm test --workspace @webai/onnx-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.
- Model files are never committed. The browser downloads them from Hugging Face and caches them.
