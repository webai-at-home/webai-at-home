# Directory Context: `/packages/_onnx_experiments`

## Purpose

Browser experiments for running language models with ONNX Runtime Web and Transformers.js. Each experiment is an independent browser page that downloads its model from Hugging Face, caches it in the browser, and generates entirely in the browser.

## Key Exports & Entry Points

- `public/index.html`: the home page that links to every experiment. `npm run dev --workspace @webai/onnx-experiments` serves it with Vite.
- `public/onnxruntime_qwen3-0.6b-plain/` and `public/onnxruntime_qwen3-0.6b-with-shards/`: the Qwen3-0.6B model run whole and run as shards, which is what the sharded pipeline of the cluster is built on.
- `public/qwen3-0.6b/`, `public/qwen3_5-0.8b-gate/`, `public/qwen3_5-usage-metadata-gate/`, `public/qwen3_5-2b/`, `public/smoll2-360m/`, and `public/gemma4-e2b-it/`: one experiment per model.
- `tools/verify_qwen3_shards.mjs`: checks the Qwen3 shard files outside the browser.
- `tools/safetensors_reader.mjs` and `tools/quantize_matmulnbits.mjs`: read published safetensors shards over HTTP range requests, and quantize a weight matrix to 4 bits in the layout `MatMulNBits` reads. Both are used by the issue #169 tools below.
- `tools/gate_quantize_real_expert.mjs` and `tools/convert_mixture_of_experts_to_expert_blocks.mjs`: the issue #169 milestone 3 quantization gate and the conversion pipeline that writes a mixture-of-experts model as a resident part and one block for each expert. `--model` names which of the two known models to convert, and has no default.
- `tools/gate_olmoe_expert_decomposition.py`, `tools/olmoe_non_expert_graph.py`, and `tools/gate_olmoe_non_expert_graph.py`: the issue #169 milestone 5 gates for OLMoE-1B-7B-0924, and the hand-built ONNX graph holding the half of a decoder layer that is not the experts.
- `tools/expert_block_graph.py` and `tools/make_expert_block_graph_fixture.mjs`: the weightless ONNX graph that computes one expert from nine runtime inputs, and the fixture the gate below reads.
- `public/matmulnbits-owned-webgpu-buffer-gate/`: the issue #169 milestone 0 de-risk gate. It downloads no model and builds its one-node ONNX graph as protocol buffer bytes in the browser.
- `public/expert-residency-layer/`: the issue #169 milestone 4 residency layer. It downloads the published Qwen3-30B-A3B expert blocks into the Origin Private File System and decides which experts are in graphics memory. The whole layer runs in one dedicated worker, because the synchronous access handle only exists there and an expert must reach graphics memory without crossing a thread.
- `public/expert-block-graph-gate/`: the issue #169 milestone 5 de-risk gate. It runs one real converted expert block through the weightless expert graph, from WebGPU buffers, and requires the answer to sit inside a measured bracket and to come back bit for bit the same every time. Its `fixture/` folder is generated and is not committed.
- `public/browser-storage-and-webgpu-buffer-measurements/`: the issue #169 milestone 2 measurements of the storage quota, of the Origin Private File System, and of the WebGPU buffer limits. It downloads no model, and it is the only experiment here carrying a web application manifest and a service worker, because one of its measurements only exists when the page is installed.

## Local Rules & Boundaries

- The leading underscore in the folder name marks this package as an experiment. It is private, is not part of the root build script, and no working package may import from it.
- Each experiment is standalone: one folder under `public/` holding its own `index.html` and `src/`. Do not add a shared library folder across experiments; copying a helper into a second experiment is preferred over coupling them.
- `npm test --workspace @webai/onnx-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.
- Model files are never committed. The browser downloads them from Hugging Face and caches them.
