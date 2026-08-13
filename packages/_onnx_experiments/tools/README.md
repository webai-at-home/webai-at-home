# Tools

Two unrelated groups of tools live here. The Qwen3 shard exporter, below, supports the `onnxruntime_qwen3-0.6b-with-shards` experiment. Everything after it belongs to [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169): the Qwen3-30B-A3B residency measurement answers milestone 1, and the quantization gate and the conversion pipeline answer milestone 3.

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

## Qwen3-30B-A3B quantization gate

Answers the question milestone 3 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169) has to answer before any conversion is worth running: does 4-bit block quantization in the layout `MatMulNBits` reads keep a real Qwen3-30B-A3B expert usable, and which block size and which scheme should the conversion write?

```sh
node packages/_onnx_experiments/tools/gate_quantize_real_expert.mjs
```

The gate downloads about 9 megabytes by HTTP range request: three real expert weight matrices out of `Qwen/Qwen3-30B-A3B`, and the same expert as already published by `mlx-community/Qwen3-30B-A3B-4bit`. That second download is what makes the gate mean anything. Quantization error has no absolute threshold that can be argued for from first principles, so the gate compares against a 4-bit conversion of the same model that people already use, and asks only that this conversion is no worse than that one.

It measures six schemes on the real weights:

| scheme | mean weight error | bits for each weight | all 6144 experts |
| --- | --- | --- | --- |
| symmetric, blocks of 16 | 9.07 % | 5.000 | 16.88 GB |
| symmetric, blocks of 32 | 9.56 % | 4.500 | 15.19 GB |
| symmetric, blocks of 64 | 10.19 % | 4.250 | 14.34 GB |
| asymmetric, blocks of 16 | 7.01 % | 5.250 | 17.72 GB |
| **asymmetric, blocks of 32** | **8.20 %** | **4.625** | **15.61 GB** |
| asymmetric, blocks of 64 | 9.29 % | 4.313 | 14.55 GB |

Asymmetric blocks of 32 are chosen: the two schemes below 8 per cent both cost more than the 16-gigabyte budget, which is the whole point of [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168) and not a detail to trade away for accuracy. Storing the scales at half precision costs 0.0001 percentage points of accuracy and saves 1.69 gigabytes, so they are stored at half precision.

Run through the whole expert — `down_proj(silu(gate_proj(x)) * up_proj(x))` — the chosen scheme moves the output by 13.74 per cent on average, against 15.52 per cent for the published `mlx-community` conversion of the same expert. That ratio of 0.89 is what the gate passes on. At the same group size and the same scheme, the two implementations agree to 0.005 percentage points, which says the two are measuring the same thing.

## Qwen3-30B-A3B conversion pipeline

Writes the on-disk layout milestone 3 asks for: the always-resident part in one file, and the 6144 expert blocks in another, each block one contiguous 256-byte-aligned region holding one expert's quantized weights, scales, and zero points together.

```sh
node packages/_onnx_experiments/tools/convert_qwen3_moe_to_expert_blocks.mjs \
  --output /tmp/qwen3-30b-a3b-expert-blocks \
  --first-layer 0 --last-layer 47
```

Nothing is downloaded whole. Every tensor is read out of the published safetensors shards by HTTP range request, sorted by where it sits in its shard and fetched in contiguous runs of at most 96 megabytes, so no copy of the 57-gigabyte model is ever written to disk and the machine never holds more than one run at a time.

One expert block is 2,727,936 bytes, in nine parts — a quantized matrix, its scales, and its zero points, for each of `gate_proj`, `up_proj`, and `down_proj` — every part starting on a 256-byte boundary, and the whole block covering exactly 666 pages of 4096 bytes. The block for layer `l` and expert `e` starts at `(l * 128 + e) * 2727936`. All 6144 blocks come to 15.61 gigabytes.

The pipeline verifies itself rather than being trusted: the written file length must be exactly the block count times the block length, and three blocks are read back and compared byte for byte against a fresh quantization of the same tensors.

The resident part is copied unchanged, at BF16, and is not quantized. That is a deliberate limit of this milestone. Which resident tensors may be quantized depends on how each is used — an attention projection goes through a matrix multiplication and could be quantized exactly as an expert is, while the token embedding is looked up rather than multiplied and would need a different path — and deciding that needs the graph that consumes them, which is milestone 4. Copying them unchanged keeps every one of those choices open.
