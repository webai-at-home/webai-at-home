# A converted expert block through a MatMulNBits graph · Issue #169 milestone 5

Two things had been proved separately and never together.

[Milestone 0](../matmulnbits-owned-webgpu-buffer-gate/README.md) proved that ONNX Runtime Web executes `MatMulNBits` against a WebGPU buffer this project owns, and that overwriting that buffer changes the answer with no new session. It did that with weights it invented, at single precision, with the fixed zero point of 8.

[Milestone 3](../../tools/README.md) then chose a different scheme, because it measured that scheme against real published weights: one zero point fitted to every block, and the scales stored at **half precision**, which saved 1.69 gigabytes across Qwen3-30B-A3B. It wrote 15.61 gigabytes to disk that way and published them.

`MatMulNBits` requires the activation and the scales to share an element type, so half precision scales force the whole projection to half precision. Nothing had run a real converted block through a real graph, and milestone 5 assembles a whole model on top of that assumption.

## The question

> Does ONNX Runtime Web compute the right expert output from the exact bytes the conversion pipeline wrote, read from a WebGPU buffer, with the scales at half precision and one zero point for every block — and does it give the same bits every time?

## Result

**GATE GREEN.** Measured on 13 August 2026, on Apple Silicon on the `metal-3` adapter, with `onnxruntime-web` 1.27, against block 0 of the converted `allenai/OLMoE-1B-7B-0924` — layer 0, expert 0, 3,637,248 bytes in nine parts.

| Phase | Result |
| --- | --- |
| 1 · the fixture: one real block, and an answer computed outside the browser | 3,637,248 bytes, and two 2048-value answers |
| 2 · a weightless expert graph loads, with all nine weight tensors as runtime inputs | yes — the graph is 1379 bytes, because it holds no weights at all |
| 3 · the right answer, nine tensors supplied from the processor side | 1.43e-2 from single precision, 4.8 times nearer than half precision throughout |
| 4 · the right answer, all nine read from WebGPU buffers this page owns | 1.43e-2, identical to phase 3 |
| 5 · the same bytes give the same answer bit for bit | yes — twice, after a refill, and across both paths |
| 6 · a negative control: the stored zero points replaced by the fixed 8 | 2.58 relative, 37 times the whole bracket |

## Phase 5 is the one milestone 5 rests on

Milestone 5 runs OLMoE-1B-7B twice, once with every expert resident and once through the residency layer, and requires the generated tokens to be **identical**. Being close is worth nothing there. One token whose two best candidates sit a hair apart turns any difference at all into a different word, and then into a different sentence.

So what has to hold is not accuracy but determinism: a buffer filled from disk and a buffer that was already there must produce the same bits. All 2048 values came back bit for bit the same across two runs, across a refill of the buffers with the same bytes, **and between the processor-side path and the WebGPU path**. That last one was not required and is worth recording: the residency layer changes nothing at all about the arithmetic.

## There is no tolerance in this gate, on purpose

A threshold chosen by hand is how a gate ends up passing something it should not. Pick 5e-3 here and the gate reads red for a reason that is only rounding; pick 5e-2 and it reads green whatever happens. Both are useless, and the first was written before this was noticed.

So the fixture carries the same expert computed **twice** on the processor side, from the block's own bytes: once in single precision, and once with every intermediate value and every running total rounded to half precision. Those are the two edges of a bracket, and the graph has to sit inside it with room to spare.

| | relative to the single precision answer |
| --- | --- |
| single precision | 0 |
| **the graph** | **1.43e-2** |
| half precision after every single addition | 6.91e-2 |
| the negative control | 2.58 |

The graph lands 4.8 times nearer the single precision answer than a half precision implementation that rounds after every addition. That is the expected shape: a graphics processor adds in a tree rather than one term after another, and a tree is more accurate. Both edges are measured, and they move with the model rather than staying put while it changes.

## What this gate is not

It is not a measurement of quantization loss. Both sides restore the same 4-bit values through the same half precision scales, so the 4 bits cancel out entirely. How much accuracy 4 bits costs was measured in [the milestone 3 quantization gate](../../tools/README.md), against a published `mlx-community` conversion of the same model.

The answer here is computed from the block's **own bytes** rather than from the original model, which is what keeps the question about how the bytes are read.

## Run

The three files under `fixture/` are generated and are not committed. Convert the model, which takes about ten minutes and writes 4.36 gigabytes:

```sh
node packages/_onnx_experiments/tools/convert_mixture_of_experts_to_expert_blocks.mjs --model OLMoE-1B-7B-0924 --output /tmp/olmoe-1b-7b-0924-expert-blocks
```

Take one block out of it, together with the two answers computed for it:

```sh
node packages/_onnx_experiments/tools/make_expert_block_graph_fixture.mjs --blocks /tmp/olmoe-1b-7b-0924-expert-blocks --block 0
```

Write the graph, sized from that conversion's own manifest rather than from numbers typed by hand:

```sh
packages/_onnx_experiments/tools/.venv/bin/python packages/_onnx_experiments/tools/expert_block_graph.py --manifest /tmp/olmoe-1b-7b-0924-expert-blocks/manifest.json --output packages/_onnx_experiments/public/expert-block-graph-gate/fixture/expert.onnx
```

Then start the dev server:

```sh
npm run dev --workspace @webai/onnx-experiments
```

Then open `expert-block-graph-gate/`. See [`../../README.md`](../../README.md) for the other experiments in this package.
