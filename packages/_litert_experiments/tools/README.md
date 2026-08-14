# Tools for the LiteRT.js experiments

Every tool here writes files that a browser experiment under `../public/` reads. Nothing here is committed as an artifact: the `.tflite` files, the reference JSON files, and any model weights are all generated.

## The Python virtual environment

All the Python tools share one virtual environment at `tools/.venv`. It needs Python 3.12, because `litert-torch` pulls in PyTorch and PyTorch has no wheel for Python 3.14.

```bash
uv venv --python 3.12 packages/_litert_experiments/tools/.venv
uv pip install --python packages/_litert_experiments/tools/.venv/bin/python -r packages/_litert_experiments/tools/requirements.txt
```

## The tools

- `trivial_shard_export/`: writes the trivial graphs the milestone zero gate reads.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/trivial_shard_export/export_trivial_graph.py \
  packages/_litert_experiments/public/litertjs-webgpu-gate/models
```

- `cache_residency_export/`: writes the graphs the milestone one key/value cache residency gate reads.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/cache_residency_export/export_shard_like_step.py --update constant \
  packages/_litert_experiments/public/litertjs-cache-residency-gate/models
```

- `cache_residency_export/export_multiple_output_diagnosis.py`: writes the four graphs that name what WebGPU computes wrongly.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/cache_residency_export/export_multiple_output_diagnosis.py \
  packages/_litert_experiments/public/litertjs-multiple-output-diagnosis/models
```

- `qwen3_litert_shard_export/`: splits Qwen3-0.6B into seven decoder shards, three language-model head chunks, and the raw token embedding table. Everything below depends on it, and `Qwen3PrefillShard` lives here too.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/qwen3_litert_shard_export/export_qwen3_shards.py \
  packages/_litert_experiments/public/qwen3-litert-shards/models
```

- `qwen3_decode_reference/`: writes what every shard produced at every position of a whole generated sequence, which milestone four is checked against.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/qwen3_decode_reference/export_decode_reference.py \
  packages/_litert_experiments/public/qwen3-litert-shards/models
```

- `qwen3_prefill_export/`: writes one graph per prompt length per decoder shard, because a static shape means a prompt of 32 tokens and a prompt of 128 tokens are two different graphs.

```bash
packages/_litert_experiments/tools/.venv/bin/python \
  packages/_litert_experiments/tools/qwen3_prefill_export/export_qwen3_prefill.py \
  packages/_litert_experiments/public/qwen3-litert-shards/models
```

The milestone six comparison at `../public/onnxruntime-comparison/` has no exporter here. It reads the three ONNX shards written by `packages/_onnx_experiments/tools/qwen3_shard_export/`, and checks them against the reference files the two tools above already wrote.
