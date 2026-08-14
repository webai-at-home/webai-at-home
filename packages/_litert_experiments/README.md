# `@webai/litert-experiments`

Browser experiments for running one shard of a language model with LiteRT.js on WebGPU, so that LiteRT.js can be compared against ONNX Runtime Web as the runtime for the cluster's sharded pipeline. The package is private, is not part of the root build script, and no working package imports from it.

Everything here belongs to [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), the implementation plan of [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178).

## Run

From the repository root:

```sh
npm run dev --workspace @webai/litert-experiments
```

Open the local URL Vite prints. The home page links to every experiment. Every experiment except the milestone zero gate needs generated model files first; see [`tools/README.md`](tools/README.md).

## Build and type check

```sh
npm run typecheck --workspace @webai/litert-experiments
```

```sh
npm run build --workspace @webai/litert-experiments
```

`npm test --workspace @webai/litert-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.

## Experiments

- [`public/litertjs-webgpu-gate`](public/litertjs-webgpu-gate) — milestone zero. Does `@litertjs/core` load a `.tflite` graph and compile it for WebGPU at all?
- [`public/litertjs-cache-residency-gate`](public/litertjs-cache-residency-gate) — milestone one. Can a shard's own key/value cache stay on the graphics processor between repeated `model.run()` calls?
- [`public/litertjs-multiple-output-diagnosis`](public/litertjs-multiple-output-diagnosis) — part of milestone one. Names which graph shape WebGPU computes wrongly, one property at a time.
- [`public/qwen3-litert-shards`](public/qwen3-litert-shards) — milestone two. Every real `.tflite` graph of Qwen3-0.6B, and the whole model chained, checked element by element against PyTorch.
- [`public/qwen3-litert-resident-decode`](public/qwen3-litert-resident-decode) — the de-risking gate of milestone four. Does a real decoder shard's key/value cache survive staying on the graphics processor across a whole sequence of decode steps?
- [`public/qwen3-litert-workers`](public/qwen3-litert-workers) — milestone four. Generating tokens with the shards spread across separate browser pages, each keeping its own key/value caches.
- [`public/qwen3-litert-prefill`](public/qwen3-litert-prefill) — milestone five. One exported signature per prompt length, and what reading a whole prompt in one call is worth.
- [`public/onnxruntime-comparison`](public/onnxruntime-comparison) — milestone six. The same model and the same prompt through ONNX Runtime Web instead.
- [`public/runtime-comparison-interleaved`](public/runtime-comparison-interleaved) — milestone six, done properly. Both runtimes in one page load, alternating, because the same page gave anything from 7 to 25 tokens per second on different loads.

## Tools

Every exporter lives in [`tools/`](tools), one folder each, and writes the files an experiment reads. Model files, `.tflite` artifacts, and reference JSON files are never committed.

## What the development server adds

`vite.config.js` does four things a plain static server does not:

- serves the LiteRT.js WebAssembly files at `/wasm/`, out of `node_modules` rather than a copy under `public/`;
- serves the ONNX Runtime Web WebAssembly files the same way, for the milestone six comparison;
- answers HTTP range requests for the token embedding table, so that decoding one token reads 4096 bytes of a 622 megabyte file instead of all of it;
- relays frames between the milestone four worker pages at `/relay`, forwarding each frame to the one page named in its header and doing nothing else.
