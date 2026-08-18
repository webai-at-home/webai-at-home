# Gemma 4 E2B · hand-written WebGPU compute kernels

Runs [`google/gemma-4-E2B-it-qat-mobile-transformers`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers) in the browser on WebGPU compute kernels the page holds itself. There is no ONNX Runtime Web, no Transformers.js, and no LiteRT.js between the page and the graphics processor. This is [issue #207](https://github.com/webai-at-home/webai-at-home/issues/207).

The kernels and the whole model come from the vendored bundle in [`vendor/`](vendor/README.md), copied unchanged from the Hugging Face Space [`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/tree/main). The page around it is written here.

## Run

Start the development server from the package root and open `gemma4-e2b-webgpu-kernels/`:

```sh
npm run dev --workspace @webai/webgpu-experiments
```

The page needs WebGPU and says so when the browser has none.

## The three steps of the page

1. **Load the model.** The first load downloads `model.safetensors`, which is 2458111846 bytes, and writes it to a WebGPU device. The browser caches it, so later loads skip the download. The page reports how long the load took, how many bytes it moved, and how many compute shaders were compiled.
2. **Check the answers against a reference.** The page asks two questions whose answers are known, and passes only when both answers hold what they have to hold. It then asks the measurement question once and shows its answer beside the answer the Transformers.js page gave to the same question. The measurement stays locked while any check fails. WebGPU returns wrong numbers silently, which is what killed [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172), so a generation that runs to the end proves nothing on its own.
3. **Measure.** Two warm-up runs are thrown away, five runs are measured, and the page reports the middle figure of each measured quantity with the smallest and the largest beside it. It also reports whether the page was ever out of sight, because reading a hidden page lifts the slowdown Google Chrome puts on a hidden page.

Decoding is greedy. The vendored bundle offers no sampling options and always takes the highest scoring token, so the same question always gives the same answer, and the correctness check is reproducible.

## Comparing against the other two runtimes

The measurement question is the one [`packages/_onnx_experiments/public/gemma4-e2b-it/`](../../../_onnx_experiments/public/gemma4-e2b-it/README.md) asks, so that both pages are compared on one question. The answer that page gives is recorded in `TRANSFORMERS_JS_REFERENCE_ANSWER` in [`src/experiment_page.ts`](src/experiment_page.ts) and is shown beside this page's answer.

The two pages do not load the same weights: this page loads the quantization-aware trained mobile weights `google/gemma-4-E2B-it-qat-mobile-transformers`, and the Transformers.js page loads `onnx-community/gemma-4-E2B-it-ONNX` at `q4f16`. The comparison is therefore of two runtimes carrying two quantizations of one model, not of the runtime alone.

## Files

- [`src/main.ts`](src/main.ts) — the entry point.
- [`src/experiment_page.ts`](src/experiment_page.ts) — the three steps, and every constant the experiment reads.
- [`src/measurement_statistics.ts`](src/measurement_statistics.ts) — the smallest, middle, and largest figure of several runs.
- [`vendor/`](vendor/README.md) — the vendored bundle, where it came from, and its interface declared by hand.

## What has been measured so far

Measured on 2026-08-18, on the machine of this repository, in the in-application browser of Claude Code, with Google Chrome's WebGPU.

| | This page, on WebGPU compute kernels | `packages/_onnx_experiments`, on Transformers.js |
| --- | --- | --- |
| Weights | `google/gemma-4-E2B-it-qat-mobile-transformers` | `onnx-community/gemma-4-E2B-it-ONNX` at `q4f16` |
| Load, including writing the weights to the graphics processor | 197.6 s, for 2.12 GB reported by the bundle | 223.9 s |
| Time to the first token | 241 ms (238 – 242) | not reported by that page |
| Tokens per second | 64.0 tok/s (63.3 – 64.4) | not reported by that page, which reports 3.3 words per second over one run |
| Answer length | 51 tokens, the same in all five runs | not reported by that page |
| Compute shaders compiled | 27 | not applicable |

The five measured runs each produced exactly 51 tokens, which is what greedy decoding with no sampling options is expected to do.

**These figures cannot be trusted yet, and the page says so itself.** Every run above was made while the page was out of sight, which lifts the slowdown Google Chrome puts on a hidden page. Run step 3 again with this page in sight before quoting any figure from it. The page reports whether it was ever out of sight, right under the figures.

The two pages are not directly comparable on speed either. They load two different quantizations of Gemma 4 E2B, and the Transformers.js page reports words per second over a single run while this page reports tokens per second over five runs with the warm-up runs thrown away.
