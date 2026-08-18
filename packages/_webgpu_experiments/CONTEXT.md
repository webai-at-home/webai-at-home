# Directory Context: `/packages/_webgpu_experiments`

## Purpose

Browser experiments that run a language model on WebGPU compute kernels the page holds itself, with no model runtime between the page and the graphics processor, so that ONNX Runtime Web, Transformers.js, and LiteRT.js can each be compared against what the graphics processor does when nothing sits in between.

## Key Exports & Entry Points

- `public/index.html`: the home page linking to every experiment. Command to run this folder: `npm run dev --workspace @webai/webgpu-experiments`.
- `public/gemma4-e2b-webgpu-kernels/`: Gemma 4 E2B on hand-written WebGPU compute kernels, with its own `README.md`, and with the vendored bundle and its origin in `vendor/`.
- `public/`: one further folder per experiment, per de-risk gate, and per measurement, each named after what it runs.
- `vite.config.js`: one entry per experiment page.

## Rules

- The leading underscore marks this package an experiment: private, outside the root build script, imported by no working package.
- Each experiment is standalone: one folder under `public/` with its own `index.html` and its own `src/`. Do not add a shared library folder across experiments; copying a helper into a second experiment is preferred over coupling them.
- Nothing here imports from `packages/_onnx_experiments`, from `packages/_litert_experiments`, from the gateway, from the protocol package, or from a worker package. A comparison against them is made by running both pages and reading both sets of figures.
- A vendored bundle is copied byte for byte and is never edited. Its origin, its date, and its size are recorded in a `README.md` beside it, and its interface is declared by hand in a `.d.ts` beside it.
- Every experiment checks its output against a reference before it measures anything, and no measurement runs while that check fails.
- Every measurement warms up first, throws the warm-up runs away, and reports the smallest, middle, and largest of several runs. No timing comes from a single run.
- A running page is left alone and stays in sight, and every measurement reports whether the page was ever out of sight.
- Model files and generated artifacts are never committed. The vendored bundle is not a model file and is committed.
- `npm test --workspace @webai/webgpu-experiments` runs the type check only. A person reads and runs these experiments.

## Background

- Every folder here belongs to [issue #207](https://github.com/webai-at-home/webai-at-home/issues/207), whose milestones name each gate and each measurement.
- The correctness rule comes from [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172), where WebGPU silently returned wrong output and killed the work.
- The warm-up rule, the several-runs rule, and the stay-in-sight rule come from `packages/_litert_experiments/CONTEXT.md`, where a hidden page moved figures by a factor of five.
