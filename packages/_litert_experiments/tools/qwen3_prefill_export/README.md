# `qwen3_prefill_export`

Writes one `.tflite` graph per prompt length per decoder shard, and the values PyTorch produced for each. LiteRT.js graphs have static shapes, so a prompt of 32 tokens and a prompt of 128 tokens are two different graphs of the same weights. This is the exporter behind [`public/qwen3-litert-prefill/`](../../public/qwen3-litert-prefill).

## Run

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_prefill_export/export_qwen3_prefill.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Writes `qwen3_0_6b_prefill_<length>_<shard>.tflite` and `prefill_index.json`. `--prefill-length` is repeatable, `--only` limits which shards convert, and `--skip-conversion` rewrites the references alone. The generated graphs total about 5.3 gigabytes and are never committed.

## What it exports

`Qwen3PrefillShard` lives in [`../qwen3_litert_shard_export/export_qwen3_shards.py`](../qwen3_litert_shard_export) and inherits from `Qwen3DecoderShard`, overriding only `forward`. Prefill and decode therefore share one definition of the normalizations, the rotary embedding and the grouped attention layout, and cannot drift apart. Only the driver lives here.

The language-model head is never re-exported for prefill: only the last position's hidden state chooses the next token, so the decode head chunks do that job unchanged.

## Two rules

- **The causal mask is tiled across the repeat axis here, in Python**, and passed in as a tensor. Tiling it inside the graph would be a widening operation, which the WebGPU delegate refuses — the same rule that decides the attention layout.
- **A prefill graph's cache output has exactly the shape a decode graph's cache input has**, which is what lets a prompt be read in one call and then continued one token at a time.

Every length uses the first tokens of one text, so the lengths are the same prompt read in calls of different sizes and are directly comparable.

## Prefill is simpler than decode

It starts at position 0, so there is no cache to read, no position to write at, and no blend between the two. That prefill reproduces decode is established in eager PyTorch before anything is converted: prefilling 32 tokens against decoding the same 32 positions one at a time agrees to 3.8e-5 on the logits and picks the same token, which is also the unsplit model's token.

Read alongside [`CONTEXT.md`](CONTEXT.md), and [`../README.md`](../README.md) for the shared Python virtual environment.
