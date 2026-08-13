# Tools

Two unrelated groups of tools live here. The Qwen3 shard exporter, below, supports the `onnxruntime_qwen3-0.6b-with-shards` experiment. Everything after it belongs to [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169): the Qwen3-30B-A3B residency measurement answers milestone 1, the quantization gate and the conversion pipeline answer milestone 3, and the OLMoE gates, the expert graph, and the fixture generator belong to milestone 5.

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

## OLMoE expert decomposition gate

Answers the question milestone 5 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169) has to answer before anything is built. That milestone runs OLMoE-1B-7B twice, once with every expert resident and once through the residency layer, and requires the generated tokens to be identical. Both runs therefore have to share the same arithmetic and differ only in where the weights live, which is only possible if the expert block takes apart exactly.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/gate_olmoe_expert_decomposition.py
```

The gate downloads no weights. It builds one `OlmoeSparseMoeBlock` with random weights and checks that computing it by hand — router, softmax, top-8, eight independent expert feed-forwards, weighted sum — reproduces what the reference implementation produces. Two computations of the same thing either agree or they do not, and that does not need the published 13.8 gigabytes.

It matches to **6.069e-06** relative, inside a tolerance of 1e-5.

The gate also demonstrates that it can fail. OLMoE sets `norm_topk_prob` to false, so the eight routing weights are raw softmax probabilities over all 64 experts and do not sum to one. Renormalising them, which many mixture-of-experts implementations do, would multiply every expert's contribution by about 2.64 while leaving the output looking entirely reasonable.

## OLMoE non-expert graph, and its gate

`olmoe_non_expert_graph.py` builds the other half of one OLMoE decoder layer as an ONNX graph — normalization, the query, key and value projections, the query and key normalizations, the rotary embedding, attention with a key and value cache, the output projection, and the router — and stops exactly where the experts begin:

```
residual, expert_input, router_logits, present_key, present_value
    = graph(hidden_state, past_key, past_value, cos, sin, attention_bias)
```

The caller routes, computes the chosen experts from weights it owns, and adds the result to `residual`. That seam is where the residency layer lives.

Only the *expert* weights ever have to be runtime inputs. Everything in this graph is resident for the life of the model and never changes, so it stays an ordinary initializer.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/gate_olmoe_non_expert_graph.py
```

The gate checks the graph plus separately computed experts against the reference layer, over four cases: one token and several, each with an empty key and value cache and with one already holding history. The worst case is **2.056e-06** relative, inside a tolerance of 2e-5, and the returned cache matches the reference cache every time.

The attention bias is a graph input rather than a mask built into the graph. Decoding one token at a time needs no mask at all, since that token may attend to the whole history. The gate's negative control replaces the causal bias with zeros for a multi-token case and the difference jumps to **3.872e-01**, 188288 times the worst real case, which is what makes the other four rows worth believing.

## The expert graph, and the fixture that checks it

`expert_block_graph.py` builds one expert as an ONNX graph holding **no weights at all**. All nine tensors of an expert — a quantized matrix, its scales, and its zero points, for each of `gate_proj`, `up_proj`, and `down_proj` — arrive as graph inputs, in exactly the order the conversion pipeline writes them into a block. The whole file is 1379 bytes.

The arithmetic inside is half precision and the seam is single precision. That is forced rather than chosen: `MatMulNBits` requires the activation and the scales to share an element type, and milestone 3 stored the scales at half precision because that saved 1.69 gigabytes. Two `Cast` nodes keep that consequence inside the one file where it is written down.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/expert_block_graph.py \
  --manifest /tmp/olmoe-1b-7b-0924-expert-blocks/manifest.json \
  --output packages/_onnx_experiments/public/expert-block-graph-gate/fixture/expert.onnx
```

The sizes come out of the conversion's own manifest rather than off the command line, because a graph built to sizes that do not match the blocks on disk loads perfectly well and then reads the wrong bytes.

`make_expert_block_graph_fixture.mjs` writes what [the expert block graph gate](../public/expert-block-graph-gate/README.md) compares against: one real converted block, and the same expert computed twice on the processor side from that block's own bytes — once in single precision, and once with every intermediate value and every running total rounded to half precision.

```sh
node packages/_onnx_experiments/tools/make_expert_block_graph_fixture.mjs \
  --blocks /tmp/olmoe-1b-7b-0924-expert-blocks --block 0
```

Two answers rather than one, because the gate needs a bracket instead of a threshold. The graph is a half precision graph and cannot reproduce the single precision answer, so any single tolerance written down by hand either fails the gate for rounding or passes it for anything. The two answers are both measured, and they move with the model.

## The conversion pipeline

Writes the on-disk layout milestone 3 asks for: the always-resident part in one file, and every expert block in another, each block one contiguous 256-byte-aligned region holding one expert's quantized weights, scales, and zero points together.

```sh
node packages/_onnx_experiments/tools/convert_mixture_of_experts_to_expert_blocks.mjs \
  --model Qwen3-30B-A3B \
  --output /tmp/qwen3-30b-a3b-expert-blocks
```

Two models are converted by the same code, because they are the same shape of problem and both name their expert tensors `model.layers.N.mlp.experts.M.{gate_proj,up_proj,down_proj}.weight`:

| `--model` | layers | experts each | one block | all blocks | resident part |
| --- | --- | --- | --- | --- | --- |
| `Qwen3-30B-A3B` | 48 | 128 | 2,727,936 bytes | 15.61 GB | 2.87 GB, 435 tensors |
| `OLMoE-1B-7B-0924` | 16 | 64 | 3,637,248 bytes | 3.47 GB | 0.89 GB, 147 tensors |

`--model` has no default on purpose. The pipeline reads tens of gigabytes and runs for the better part of an hour, and a default would let a mistyped command spend all of that converting the wrong model.

Nothing is downloaded whole. Every tensor is read out of the published safetensors shards by HTTP range request, sorted by where it sits in its shard and fetched in contiguous runs of at most 96 megabytes, so no copy of the source model is ever written to disk and the machine never holds more than one run at a time.

One block is nine parts — a quantized matrix, its scales, and its zero points, for each of `gate_proj`, `up_proj`, and `down_proj` — every part starting on a 256-byte boundary. The block for layer `l` and expert `e` starts at `(l * expertsForEachLayer + e) * blockByteLength`.

The pipeline verifies itself rather than being trusted: the written file length must be exactly the block count times the block length, and three blocks are read back and compared byte for byte against a fresh quantization of the same tensors.

### The published result

The full 48-layer conversion is published, so nothing needs to run this pipeline to use the blocks:

- [`jerome-etienne/webai-at-home-qwen3-30b-a3b-expert-blocks`](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-30b-a3b-expert-blocks), at the immutable revision [`d8db887997f90a003bea1f67478cfd7cc2a2b84a`](https://huggingface.co/jerome-etienne/webai-at-home-qwen3-30b-a3b-expert-blocks/tree/d8db887997f90a003bea1f67478cfd7cc2a2b84a).
- Converted from `Qwen/Qwen3-30B-A3B` at the pinned revision [`ad44e777bcd18fa416d9da3bd8f70d33ebb85d39`](https://huggingface.co/Qwen/Qwen3-30B-A3B/tree/ad44e777bcd18fa416d9da3bd8f70d33ebb85d39).
- `expert_blocks.bin` at 15.61 gigabytes, `resident.safetensors` at 2.87 gigabytes, and `manifest.json`.

Hugging Face answers an HTTP range request against that revision with status 206 and exactly the bytes asked for, so one expert can be fetched on its own without downloading the 15.61-gigabyte file. Three published blocks and the head of the published resident file were read that way and compared byte for byte against the local copies.

### The resident part

The resident part is copied unchanged, at BF16, and is not quantized. That is a deliberate limit of this milestone. Which resident tensors may be quantized depends on how each is used — an attention projection goes through a matrix multiplication and could be quantized exactly as an expert is, while the token embedding is looked up rather than multiplied and would need a different path — and deciding that needs the graph that consumes them, which is milestone 4. Copying them unchanged keeps every one of those choices open.
