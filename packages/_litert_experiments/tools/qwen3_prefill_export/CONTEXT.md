# Directory Context: `/packages/_litert_experiments/tools/qwen3_prefill_export`

## Purpose

Writes one `.tflite` graph per prompt length per decoder shard, and the reference values PyTorch produced for each. Static shapes mean a prompt of 32 tokens and a prompt of 128 tokens are two different graphs of the same weights. This supports the `public/qwen3-litert-prefill` experiment.

## Key Exports & Entry Points

- `export_qwen3_prefill.py`: writes `qwen3_0_6b_prefill_<length>_<shard>.tflite` and `prefill_index.json`. `--prefill-length` is repeatable, `--only` limits which shards convert, `--skip-conversion` rewrites the references alone.
- Command to run this folder: `tools/.venv/bin/python tools/qwen3_prefill_export/export_qwen3_prefill.py public/qwen3-litert-shards/models`

## Rules

- `Qwen3PrefillShard` lives in `../qwen3_litert_shard_export/export_qwen3_shards.py` and inherits from `Qwen3DecoderShard`, so prefill and decode share one definition of the arithmetic and cannot drift apart. Only the driver lives here.
- The language-model head is never re-exported for prefill. Only the last position's hidden state chooses the next token, so the decode head chunks do that job unchanged.
- The causal mask is tiled across the repeat axis here, in Python, and passed in as a tensor. Tiling it inside the graph would be a widening operation, which the WebGPU delegate refuses — the same rule that decides the attention layout.
- A prefill graph's cache output has exactly the shape a decode graph's cache input has, which is what lets a prompt be read in one call and then continued one token at a time.
- Every length uses the first tokens of one text, so the lengths are the same prompt read in calls of different sizes and are directly comparable.
- The generated graphs total about 5.3 gigabytes and are never committed.

## Background

- This folder is milestone five of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179).
- Prefill is simpler than decode rather than harder: it starts at position 0, so there is no cache to read, no position to write at, and no blend between the two.
- That prefill reproduces decode is established in eager PyTorch before anything is converted: prefilling 32 tokens against decoding the same 32 positions one at a time agrees to 3.8e-5 on the logits and picks the same token, which is also the unsplit model's token.
