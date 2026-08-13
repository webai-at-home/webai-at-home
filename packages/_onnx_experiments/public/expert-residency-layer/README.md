# The expert residency layer — issue #169 milestone 4

Milestone 3 published Qwen3-30B-A3B as 6144 expert blocks of 2,727,936 bytes, 15.61 gigabytes in total, at a pinned revision. This page is the layer that decides which of those experts are in graphics memory at any moment, and measures what that decision costs. It is the part of this work that no framework provides.

Open it from `npm run dev --workspace @webai/onnx-experiments`, at `/expert-residency-layer/`. It downloads real weights and keeps them.

## What it does

1. **Storage.** Reports the quota and asks for the persistence grant.
2. **The block store.** Downloads the published `expert_blocks.bin` into the Origin Private File System by HTTP range request, writing each block at its exact offset. Resumable: only missing blocks are fetched.
3. **The residency layer.** Creates the staging ring and the expert cache, then runs a measurement loop of simulated tokens, recording the cache hit rate, the time stalled waiting for weights, and the time for each step.

## Measured on Apple Silicon, 16 gigabytes of unified memory, Chrome 151

The whole 15.61-gigabyte store on disk, all 48 layers, 6144 experts, a cache holding 393 of them — **6.4 per cent of the model**.

| | uniform | uniform, 4 pinned | skewed | skewed, 4 pinned |
| --- | --- | --- | --- | --- |
| cache hit rate | 6.0 % | 3.4 % | 33.1 % | **35.9 %** |
| read from disk for each step | 938.73 MB | 965.18 MB | 668.60 MB | 640.63 MB |
| stalled on weights for each step | 342.2 ms | 328.3 ms | 227.3 ms | 194.4 ms |
| whole step | 344.7 ms | 331.6 ms | 229.6 ms | 196.6 ms |
| stalled fraction | 99.3 % | 99.0 % | 99.0 % | 98.9 % |
| staging ring waited | 6.76 ms (1.9 %) | 5.40 ms (1.6 %) | 4.57 ms (2.0 %) | 3.07 ms (1.6 %) |
| steps each second | 2.90 | 3.02 | 4.36 | **5.09** |

The steps each second count **only the movement of weights**. No arithmetic has happened yet — there is no graph until milestone 5 — so these are an upper bound on what the finished thing can do, not a prediction of it.

### The cache does what a cache should

Under uniform selection the hit rate is 6.0 per cent against a resident fraction of 6.4 per cent. That is the least-recently-used policy landing exactly where it must against a distribution with no structure: with nothing to learn, a cache holding 6.4 per cent of the experts hits 6.4 per cent of the time. It is a floor, and it is worth having as a floor precisely because no policy can beat it.

The same cache reaches 33.1 per cent when the selection has structure to find.

### Pinning helps only where there is something to learn

Pinning four experts of each layer — 192 of the 393 slots, learned by counting a warm-up run — moves the skewed hit rate from 33.1 to 35.9 per cent and the rate from 4.36 to 5.09 steps each second. Against uniform selection the same pinning **halves the hit rate**, from 6.0 to 3.4 per cent, because it spends half the cache on experts that are no more likely than any other and leaves the least-recently-used policy working in what is left.

That is the honest shape of the result: pinning is a bet that the traffic is skewed, and it is paid for out of the cache.

### The staging ring is large enough, and the number to watch is time

Eight buffers, 20.81 megabytes, created once and recycled. Waiting for a buffer to finish being mapped again costs 3 to 7 milliseconds for each step, which is 1.6 to 2.0 per cent of the stall. The ring is not the bottleneck.

Counting the waits, which is what this page did at first, is useless: after the first lap of the ring *every* acquisition waits on a mapping promise, so the count is just the number of misses and always reads as though the ring were too small.

### What the throughput figures are not

938.73 megabytes in 342.2 milliseconds is 2.74 gigabytes each second, and the fastest run reached 3.30. That is above what milestone 2 measured for cold reads, and the reason is the machine: 16 gigabytes of memory against a 15.61-gigabyte store means the operating system's file cache serves an unknown share of the reads. During these runs the machine had about 4 gigabytes of inactive pages and 7.09 gigabytes of swap in use, so roughly three quarters of a uniformly-scattered read pattern must reach the disk — but not all of it. **Treat the throughput as an upper bound.**

Everything here is also noisy. Uniform with pinning read *more* bytes and still finished a step *faster* than uniform without it, which is only possible as measurement noise.

## Everything runs in one worker

The synchronous access handle of the Origin Private File System only exists inside a worker, and milestone 2 measured that what an expert costs to move is dominated by a copy on whichever thread does the moving. So the file handle, the WebGPU device, the staging buffers, and the cache all live in `src/residency_worker.ts`. An expert goes from disk into a mapped buffer and then into graphics memory without crossing a thread boundary once. The page thread owns no buffers and reads no files; it sends commands and prints numbers.

## Three decisions that came from measurements, not from taste

### The bytes never pass through `queue.writeBuffer`

Milestone 2 moved the same 64 megabytes two ways. `writeBuffer` cost 32.50 milliseconds and hid 1 per cent of itself inside a compute pass. Mapping a buffer, filling it, and moving it with `copyBufferToBuffer` cost 1.00 millisecond of queue work and hid 90 per cent. Almost everything `writeBuffer` charges is a copy on the calling thread, before the queue ever sees the bytes, and no queue can hide that.

So `_loadExpert` reads from the synchronous access handle **straight into the mapped range of a staging buffer**, unmaps it, and encodes nine `copyBufferToBuffer` calls. The bytes are written once.

### The cache is nine buffers for each expert, not one arena

Milestone 0 measured that ONNX Runtime Web binds a *whole* WebGPU buffer to a graph input through `Tensor.fromGpuBuffer()`, and cannot be given a range inside a larger buffer. So each of the nine parts of an expert — the quantized weights, the scales, and the zero points of `gate_proj`, `up_proj`, and `down_proj` — needs a buffer that begins exactly where that part begins. A cache of 393 experts is 3537 buffers, all created before the first step and never reallocated.

### The budget is given, never discovered

Milestone 2 tried to find the graphics memory ceiling by allocating until the device refused. On a machine with 16 gigabytes it took 64 gigabytes, wrote every byte of them, and was never refused; the operating system paged instead. A cache that sized itself by probing would find a limit that does not exist and then run at swap speed with no symptom but slowness.

## The reported storage quota is not a ceiling either

This was measured for this milestone, in Chrome 151, and it corrects what milestone 2 concluded:

| usage | reported quota | headroom |
| --- | --- | --- |
| 0.60 GB | 11.34 GB | 10.74 GB |
| 6.10 GB | 16.84 GB | 10.74 GB |
| 22.08 GB | 32.81 GB | 10.74 GB |

`navigator.storage.estimate().quota` is **usage plus a rolling headroom**, so it rises as the store fills. A 21.47-gigabyte file was written into the Origin Private File System without a single refusal, on a browser that reported an 11.34-gigabyte quota when the write began. The real fill of this page confirmed it: at 14.16 gigabytes of usage the reported quota had risen to 24.89.

Milestone 2 read that number as a capacity and sized its test file to half of it. That was wrong, and taken at face value it would have stopped this milestone on its first bullet, because 15.61 gigabytes never fits inside any quota Chrome reports before you start writing.

Persistence is a separate matter. It decides whether the browser may delete the store under disk pressure, not how much it holds. Chrome refused it for an ordinary tab on localhost — `persist()` returned false and the permission stayed at `prompt`. The page carries a manifest and a service worker so it can be installed, which is the one heuristic a page can act on.

## The first download, measured

Filling the store from the pinned revision took **17.1 minutes for 13.98 gigabytes, at 13.9 megabytes each second** by range request. It is resumable, and that was tested by accident when an editor reload killed the download at about 860 blocks: restarting it resumed at 640 and fetched only what was missing.

Seventeen minutes is the "carried alongside" concern of issue #169 meeting reality for the first time.

## The expert selection is synthetic

The residency layer needs to be told which experts each token wants. The real answer comes from the router of Qwen3-30B-A3B reading a real prompt, which needs the graph milestone 5 builds. Two sequences bracket it instead:

- **uniform** picks from all 128 experts of a layer with equal probability. This is the worst case any cache can meet; no policy helps against it, and its hit rate is a floor.
- **skewed** picks with a long-tailed weighting, so a minority of each layer's experts take most of the traffic. Routed mixtures of experts are generally observed to behave this way, but the exponent is chosen, not measured.

**Neither is Qwen3-30B-A3B.** Every hit rate above is quoted with the sequence that produced it, and none of them should be carried into the deliverable of issue #168 until the real router replaces this.

Pinning learns which experts to pin by counting a warm-up run, on a **different seed** from the timed steps. Learning a pinned set from the very tokens it is then measured against would report a hit rate no real run could reach. Even with a different seed it is optimistic, because both draws come from the same fixed distribution while real routing moves with the text.

### One bug worth recording

The first pinned run reported the skewed hit rate *falling* from 33.1 to 7.6 per cent. Halving the least-recently-used space cannot explain a drop that large, and it was not a finding: `ExpertSelection` drew each layer's expert preferences from the same generator as its token sampling, so giving the warm-up a different seed gave it a different set of favoured experts entirely. The pinned set was 192 experts chosen at random, eating half the cache. Which experts a layer prefers is now drawn from a fixed seed, because it is a property of the model, while the run seed decides only which of them each token draws.

Had the magnitude been smaller, "pinning hurts" would have been published as a result.
