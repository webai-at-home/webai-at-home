# MatMulNBits against a WebGPU buffer this project owns · Issue #169 milestone 0

The de-risking gate for [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169), which is the implementation plan for [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168): running a model whose weights are larger than the machine's graphics memory and larger than its main memory, by keeping the inactive weights on disk and loading only the ones that are active for the current step.

## The question

> Can ONNX Runtime Web execute a 4-bit quantized matrix multiplication, meaning the `MatMulNBits` operator, where the quantized weight tensor is a **runtime input backed by a WebGPU buffer this project owns**, and can the contents of that buffer be overwritten between calls without recreating the session?

Everything in issue #169 depends on that answer, and nothing else needs to exist to ask it. No model is downloaded and nothing is read from disk, because this gate needs neither and both would only add ways for it to fail for reasons that are not the question.

The problem it addresses is that every published ONNX export declares its weights as **initializers**, which makes them owned by the session, immutable, and loaded whole. That is the opposite of what issue #168 needs, because its whole design is about deciding at run time which weights are resident. Creating a session per token to exchange experts is not an alternative, because session creation costs graph parsing and shader compilation.

So this page builds a one-node ONNX model by hand, directly as protocol buffer bytes in the browser, with the weight tensors declared as **graph inputs** instead. There is no build step and no committed model file — [`src/onnx_graph_builder.ts`](src/onnx_graph_builder.ts) writes the 437 bytes itself.

## Result

**GATE GREEN.** Measured on 13 August 2026, in a live Chrome on Apple Silicon, on the `metal-3` adapter, with `onnxruntime-web` 1.27. All six phases pass.

| Phase | Result |
| --- | --- |
| 1 · a WebGPU device shared with ONNX Runtime Web | yes, but not the offered one — see below |
| 2 · a `MatMulNBits` graph whose weights are inputs, not initializers, loads at all | yes — the session exposes `expert_weight_quantized` as a runtime input |
| 3 · it computes the right answer from weights supplied on the processor side | yes — matched an independently recomputed product to 4.77e-7 |
| 4 · it computes the right answer from weights in a WebGPU buffer this project owns | yes — same 4.77e-7 |
| 5 · overwriting that buffer changes the answer, with no new session | yes — the two answers differ by 5.41, and each matches its own recomputed product |
| 6 · the same, at real Qwen3-30B-A3B expert size, with timings | yes — 16 experts swapped through one buffer |

Phase 5 is the gate itself. A runtime that quietly kept a prepacked copy of the first expert's weights would pass every phase above it and fail there, by returning the first answer twice. Every phase checks against a product recomputed in plain TypeScript by [`src/quantized_weights.ts`](src/quantized_weights.ts), because a phase that merely runs without throwing proves only that the tensors were accepted, not that the right bytes were read.

## Three findings that shape milestone four

**The residency layer does not own the device, it borrows it.** ONNX Runtime Web does not run on a device offered through `env.webgpu.device` before the first session exists. The assignment is accepted without error and the runtime then executes on a device of its own, so a buffer allocated on the offered device fails validation at bind-group creation with `[Buffer "…"] is associated with [Device], and cannot be used with [Device]` — and the run returns zeros rather than throwing where the mistake was made. The working order is the other way round: create a session first, then read the device back out with `await env.webgpu.device`, then allocate every buffer on that one. This cost the first red run of this gate, and it is the single most likely way for milestone four to waste a day.

**The device setter is write-once.** After the WebGPU backend has initialized, assigning `env.webgpu.device` throws `Cannot assign to read only property 'device'`. A second run on the same page hits this. Phase 1 now treats a failed offer as an ordinary outcome and borrows the device regardless, so the gate can be re-run without reloading.

**The default zero point of `MatMulNBits` at 4 bits is 8, not 0.** Phase 3 measures this rather than assuming it, by recomputing the same product both ways and reporting which one the runtime matched. The block layout it confirms is: `B` shaped `[N, ceil(K / block_size), block_size * 4 / 8]`, two values per byte with the even value in the low half, one scale per block, and a dequantized value of `(stored - 8) * scale`.

One more, smaller: **`Tensor.fromGpuBuffer` binds a whole buffer, not a range inside one.** The quantized weights and the scales therefore need one buffer each, even though they will arrive from disk as a single contiguous block. That is not a problem — `queue.writeBuffer` accepts a source offset, so one disk read still feeds two writes — but it settles the on-disk block layout question in milestone three.

## Timings, and what they are not

At the real dimensions of a Qwen3-30B-A3B expert projection — 768 by 2048, which is 0.75 megabytes of quantized weights plus 0.19 megabytes of scales, so **0.94 megabytes per expert swap**:

| Run | First swap, including shader compilation | 15 warm swaps: fastest / average / slowest |
| --- | --- | --- |
| 1 | 5.50 ms | 1.70 / 4.81 / 8.40 ms |
| 2 | 4.90 ms | 3.70 / 6.83 / 10.90 ms |
| 3 | 5.50 ms | 3.60 / 10.41 / 30.30 ms |

**Read these as a pessimistic upper bound, not as a projection**, for two reasons that the three runs make plain.

The measured span covers writing both weight tensors into the buffers, running the projection, **and reading the result back to the processor side**, because `session.run` returns processor-side data by default. That readback forces a synchronization with the graphics processing unit on every single projection. A real implementation does not do that: it sets `preferredOutputLocation` to `gpu-buffer` and chains the whole layer without ever touching the processor side.

And the spread is far too wide for these to be measuring bandwidth. The average moved from 4.81 to 10.41 milliseconds across three runs of identical work, and within one run the slowest warm swap was eight times the fastest. That is the signature of a synchronization stall, not of a transfer rate. The fastest warm swap seen at all — 1.70 milliseconds for 0.94 megabytes, so about 550 megabytes per second — is the more honest indication of what the path can do when nothing is waiting on it.

Removing the readback and re-measuring is therefore the first thing milestone four should do, before any conclusion is drawn about how fast this design can be.

For scale only, and carrying all of that: one Qwen3-30B-A3B token selects 8 experts across 48 layers with 3 projections each, so at these averages a **fully uncached** token would cost 5.5 to 12.0 seconds. Nothing about that range is load-bearing yet. It assumes a cache hit rate of zero, which no real residency policy would have, and it includes a synchronization a real implementation removes.

## Run

Start the dev server from the package root and open `matmulnbits-owned-webgpu-buffer-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

Nothing is downloaded and nothing is cached, so the gate runs in under a second from a cold page.

See [`../../README.md`](../../README.md) for the other experiments in this package.
