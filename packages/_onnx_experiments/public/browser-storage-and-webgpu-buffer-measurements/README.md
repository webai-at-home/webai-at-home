# Browser storage and WebGPU buffer measurements · Issue #169 milestone 2

Milestone 2 of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169), which is the implementation plan for [issue #168](https://github.com/webai-at-home/webai-at-home/issues/168): running a model whose weights are larger than the machine's graphics memory and larger than its main memory, by keeping the inactive weights on disk and loading only the ones that are active for the current step.

Milestone 0 proved that ONNX Runtime Web will multiply against a WebGPU buffer this project owns and will reread that buffer after it is overwritten. Milestone 1 measured that Qwen3-30B-A3B keeps only 0.81 gigabytes resident and can stream the other 15.19 gigabytes. This page measures everything underneath both of those, and unlike milestone 0 it is not a gate — it produces a table of numbers, and three of those numbers change what milestone 4 has to be.

No model is downloaded and ONNX Runtime Web is never loaded. The page owns its own WebGPU device outright, so the device-borrowing finding of milestone 0 does not apply here.

## The table of measurements

Measured on 13 August 2026, on Apple Silicon with 16 gigabytes of unified memory and 167 gigabytes free on disk, in the in-application browser of Claude Code. **The quota row is not representative and the throughput rows are noisy** — see "What these numbers are not" below.

| | |
| --- | --- |
| storage quota | 3.15 gigabytes |
| persistence granted, an ordinary browser tab | no, and the permission reports `denied` |
| write throughput into the Origin Private File System | 310 to 438 megabytes each second |
| read throughput, expert-sized blocks at shuffled offsets | 1.05 to 4.67 gigabytes each second |
| one expert block, fastest read | 0.40 to 1.70 milliseconds |
| largest single WebGPU buffer | 4.00 gigabytes |
| largest storage buffer binding | 4.00 gigabytes |
| one expert, disk into a WebGPU buffer | 1.76 to 7.81 milliseconds on average, 1.30 at best |
| `writeBuffer` and a compute pass, overlap | 1 to 27 per cent |
| `copyBufferToBuffer` from a mapped buffer and a compute pass, overlap | 36 to 90 per cent |
| the same bytes, `writeBuffer` against a staged copy | 3.1 to 5.1 times cheaper staged, 33 to 131 times cheaper on the queue |
| WebGPU buffer memory one page may ask for | 64.00 gigabytes, without ever being refused |
| WebGPU buffer memory one page may keep, every byte written | 64.00 gigabytes, without ever being refused |

## Three findings that change milestone 4

**`writeBuffer` is the wrong way to move an expert, and milestone 0 used it.** The clearest run, on a quiet machine, moved the same 64 megabytes two ways:

| | `writeBuffer` | mapped buffer plus `copyBufferToBuffer` |
| --- | --- | --- |
| on the page's own thread | — | 9.60 ms mapping and filling |
| work for the queue | 32.50 ms | **1.00 ms** |
| total | 32.50 ms | 10.60 ms |
| hidden inside a 41.00 ms compute pass | **1 per cent** | **90 per cent** |

The two paths submitted alongside that compute pass finished in 73.30 milliseconds and 41.10 milliseconds. The staged copy is very nearly free: it added 0.10 milliseconds to a pass that took 41.00 on its own. Most of what `writeBuffer` costs is a copy on the page's own thread, before the queue ever sees the bytes, and no queue can hide that — which is why the naive path takes turns with the multiplication however the work is submitted. Milestone 4 should read each expert straight into a mapped staging buffer, and the ring of staging buffers it was already going to keep is exactly the right shape for it.

**WebGPU never refuses, so the residency layer cannot discover its own budget.** This was meant to be a simple probe: take 256-megabyte buffers until allocation fails, and report the ceiling. On a machine with 16 gigabytes of unified memory it took **64 gigabytes and wrote every byte of all of it** without a single out-of-memory error, in 62 seconds. Checking the machine afterwards showed 6.6 gigabytes of swap in use, so the memory was genuinely committed and the operating system paged it out rather than the device saying no. A first pass that only touched the first and last 4096 bytes of each buffer reached the same 64 gigabytes in 57 milliseconds, which is the same answer arrived at a thousand times faster. Both loops stopped at the safety limit this page sets for itself, not at any limit of the machine.

The consequence for milestone 4 is direct. A residency layer that takes too much graphics memory is never told so. It does not fail, it gets slower, and it gets slower in the way that is hardest to attribute — the loads still complete, the arithmetic is still correct, and the only symptom is that the whole thing crawls. The budget has to be given to the residency layer as a number, because it cannot find one by asking.

**Reopening the file per block cost 7.8 times the throughput, and it was my own mistake.** The first version of this page opened a synchronous access handle for every block it read. That reported 164.60 megabytes each second through the worker and made the worker look *slower* than an ordinary asynchronous read on the page's own thread. Keeping one handle open across reads, which is what a residency layer would do anyway, moved the same measurement to 1.25 gigabytes each second. It is recorded here because it is the kind of error that survives review — nothing threw, nothing was wrong, and the number was simply the cost of something the real system never pays.

## What these numbers are not

**The quota is not representative.** 3.15 gigabytes on a machine with 167 gigabytes free is not what an ordinary Chrome profile reports, which is a large share of the free space on the disk. It is the mark of a private window, a restricted profile, or an embedded browser. The page now says so itself when the quota is below 10 gigabytes. **The quota and the persistence rows have to be taken again in an ordinary Chrome window before either is quoted anywhere**, and the persistence row has to be taken a third time with the page installed as a Progressive Web Application, which is why this folder carries a manifest, an icon, and a service worker that caches nothing.

**The read throughput is not a disk measurement.** The page reads the same shuffled blocks twice and compares. In every run here the second pass was no faster than the first, which means the first pass never reached the disk: the whole 1.27-gigabyte file was already held in the memory the operating system keeps for files. A real model of 16 gigabytes will not fit there. Every read number above is an upper bound, and the residency layer will meet slower reads.

**Everything is noisy, by a factor of two to four.** Write throughput moved between 310 and 438 megabytes each second across runs of identical work, read throughput between 1.05 and 4.67 gigabytes each second, and one expert between 1.76 and 7.81 milliseconds. The overlap probe warms up and keeps the fastest of three runs for exactly this reason; the disk phases do not, and their spread is what it is. The table above therefore gives ranges, and the finding about `writeBuffer` quotes one clean run rather than an average of runs taken while the machine was busy.

**The overlap fraction is the weakest number on the page.** When the staged copy takes 1.00 millisecond and the compute pass takes 41.00, the arithmetic that turns them into an overlap fraction divides by a number close to the measurement noise, and that is why the same measurement reported 36 per cent on a busy machine and 90 per cent on a quiet one. What is solid across every run is the ordering and the size of the gap: the queue-side cost of the staged copy was 33 to 131 times smaller than `writeBuffer` every time. Build on the ratio, not on the fraction.

## For scale, carrying all of that

One Qwen3-30B-A3B token selects 8 experts across 48 layers with 3 projections each, so 1152 expert blocks. At the averages measured here that is 2.0 to 9.0 seconds of loading for a **fully uncached** token, and 1.5 seconds at the fastest rate seen. As in milestone 0, nothing about that range is load-bearing: it assumes a cache hit rate of zero, which no real residency policy would have, and it uses the `writeBuffer` path that the first finding above says to abandon.

## Run

Start the dev server from the package root and open `browser-storage-and-webgpu-buffer-measurements/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The page writes a test file of about 1.27 gigabytes into the Origin Private File System, reads it back, and removes it again at the end of the run. When the quota does not allow that much, it writes as much as half the free quota allows and says so.

The allocation ceiling probe is behind its own button on purpose. It commits tens of gigabytes and will push the machine into swap. Run the six measurements first, read them, and only then press the second button.

See [`../../README.md`](../../README.md) for the other experiments in this package.
