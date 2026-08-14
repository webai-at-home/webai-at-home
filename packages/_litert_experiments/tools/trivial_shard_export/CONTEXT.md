# Directory Context: `/packages/_litert_experiments/tools/trivial_shard_export`

## Purpose

Writes the trivial `.tflite` graphs the milestone zero gate reads, together with the reference input and output PyTorch produced for each of them.

## Key Exports & Entry Points

- `export_trivial_graph.py`: writes `trivial_shard_<hidden size>.tflite` and `trivial_shard_<hidden size>.reference.json` for each requested hidden size, 1024 and 4096 by default. Run it with the Python virtual environment one level up, at `tools/.venv`.

## Rules

- The exported module is one linear layer and is deliberately not a transformer. Whether a real transformer converts is milestone two's question, and mixing the two questions into one gate would make a failure impossible to attribute.
- The weights are seeded from the hidden size, so that a difference seen in the browser is a difference in the runtime and never a difference in the weights.
- The generated files are artifacts of up to 64 mebibytes and are never committed.

## Background

- This folder is milestone zero of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179).
- 1024 is the hidden size of Qwen3-0.6B, the chosen first model. 4096 is the hidden size the worked example in [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178) uses.
