# Qwen3-0.6B LiteRT.js shards

Milestone two of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). Every real `.tflite` graph of Qwen3-0.6B, run in the browser on WebGPU and checked element by element against PyTorch, and then the whole model chained together from those graphs.

Qwen3-0.6B is split into **seven decoder shards of four layers each, three language-model head chunks, and a raw token embedding table**. That is not the three-way split issue #179 chose. The three-way split converted and then could not be loaded: at 629 to 1189 megabytes, each shard needs one contiguous WebAssembly allocation the size of the whole file, and `@litertjs/core` 2.5.3 fails above roughly 460 megabytes. Splitting finer fixed it, and no quantization was needed. The original three boundaries still matter for milestone six, which compares against ONNX shards cut at exactly those points.

The token embedding is not in a graph at all. Decoding one token needs one of its rows — 4096 bytes out of 622 million — so the browser reads that row with an HTTP range request, which the development server answers.

## Run

Write the graphs and the references first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_litert_shard_export/export_qwen3_shards.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Then start the development server and open `qwen3-litert-shards/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

Add `?accelerators=wasm` to run the same graphs on the central processor instead, which is how each of the three WebGPU defects this investigation found was told apart from a wrong graph.

The shard files and the embedding table total about 2.4 gigabytes and are not committed. See [`../../tools/qwen3_litert_shard_export/`](../../tools/qwen3_litert_shard_export) for the exporter.

## What the chained check is

The reference in `index.json` is PyTorch running **this decomposition** under the same conditions, never the real model on a fresh sequence. That the decomposition reproduces the real model is a separate question, established in eager PyTorch before any conversion: over 32 greedily generated tokens of a real prompt, the same tokens as unsplit Hugging Face Qwen3-0.6B.
