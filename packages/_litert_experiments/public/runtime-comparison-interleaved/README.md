# Both runtimes in one page, alternating

Milestone six of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), done a second time and properly. [`../onnxruntime-comparison/`](../onnxruntime-comparison) measures ONNX Runtime Web on its own; this page measures **both runtimes inside one page load**, in alternating blocks.

## Why a second page was needed

The first page could not be compared against milestone four's LiteRT.js numbers, because it could not be compared against **itself**. Identical settings, identical code, successive page loads:

| page load | how it was driven | tokens per second, five successive runs |
| --- | --- | --- |
| A | read while running | 17.51 / 18.76 / 18.65 / 18.57 / 18.90 |
| B | read while running | 6.39 / 6.98 / 8.38 / 8.09 / 24.09 |
| C | left alone | 7.87 / 7.20 / 7.61 / 7.05 / 7.09 |
| D | left alone | 21.42 / 25.32 / 17.03 / 19.29 / 19.39 |

Within one load the figures are steady to a few per cent. Between loads they move by a factor of three, and no cause found so far accounts for it: releasing the sessions did not, leaving the page alone did not, and the tab was equally out of sight for all four.

A number taken from one page load and a number taken from another therefore say nothing about the two runtimes. Whatever this drift is, it is larger than the thing being measured.

## What this page does instead

It loads both runtimes and alternates: a LiteRT.js block, an ONNX Runtime Web block, a LiteRT.js block, and so on. Whatever makes the machine fast or slow at a given moment now moves both columns together, and the **ratio** between them survives it. Each block is printed on its own line, so a drift that is not common to both is visible rather than averaged away.

## What is compared

**One decoder layer, decoding one token.** That is the unit both sides can be reduced to, given that they are cut into different numbers of shards.

| | LiteRT.js | ONNX Runtime Web |
| --- | --- | --- |
| graph measured | `decoder_00-03` | shard 2 |
| decoder layers | 4 | 10 |
| what else the graph holds | nothing | nothing |
| key/value cache | stays on the graphics processor | copied out to JavaScript and back |
| weights | 32-bit floating point, about 62.9 megabytes a layer | four-bit, about 7.87 megabytes a layer |

ONNX shard 2 is the only one of the three that is nothing but decoder layers: shard 1 also carries the token embedding and shard 3 the final normalization and the language-model head, so neither of those divides cleanly by a layer count. All three shards still run, because the ONNX side has to generate real tokens to be checked.

Both sides are checked against the same PyTorch reference while they run: LiteRT.js against the per-position fingerprints in `decode_reference.json`, ONNX Runtime Web against the generated tokens.

## Run

Needs the LiteRT.js graphs from [`../../tools/qwen3_litert_shard_export/`](../../tools/qwen3_litert_shard_export) and the ONNX shards from `packages/_onnx_experiments/tools/qwen3_shard_export/`, as [`../onnxruntime-comparison/README.md`](../onnxruntime-comparison/README.md) describes.

```sh
npm run dev --workspace @webai/litert-experiments
```

Open `runtime-comparison-interleaved/`, or add `?autorun=1` to start on load and then leave the page alone.

LiteRT.js is loaded before ONNX Runtime Web, because it needs one contiguous block of its WebAssembly heap the size of the whole graph and that is the harder allocation of the two to satisfy.
