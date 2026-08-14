# Directory Context: `/packages/_litert_experiments/tools/qwen3_litert_shard_export`

## Purpose

Splits Qwen3-0.6B into independently runnable `.tflite` shards small enough for `@litertjs/core` to load, and writes the reference values PyTorch produced for each. It also holds `Qwen3PrefillShard`, driven by milestone five's exporter.

## Key Exports & Entry Points

- `export_qwen3_shards.py`: writes seven decoder shards, three head chunks, the token embedding table, and one reference JSON per graph. `--skip-conversion` rewrites the references alone; `--only` limits which graphs convert; `--name-suffix` keeps two layouts side by side.
- Command: `tools/.venv/bin/python tools/qwen3_litert_shard_export/export_qwen3_shards.py public/qwen3-litert-shards/models`

## Rules

- Grouped-query attention is exported with `--attention-layout grouped`, the default. The `expand` layout emits BROADCAST_TO, which the WebGPU delegate refuses, and one refusal sends 273 of the graph's 355 operations to the central processor.
- Nothing here uses `torch.nn.functional.pad`. It converts to a PADV2 the WebGPU delegate accepts and then computes wrongly — the first of eight cache entries came back zeroed, while WebAssembly returned all eight. Concatenate a zero constant instead.
- Every generated `.tflite` file stays under about 440 megabytes, because `loadAndCompile()` needs one contiguous WebAssembly allocation the size of the whole file. `--layers-per-shard` and `--head-chunks` hold that line: four layers is 251.8 megabytes, a head chunk 207.4.
- The token embedding is never exported into a graph. It is a raw binary read one row at a time with an HTTP range request, because decoding one token needs 4096 of its 622 million bytes.
- The decoder layer is written out in `Qwen3DecoderShard` rather than taken from Hugging Face's `forward()`, because the graph must stay fully static and the cache must stay at rank 4.
- The rotary tables, the causal mask, and the cache write mask are passed in as tensors, because each would otherwise need a shape set by the token position.
- The chained reference in `index.json` is PyTorch running this decomposition under the same conditions, never the real model on a fresh sequence.
- The shard files and the embedding binary total about 2.4 gigabytes and are not committed.

## Background

- This folder is milestone two of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179); the attention rule is its milestone four, the padding rule its milestone five.
- That the decomposition reproduces the real model is established in eager PyTorch: over 32 greedily generated tokens of a real prompt, the same tokens as unsplit Hugging Face Qwen3-0.6B, for both attention layouts.
- The first attempt used the three shard boundaries `packages/_onnx_experiments` uses. All three converted and none could be loaded, at 629 to 1189 megabytes. Splitting finer fixed it; quantization was not needed. Those boundaries still matter for milestone six.
