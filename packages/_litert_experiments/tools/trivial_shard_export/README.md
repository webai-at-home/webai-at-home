# `trivial_shard_export`

Writes the trivial `.tflite` graphs the milestone zero gate reads, together with the input and output PyTorch produced for each of them.

## Run

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/trivial_shard_export/export_trivial_graph.py packages/_litert_experiments/public/litertjs-webgpu-gate/models
```

Writes `trivial_shard_<hidden size>.tflite` and `trivial_shard_<hidden size>.reference.json` for each requested hidden size, 1024 and 4096 by default. The generated files are up to 64 mebibytes and are never committed.

## What it exports, and what it deliberately does not

One linear layer. It is **not** a transformer, on purpose. Milestone zero asks only whether `@litertjs/core` loads a graph and compiles it for WebGPU at all; whether a real transformer converts is milestone two's question, and mixing the two into one gate would make a failure impossible to attribute to either.

The weights are seeded from the hidden size, so that a difference seen in the browser is a difference in the runtime and never a difference in the weights.

## Why those two sizes

1024 is the hidden size of Qwen3-0.6B, the chosen first model. 4096 is the hidden size the worked example in [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178) uses. Both are exported because that worked example is where the 16 kibibyte hidden state figure came from, which milestone zero had to correct to 4 kibibytes for this model.

Read alongside [`CONTEXT.md`](CONTEXT.md), and [`../README.md`](../README.md) for the shared Python virtual environment.
