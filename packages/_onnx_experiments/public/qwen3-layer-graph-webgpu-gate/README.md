# The Qwen3-30B-A3B layer graph on WebGPU

The de-risk gate milestone 6 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169) should have had before it assembled Qwen3-30B-A3B in a browser, written after the assembly produced words that are not words.

## What went wrong without it

`gate_qwen3_moe_non_expert_graph.py` checked the Qwen3-30B-A3B layer graph against the reference implementation and it matched to 7.875e-06, with a negative control 58072 times worse. `gate_moe_whole_model.py` then assembled all 48 layers, the head, the expert graph and the 6144 expert blocks, and generated `The capital of France is Paris. Which of the following is the capital of Germany?`.

Both of those run on the **processor**. The browser runs the identical files on WebGPU, and it generated this:

```
,…

ing一,

Mid=wickFdi
```

Every gate was green and the model was wrong, because no gate had ever run that graph on the execution provider the browser uses.

## What this page does

It loads one layer graph twice — once through the WebAssembly execution provider and once through WebGPU — and runs both on the same made-up numbers, for one token with an empty key and value cache and for one token with five of history. Both are the same file at single precision, so they can only differ by rounding unless one of them is computing something else.

There is no tolerance written down by hand. **OLMoE-1B-7B-0924 is the control**: milestone 5 generated correct text from its graphs on WebGPU three separate times, so whatever its two execution providers disagree by is what rounding looks like here. Qwen3-30B-A3B has to sit near it.

| model | key and value heads | worst difference between the two execution providers |
| --- | --- | --- |
| OLMoE-1B-7B-0924 | 16 for 16 query heads, so no repeat | 9.161e-05 |
| Qwen3-30B-A3B, as first built | 4 for 32 query heads, repeated eight times | **3.727e+01** — 406792 times the control |
| Qwen3-30B-A3B, after the fix | the same, built differently | **3.972e-05** — 0.4 times the control |

## What it found

The gate was red, so it went on to run a copy of the graph with every intermediate value promoted to an output, written by [`expose_graph_intermediates.py`](../../tools/expose_graph_intermediates.py), and walked them in the order the graph computes them. The first value the two execution providers disagreed about was `q_proj.output`, the very first matrix multiplication of the layer, and WebGPU's answer was **exactly zero**.

A matrix multiplication does not return zeros because it rounded differently. The browser console said why:

```
The number of storage buffers (9) in the Compute stage exceeds the maximum per-stage limit (8).
This adapter supports a higher maxStorageBuffersPerShaderStage of 10, which can be specified in
requiredLimits when calling requestDevice().
 - While calling [Device].CreateComputePipeline([ComputePipelineDescriptor "Concat"]).
```

Grouped-query attention gives each of the 4 key heads to 8 query heads. The graph did that with one `Concat` of eight copies of the same tensor. Eight inputs and one output is nine storage buffers, and Chrome creates its WebGPU device with a limit of eight — even though this adapter supports ten.

The failure is silent, and that is the part worth remembering. The pipeline does not compile, so the command buffer it belongs to is invalid, so the submission is dropped, so the values that should have come out of it read back as zeros. Nothing is thrown. The session is created, `run` resolves, tensors of the right shape come back, and the model generates fluent-looking nonsense.

## The fix

The eight copies are concatenated by doubling — `Concat(a, a)`, then `Concat(aa, aa)`, then `Concat(aaaa, aaaa)` — which binds three storage buffers at a time whatever the repeat count is. Concatenating a tensor with itself three times gives exactly what concatenating eight copies gives, because all eight copies are the same tensor, and re-running `gate_qwen3_moe_non_expert_graph.py` on the processor gave the same 7.875e-06 it gave before.

`build_moe_graphs.py` now refuses to write any graph holding a node that binds more than eight storage buffers, so this cannot come back silently.

## Running it

The artifacts are generated. See [the tools README](../../tools/README.md) for what writes them.

```sh
npm --workspace @webai/onnx_experiments run dev
```

Then open `/qwen3-layer-graph-webgpu-gate/`. When the gate is red it wants the debug copy as well:

```sh
packages/_onnx_experiments/tools/.venv/bin/python \
  packages/_onnx_experiments/tools/expose_graph_intermediates.py \
  --graph /tmp/qwen3-30b-a3b-graphs/layer_00.onnx \
  --output /tmp/qwen3-30b-a3b-graphs/layer_00.intermediates.onnx
```
