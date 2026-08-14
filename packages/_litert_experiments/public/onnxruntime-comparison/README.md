# The comparison against ONNX Runtime Web

Milestone six of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). The three ONNX shards of Qwen3-0.6B that [`packages/_onnx_experiments`](../../../_onnx_experiments) already uses, run on the same prompt and against the same PyTorch reference as milestones four and five, so that the two runtimes can be put in one table.

## The two sides do not hold the same weights

Issue #179 says this comparison is "the same weights, the same shard boundaries, and the same activation sizes, with only the runtime changed". It is not, and the first section of the page reads that difference off the running sessions rather than asserting it.

| | ONNX Runtime Web | LiteRT.js |
| --- | --- | --- |
| weights | four-bit, packed into `uint8` with 16-bit floating point scales | 32-bit floating point |
| everything else | 16-bit floating point | 32-bit floating point |
| attention | one fused `GroupQueryAttention` for each decoder layer | built out of separate operations |
| rotary embedding | one fused `RotaryEmbedding` | tables passed in as tensors |
| shards | 3, cut at layers 9 and 19 | 7 decoder shards of 4 layers, plus 3 head chunks |
| on disk | 860 mebibytes | about 2.4 gigabytes |
| prompt lengths | one graph serves every length | one graph per length |

Read every measurement on this page in that light. A tokens-per-second gap between the two has at least two causes and this page alone cannot separate them.

The one thing that *is* identical is the bytes crossing a shard boundary: ONNX Runtime Web hands the next shard two 16-bit floating point tensors of 1024 values, and LiteRT.js hands it one 32-bit floating point tensor of 1024 values. Both are 4096 bytes for one token.

## Run

The three ONNX shards are the generated artifacts of [`packages/_onnx_experiments/tools/qwen3_shard_export/`](../../../_onnx_experiments/tools/qwen3_shard_export), about 860 mebibytes in total, and are not committed. Write them there first. The development server reads them off disk and serves them at `/onnxruntime-comparison/shards/`; set `QWEN3_ONNX_SHARD_DIRECTORY` to read them from somewhere else. Nothing here imports any code from that package.

The references come from `/qwen3-litert-shards/models`, written by the milestone four and five exporters, so both runtimes are checked against the same PyTorch numbers.

```sh
npm run dev --workspace @webai/litert-experiments
```

| Setting | What it selects |
| --- | --- |
| `?cacheLocation=cpu` | The default. Every key/value cache is copied out to JavaScript on every call and passed back in, which is what `packages/_onnx_experiments` and the cluster do today. |
| `?cacheLocation=gpu-buffer` | Every key/value cache stays on the graphics processor between calls, which is what milestone four does with LiteRT.js. |
| `?executionProvider=wasm` | Runs the same graphs on the central processor. |

## Two measurement hazards this page had to fix

- **Release the sessions.** The first four runs of this page disagreed with each other by a factor of five for the same settings. Each page load was leaving its 860 mebibytes of graphics-processor buffers behind, so the load after it measured a machine that was already paging. With `session.release()` at the end of a run, five successive runs agree within two per cent.
- **Warm up far longer than seems reasonable.** With four positions thrown away, the first measured run came out at 2.63 tokens per second and the third at 7.34. With a whole 31-position decode thrown away, the first measured run came out at 7.20 and the third at 24.98. Every run is printed, so a figure still climbing can be seen to be still climbing.

The page also reports whether it was out of sight at any moment, and voids its own figures if it was. Chrome slows a hidden tab down.
