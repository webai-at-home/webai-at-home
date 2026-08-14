# Directory Context: `/packages/_litert_experiments`

## Purpose

Browser experiments running a language model's shards with LiteRT.js on WebGPU, so it can be compared against ONNX Runtime Web as the runtime for the cluster's sharded pipeline.

## Key Exports & Entry Points

- `README.md`: what each experiment is and how to run it. Every folder under `public/` and `tools/` has its own.
- `public/index.html`: the home page linking to every experiment, one folder per gate with its own `index.html` and `src/`. Run with `npm run dev --workspace @webai/litert-experiments`
- `vite.config.js`: serves both runtimes' WebAssembly files and the ONNX shards, answers range requests for the token embedding table, and relays frames between worker pages.

## Rules

- The leading underscore marks this package an experiment: private, outside the root build script, imported by no working package.
- Each experiment is standalone. Do not add a shared library folder across experiments; copy the helper instead.
- Nothing here imports from `packages/_onnx_experiments`, the gateway, the protocol package, or a worker package. The comparison reaches that package only through three files the server reads off disk.
- Both runtimes' WebAssembly files are served out of `node_modules`, never copied into `public/`.
- `npm test` runs the type check only; a person runs the experiments.
- Model files, `.tflite` artifacts, and reference JSON files are not committed.
- A key/value cache stays at rank 4 or lower, and no cache update comes from a reduction — see `cache_residency_export`.
- Every gate checks against PyTorch before it measures: WebGPU returns wrong numbers silently with `isFullyAccelerated` still true.
- Every gate warms up, counts `run()` and the readback apart, reports `isFullyAccelerated`, releases every model it loaded, and says whether it was ever out of sight. `run()` returns before the graphics processor finishes, so the first read pays that wait.
- No timing comes from a single run, and a running page is left alone: reading a hidden page lifts Chrome's slowdown on it.
- Every `.tflite` file stays under about 440 megabytes, and one page holds at most 750 megabytes of them: each load needs one contiguous block of a shared heap.

## Background

- Every folder belongs to [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), the plan of [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178), whose milestones name the gates.
- Qwen3-0.6B is the first model rather than Gemma 4 E2B, so the comparison is of one model. It does not change only the runtime, as issue #179 assumes — see the comparison's README.md.
- The size limits were [measured here](https://github.com/webai-at-home/webai-at-home/issues/179#issuecomment-5293242119).
- The timing rules come from a comparison a re-run [overturned](https://github.com/webai-at-home/webai-at-home/issues/179#issuecomment-5293327390), and from figures a hidden tab moved by a factor of five.
