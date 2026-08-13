# Tools

Two unrelated tools live here. The Qwen3 shard exporter, below, supports the `onnxruntime_qwen3-0.6b-with-shards` experiment. The Qwen3-30B-A3B residency measurement, at the end, answers milestone 1 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169).

## Qwen3 shard exporter

The browser page expects three files in
`packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards/`. The files are generated artifacts and
are intentionally ignored by Git because they are about 1.7 GB in total.

Create the repository-local environment and install the exporter dependency:

```sh
python3.13 -m venv packages/_onnx_experiments/tools/.venv
packages/_onnx_experiments/tools/.venv/bin/pip install -r packages/_onnx_experiments/tools/requirements.txt
```

Download the source model and export the three shards:

```sh
curl -L --fail --output /tmp/qwen3-model_q4f16.onnx \
  https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx
packages/_onnx_experiments/tools/.venv/bin/python packages/_onnx_experiments/tools/split_qwen3_onnx.py \
  /tmp/qwen3-model_q4f16.onnx \
  packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards
```

The exporter creates independent graphs with these boundaries:

- Shard 1: token embedding, decoder layers 0–8, and the layer 9 input normalisation.
- Shard 2: decoder layers 9–18 and the layer 19 input normalisation.
- Shard 3: decoder layers 19–27, final RMSNorm, and the language-model output head.

The input normalisation boundary carries both the normalised activation and the
residual activation because the exported Qwen3 graph uses fused skip-normalisation
operators. The browser passes those two tensors, along with each shard's local
key/value cache, from one session to the next.

Verify three autoregressive steps with ONNX Runtime Node:

```sh
node packages/_onnx_experiments/tools/verify_qwen3_shards.mjs
```

Pass the original monolithic model as an optional argument to compare the first
shard pipeline result against the original graph:

```sh
node packages/_onnx_experiments/tools/verify_qwen3_shards.mjs /tmp/qwen3-model_q4f16.onnx
```

## Qwen3-30B-A3B residency measurement

Answers milestone 1 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169): does the always-resident part of Qwen3-30B-A3B fit in the graphics memory of the target machine? Streaming only helps for the part of a model that is inactive most of the time, so if the part that must stay resident does not fit on its own, the approach of [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168) stops there.

```sh
node packages/_onnx_experiments/tools/measure_qwen3_moe_residency.mjs
```

The tool downloads no model. It reads the real shape of every one of the 18867 published tensors out of the safetensors headers over HTTP range requests, which is about 20 megabytes rather than the 57 gigabytes of weights, and classifies each tensor as an expert weight or as always resident. Nothing is trusted to arithmetic done from `config.json`.
