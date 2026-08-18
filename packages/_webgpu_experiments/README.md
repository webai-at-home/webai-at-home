# `@webai/webgpu-experiments`

Browser experiments that run a language model on WebGPU compute kernels the page holds itself, with no model runtime between the page and the graphics processor. The package is private and is outside the root build script, because each experiment is an independent browser application.

Every other experiment in this repository puts a runtime in between: `packages/_onnx_experiments` uses ONNX Runtime Web and Transformers.js, and `packages/_litert_experiments` uses LiteRT.js. This package takes the runtime away, so that the figures it produces are the floor the other two are compared against.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/webgpu-experiments
```

Open the local address Vite prints. The home page links to every experiment. The weights are downloaded by the browser from Hugging Face and are cached by the browser; generation stays in the browser.

## Build and type check

```sh
npm run typecheck --workspace @webai/webgpu-experiments
npm run build --workspace @webai/webgpu-experiments
npm run preview --workspace @webai/webgpu-experiments
```

`npm test --workspace @webai/webgpu-experiments` runs the type check only. These experiments are read and run by a person, not asserted by a test.

## Experiments

- [`public/gemma4-e2b-webgpu-kernels`](public/gemma4-e2b-webgpu-kernels) — Gemma 4 E2B on hand-written WebGPU compute kernels, [issue #207](https://github.com/webai-at-home/webai-at-home/issues/207).

The experiment pages are measurements and demonstrations, not production model-serving endpoints.
