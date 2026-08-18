# Gemma 4 E2B · hand-written WebGPU compute kernels

Runs [`google/gemma-4-E2B-it-qat-mobile-transformers`](https://huggingface.co/google/gemma-4-E2B-it-qat-mobile-transformers) in the browser on WebGPU compute kernels the page holds itself. There is no ONNX Runtime Web, no Transformers.js, and no LiteRT.js between the page and the graphics processor. This is [issue #207](https://github.com/webai-at-home/webai-at-home/issues/207).

The kernels and the whole model come from the vendored bundle in [`vendor/`](vendor/README.md), copied unchanged from the Hugging Face Space [`webml-community/gemma-4-webgpu-kernels`](https://huggingface.co/spaces/webml-community/gemma-4-webgpu-kernels/tree/main). The page around it is written here.

## Run

Start the development server from the package root and open `gemma4-e2b-webgpu-kernels/`:

```sh
npm run dev --workspace @webai/webgpu-experiments
```

The page needs WebGPU and says so when the browser has none.

## What the page does

The page reads the same way as [`packages/_onnx_experiments/public/qwen3_5-2b/`](../../../_onnx_experiments/public/qwen3_5-2b/README.md), whose look and whose default question it copies, so that the two experiments can be read side by side. Its stylesheet is a copy of that page's stylesheet, with the rules for the two extra panels added at the end. Nothing is shared between the two packages: each experiment is standalone, and copying is preferred over coupling them.

The weights start downloading as soon as the page opens, so that the first load does not wait for a button press. The first load moves `model.safetensors`, which is 2458111846 bytes, and writes it to a WebGPU device. The browser caches it, so later loads skip the download. **Model load** reports how long that took.

**Run inference** answers whatever question is in the prompt box, streams the answer into the page, and reports **Generation** and **Output rate** for that one run. The question can be changed freely. One run is a demonstration, not a measurement, and the page says so after every run.

**Run the correctness check** asks two questions whose answers are known, and passes only when both answers hold what they have to hold. It then asks the default question and shows its answer beside the answer the Transformers.js page gave to the same question. WebGPU returns wrong numbers silently, which is what killed [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172), so a generation that runs to the end proves nothing on its own.

**Run the measurement** is locked until every correctness check has passed. It throws two warm-up runs away, measures five runs, and reports the middle figure of each quantity with the smallest and the largest beside it. Under the figures it says whether they can be trusted: it names the page being out of sight, and it names the question having been changed away from the default, because either one makes the figures impossible to put beside the recorded figures of the other runtimes.

Decoding is greedy. The vendored bundle offers no sampling options and always takes the highest scoring token, so the same question always gives the same answer, and the correctness check is reproducible.

## Comparing against the other two runtimes

The default question is the one [`packages/_onnx_experiments/public/gemma4-e2b-it/`](../../../_onnx_experiments/public/gemma4-e2b-it/README.md) asks, so that both pages are compared on one question. The answer that page gives is recorded in `TRANSFORMERS_JS_REFERENCE_ANSWER` in [`src/experiment_page.ts`](src/experiment_page.ts) and is shown beside this page's answer.

The two pages do not load the same weights: this page loads the quantization-aware trained mobile weights `google/gemma-4-E2B-it-qat-mobile-transformers`, and the Transformers.js page loads `onnx-community/gemma-4-E2B-it-ONNX` at `q4f16`. The comparison is therefore of two runtimes carrying two quantizations of one model, not of the runtime alone.

## Files

- [`src/main.ts`](src/main.ts) — the entry point.
- [`src/experiment_page.ts`](src/experiment_page.ts) — the loading, the single run, the correctness check, the measurement, and every constant the experiment reads.
- [`src/page_markup.ts`](src/page_markup.ts) — the markup of the page.
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

**These figures cannot be trusted yet, and the page says so itself.** Every run above was made while the page was out of sight, which lifts the slowdown Google Chrome puts on a hidden page. Press **Run the measurement** again with this page in sight before quoting any figure from it. The page says right under the figures whether they can be trusted.

The two pages are not directly comparable on speed either. They load two different quantizations of Gemma 4 E2B, and the Transformers.js page reports words per second over a single run while this page reports tokens per second over five runs with the warm-up runs thrown away.
