# LiteRT.js WebGPU gate

Milestone zero of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). The first question the whole investigation turns on: does `@litertjs/core` load a `.tflite` graph and compile it for WebGPU at all, in the browser this project targets?

No model, no shards, no key/value cache. One linear layer, exported from PyTorch, loaded with `loadAndCompile({ accelerator: 'webgpu' })`, run once, and read back. Whether a real transformer converts is milestone two's question; mixing the two would make a failure impossible to attribute.

The page answers, with raw output rather than a summary:

- whether `loadLiteRt()` finds its WebAssembly files when the page is served by Vite;
- whether `accelerator: 'webgpu'` genuinely compiles or silently falls back;
- what `getInputDetails()` and `getOutputDetails()` report, and whether the boundary types are restricted to 32-bit floating point and 32-bit integer as the documentation says;
- what `await output.data()` costs for one hidden state, at both 1024 values and 4096.

## Run

Write the graphs first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/trivial_shard_export/export_trivial_graph.py packages/_litert_experiments/public/litertjs-webgpu-gate/models
```

Then start the development server and open `litertjs-webgpu-gate/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

The graphs are generated artifacts of up to 64 mebibytes and are not committed. See [`../../tools/trivial_shard_export/`](../../tools/trivial_shard_export) for the exporter.

## Why 1024 and 4096

1024 is the hidden size of Qwen3-0.6B, the chosen first model. 4096 is the hidden size the worked example in [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178) uses. Both are measured, because that worked example is the source of the 16 kibibyte hidden state figure this milestone had to correct.
