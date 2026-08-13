# Directory Context: `/packages/_onnx_experiments/tools/qwen3_shard_export`

## Purpose

Splits the published Qwen3-0.6B ONNX model into three independent graphs, and checks the three against the original. This supports the `public/onnxruntime_qwen3-0.6b-with-shards` experiment and has nothing to do with [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169), which every other folder here belongs to.

## Key Exports & Entry Points

- `split_qwen3_onnx.py`: writes `shard-1.onnx`, `shard-2.onnx` and `shard-3.onnx`. Run it with the Python virtual environment one level up, at `tools/.venv`.
- `verify_qwen3_shards.mjs`: runs three autoregressive steps through the three shards with ONNX Runtime Node, optionally comparing against the original monolithic model.

## Local Rules & Boundaries

- Neither file imports anything else in `tools/`, and nothing else in `tools/` imports these. Keep it that way: this is the older, separate experiment.
- The shard files are generated artifacts of about 1.7 gigabytes and are never committed.
