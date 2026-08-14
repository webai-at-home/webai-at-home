# `qwen3_litert_shard_export`

Splits Qwen3-0.6B into independently runnable `.tflite` graphs small enough for `@litertjs/core` to load, and writes the values PyTorch produced for each. This is the exporter behind [`public/qwen3-litert-shards/`](../../public/qwen3-litert-shards), and it also holds `Qwen3PrefillShard`, which [`qwen3_prefill_export/`](../qwen3_prefill_export) drives.

## Run

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_litert_shard_export/export_qwen3_shards.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Writes seven decoder shards, three head chunks, the token embedding table, and one reference JSON per graph — about 2.4 gigabytes, never committed.

| Option | What it does |
| --- | --- |
| `--skip-conversion` | Rewrites the reference JSON files alone, without converting anything. |
| `--only` | Limits which graphs convert. |
| `--name-suffix` | Keeps two layouts side by side under different names. |
| `--attention-layout` | `grouped`, the default, or `expand`. |
| `--layers-per-shard`, `--head-chunks` | Where the graphs are cut. |

## The rules that shape what it writes

- **Grouped-query attention is exported in the `grouped` layout.** The `expand` layout widens the key and value heads up to the query heads, which emits `BROADCAST_TO`; the WebGPU delegate refuses that operation, and one refusal sends 273 of the graph's 355 operations to the central processor.
- **Nothing here uses `torch.nn.functional.pad`.** It converts to a `PADV2` that the WebGPU delegate accepts and then computes wrongly — the first of eight cache entries came back zeroed while WebAssembly returned all eight. Concatenating a zero constant instead is correct, and costs about 1.9 megabytes a graph.
- **Every `.tflite` file stays under about 440 megabytes**, because `loadAndCompile()` needs one contiguous WebAssembly allocation the size of the whole file. Four layers is 251.8 megabytes and a head chunk is 207.4.
- **The token embedding is never exported into a graph.** It is a raw binary read one row at a time with an HTTP range request, because decoding one token needs 4096 of its 622 million bytes.
- **The decoder layer is written out in `Qwen3DecoderShard`** rather than taken from Hugging Face's `forward()`, because the graph must stay fully static and the cache must stay at rank 4.
- **The rotary tables, the causal mask and the cache write mask are passed in as tensors**, because each would otherwise need a shape set by the token position.

## Why seven shards and not three

Issue [#179](https://github.com/webai-at-home/webai-at-home/issues/179) chose the three boundaries `packages/_onnx_experiments` uses. All three converted and none could be loaded, at 629 to 1189 megabytes. Splitting finer fixed it, and quantization was not needed. Those three boundaries still matter for milestone six, which compares against ONNX shards cut at exactly those points.

Read alongside [`CONTEXT.md`](CONTEXT.md), and [`../README.md`](../README.md) for the shared Python virtual environment.
