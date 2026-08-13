# Tools

Three folders, split by what the tools inside them work on.

| folder | what it holds | language |
| --- | --- | --- |
| [`qwen3_shard_export/`](qwen3_shard_export/) | the older, separate experiment: Qwen3-0.6B split into three graphs, and the check that they still agree with the original | both |
| [`weight_conversion/`](weight_conversion/) | reads the **published** weights over HTTP range requests and writes this project's on-disk layout: the resident part in one file, one aligned block for each expert | JavaScript |
| [`model_graphs/`](model_graphs/) | builds every ONNX graph the browser runs — everything that is **not** an expert weight — and checks each one against the reference implementation | Python |

The split between the last two is where the design's seam is. `weight_conversion/` decides what the bytes of an expert look like on disk; `model_graphs/` decides what reads them. Neither imports from the other. They meet only through the files on disk and the `manifest.json` and `graphs.json` that describe them, which is what lets a browser hold the weights and let ONNX Runtime Web do only the arithmetic.

Everything except `qwen3_shard_export/` belongs to [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169). Each folder has its own `CONTEXT.md`.

The Python tools share one virtual environment at `tools/.venv`, created from `tools/requirements.txt`. Both live at this level rather than inside a folder, because two folders hold Python.

```sh
python3.13 -m venv packages/_onnx_experiments/tools/.venv
packages/_onnx_experiments/tools/.venv/bin/pip install -r packages/_onnx_experiments/tools/requirements.txt
```

## Qwen3 shard exporter

The browser page expects three files in
`packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards/`. The files are generated artifacts and
are intentionally ignored by Git because they are about 1.7 GB in total.

Download the source model and export the three shards, with the virtual environment created above:

```sh
curl -L --fail --output /tmp/qwen3-model_q4f16.onnx \
  https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_q4f16.onnx
packages/_onnx_experiments/tools/.venv/bin/python packages/_onnx_experiments/tools/qwen3_shard_export/split_qwen3_onnx.py \
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
npx tsx packages/_onnx_experiments/tools/qwen3_shard_export/verify_qwen3_shards.ts
```

Pass the original monolithic model as an optional argument to compare the first
shard pipeline result against the original graph:

```sh
npx tsx packages/_onnx_experiments/tools/qwen3_shard_export/verify_qwen3_shards.ts /tmp/qwen3-model_q4f16.onnx
```

## Qwen3-30B-A3B residency measurement

Answers milestone 1 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169): does the always-resident part of Qwen3-30B-A3B fit in the graphics memory of the target machine? Streaming only helps for the part of a model that is inactive most of the time, so if the part that must stay resident does not fit on its own, the approach of [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168) stops there.

```sh
npx tsx packages/_onnx_experiments/tools/weight_conversion/measure_qwen3_moe_residency.ts
```

The tool downloads no model. It reads the real shape of every one of the 18867 published tensors out of the safetensors headers over HTTP range requests, which is about 20 megabytes rather than the 57 gigabytes of weights, and classifies each tensor as an expert weight or as always resident. Nothing is trusted to arithmetic done from `config.json`.

## Qwen3-30B-A3B quantization gate

Answers the question milestone 3 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169) has to answer before any conversion is worth running: does 4-bit block quantization in the layout `MatMulNBits` reads keep a real Qwen3-30B-A3B expert usable, and which block size and which scheme should the conversion write?

```sh
npx tsx packages/_onnx_experiments/tools/weight_conversion/gate_quantize_real_expert.ts
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
  packages/_onnx_experiments/tools/model_graphs/gate_olmoe_expert_decomposition.py
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
  packages/_onnx_experiments/tools/model_graphs/gate_olmoe_non_expert_graph.py
```

The gate checks the graph plus separately computed experts against the reference layer, over four cases: one token and several, each with an empty key and value cache and with one already holding history. The worst case is **2.056e-06** relative, inside a tolerance of 2e-5, and the returned cache matches the reference cache every time.

The attention bias is a graph input rather than a mask built into the graph. Decoding one token at a time needs no mask at all, since that token may attend to the whole history. The gate's negative control replaces the causal bias with zeros for a multi-token case and the difference jumps to **3.872e-01**, 188288 times the worst real case, which is what makes the other four rows worth believing.

## The Qwen3-30B-A3B non-expert graph, and its gate

`qwen3_moe_non_expert_graph.py` is to Qwen3-30B-A3B what `olmoe_non_expert_graph.py` is to OLMoE-1B-7B-0924, and it exists as a second file rather than a flag on the first because four things differ and every one of them produces fluent-looking nonsense when it is wrong:

- **Grouped-query attention.** 32 query heads read 4 key and value heads, so each key head serves eight query heads. The cache holds the four, not the thirty-two.
- **Per-head normalization.** The query and key normalizations run across one 128-wide head, after the split. OLMoE runs them across the whole 2048-wide vector, before it.
- **A declared head width.** `head_dim` is 128 while hidden size over head count is 64, so the query projection widens to 4096 rather than staying at 2048.
- **Renormalized routing.** `norm_topk_prob` is true, so the eight chosen weights are divided by their own sum. OLMoE leaves them alone.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/model_graphs/gate_qwen3_moe_non_expert_graph.py
```

The gate checks the graph plus separately computed experts against the reference layer, over four cases. The worst is **7.875e-06** relative, inside a tolerance of 2e-5, and the returned cache matches the reference cache every time. Its negative control replaces the causal bias with zeros and the difference jumps to **4.573e-01**, 58072 times the worst real case.

`onnx_graph_helpers.py` holds what the two layer graph builders share — the opset and intermediate representation versions, `initializer`, `root_mean_square_normalization`, `rotate_half` and `apply_rotary`. It was extracted from `olmoe_non_expert_graph.py`, and re-running the OLMoE gate afterwards gave identical numbers.

**This gate runs on the processor, and that is not enough.** See [the WebGPU layer graph gate](../public/qwen3-layer-graph-webgpu-gate/README.md), which found a graph that passes every number here and returns zeros in a browser.

## The graphs, and the whole model assembled

`build_moe_graphs.py` builds everything that is not an expert, with its weights baked in as ordinary initializers: one graph for each layer, the final normalization and language model head as `head.onnx`, the weightless `expert.onnx`, the token embedding, and a `graphs.json` describing all of it.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/model_graphs/build_moe_graphs.py \
  --model OLMoE-1B-7B-0924 \
  --blocks /tmp/olmoe-1b-7b-0924-expert-blocks \
  --output /tmp/olmoe-1b-7b-0924-graphs
```

| `--model` | layer graphs | head | embedding | in total |
| --- | --- | --- | --- | --- |
| `Qwen3-30B-A3B` | 48 × 73.02 MB | 1187.01 MB | 593.50 MB at BF16 | 5.16 GB |
| `OLMoE-1B-7B-0924` | 16 × 64.54 MB | 393.00 MB | 393.00 MB at single precision | 1.78 GB |

It reads the `resident.safetensors` the conversion pipeline wrote rather than fetching the published weights again, so both halves of the split are provably from one conversion. It reads the published `config.json` at the **pinned** revision for the two numbers no shape on disk carries — the normalization epsilon and the rotary theta — rather than letting the library's defaults stand in silently. And it refuses to build unless that configuration describes the blocks it was pointed at, because two halves that disagree about a size still load and still generate, and what they generate is nonsense.

It also refuses to write a graph holding a node that binds more than eight storage buffers. WebGPU limits how many one compute shader may bind, Chrome creates its device at eight, and a node over that limit fails by returning zeros rather than by raising anything. Milestone 6 lost an afternoon to one such node before this check existed.

Single precision throughout for the arithmetic. The layer graphs were gated at single precision, correctness is what these milestones are about, and halving the files would put every number those gates measured back in doubt. The Qwen3-30B-A3B embedding table is the one exception: it is looked up rather than multiplied, so it is kept at BF16 and widened one row at a time, which is an exact sixteen-bit shift and saves 593 megabytes.

`gate_moe_whole_model.py` then assembles the whole thing outside the browser and makes it generate.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/model_graphs/gate_moe_whole_model.py \
  --graphs /tmp/qwen3-30b-a3b-graphs --blocks /tmp/qwen3-30b-a3b-expert-blocks
```

The gates before it each check one piece against a reference. None of them checks the **wiring**: every layer in the right order, the cache carried from step to step, the routing weights on the right experts, the final normalization before the head. Nothing here can check that against a reference, because the reference is 13.8 gigabytes of weights for the smaller model and 57 for the larger, on a machine with 16 gigabytes. But wiring mistakes have a very loud symptom, so the check is to generate and to read what comes out:

```
OLMoE-1B-7B-0924:  The capital of France is Paris.

                   The capital of the United States is Washington
Qwen3-30B-A3B:     The capital of France is Paris. Which of the following is the capital of Germany?
```

OLMoE-1B-7B-0924 does 12 tokens in 10.0 seconds on the processor, with 2048 expert blocks read and no cache at all, which is 7104 megabytes. Qwen3-30B-A3B does 12 tokens in 45.5 seconds, with 6144 blocks read, which is 15984 megabytes.

It runs the same graphs the browser runs — but on the processor, and the browser on the graphics processor. That difference is not a detail. A graph can pass this gate and still be wrong in a browser, which is what happened, and [the WebGPU layer graph gate](../public/qwen3-layer-graph-webgpu-gate/README.md) is the answer to it.

## Exposing what a graph computes in between

`expose_graph_intermediates.py` writes a copy of a graph that also returns every value its nodes produce.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/model_graphs/expose_graph_intermediates.py \
  --graph /tmp/qwen3-30b-a3b-graphs/layer_00.onnx \
  --output /tmp/qwen3-30b-a3b-graphs/layer_00.intermediates.onnx
```

Two things that disagree about a graph's answer disagree at some one node first, and every node after that one is only carrying the mistake forward. A graph whose only outputs are its real outputs cannot say which node that was. This one can: `layer_00.onnx` returns 5 values and its copy returns 71.

Nothing is renamed and no node is touched — the output list grows and that is the whole change — so a divergence found in the copy is a divergence in the original. The copy is for reading rather than for running a model, because a value that has to be returned cannot be folded away, so it defeats every fusion the runtime would otherwise do and its timings mean nothing.

## The expert graph, and the fixture that checks it

`expert_block_graph.py` builds one expert as an ONNX graph holding **no weights at all**. All nine tensors of an expert — a quantized matrix, its scales, and its zero points, for each of `gate_proj`, `up_proj`, and `down_proj` — arrive as graph inputs, in exactly the order the conversion pipeline writes them into a block. The whole file is 1379 bytes.

The arithmetic inside is half precision and the seam is single precision. That is forced rather than chosen: `MatMulNBits` requires the activation and the scales to share an element type, and milestone 3 stored the scales at half precision because that saved 1.69 gigabytes. Two `Cast` nodes keep that consequence inside the one file where it is written down.

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/model_graphs/expert_block_graph.py \
  --manifest /tmp/olmoe-1b-7b-0924-expert-blocks/manifest.json \
  --output packages/_onnx_experiments/public/expert-block-graph-gate/fixture/expert.onnx
```

The sizes come out of the conversion's own manifest rather than off the command line, because a graph built to sizes that do not match the blocks on disk loads perfectly well and then reads the wrong bytes.

`make_expert_block_graph_fixture.ts` writes what [the expert block graph gate](../public/expert-block-graph-gate/README.md) compares against: one real converted block, and the same expert computed twice on the processor side from that block's own bytes — once in single precision, and once with every intermediate value and every running total rounded to half precision.

```sh
npx tsx packages/_onnx_experiments/tools/weight_conversion/make_expert_block_graph_fixture.ts \
  --blocks /tmp/olmoe-1b-7b-0924-expert-blocks --block 0
```

Two answers rather than one, because the gate needs a bracket instead of a threshold. The graph is a half precision graph and cannot reproduce the single precision answer, so any single tolerance written down by hand either fails the gate for rounding or passes it for anything. The two answers are both measured, and they move with the model.

## The conversion pipeline

Writes the on-disk layout milestone 3 asks for: the always-resident part in one file, and every expert block in another, each block one contiguous 256-byte-aligned region holding one expert's quantized weights, scales, and zero points together.

```sh
npx tsx packages/_onnx_experiments/tools/weight_conversion/convert_mixture_of_experts_to_expert_blocks.ts \
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
