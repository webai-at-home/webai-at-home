# Directory Context: `/packages/transformers_response_constraint`

## Purpose

A checked-in build of `@huggingface/transformers-response-constraint`, which turns an OpenAI `response_format` into the `logits_processor` and `stopping_criteria` a `@huggingface/transformers` generation call accepts. It is vendored because the package is not published.

## Key Exports & Entry Points

- `index.js` and `index.d.ts`: `ResponseConstraint.warmup` and `ResponseConstraint.fromResponseFormat`, the only two entry points anything here calls.
- `upstream.json`: the repository, branch, commit, and tool versions the checked-in files are built from.
- `tools/vendor_refresh.mjs`: rebuilds those files from the pinned commit. Command to run this folder: `npm run vendor:refresh --workspace @huggingface/transformers-response-constraint`.
- `tests/index.test.ts`: the facts this project relies on from a package it does not control.

## Rules

- Nothing in this folder except `package.json`, `tsconfig.json`, `upstream.json`, `README.md`, `CONTEXT.md`, `PROVENANCE.md`, `tests/`, and `tools/` is edited by hand. Every other file is rebuilt by `tools/vendor_refresh.mjs`, and an edit to one would be lost by the next refresh and would make the checked-in build no longer reproduce.
- Moving to a newer upstream commit is an edit to `upstream.json` and a run of that script, never a hand-copied file.
- The npm package name here is deliberately not `@webai/…`, against the rule in the root [`CONTEXT.md`](../../CONTEXT.md), so that every import already reads what the published package will be named.
- This package publishes nothing: `package.json` is marked `private`, and the Apache-2.0 `LICENSE` is kept beside the code it covers.
- `packages/_onnx_experiments` keeps its own copy of this build and does not depend on this package, because its copy is part of a measurement record rather than a dependency.

## Background

- The route this folder is, and the four routes it was chosen over, come from milestone 1 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221); the reasons are in [`README.md`](README.md).
- What the package does and does not do on this project's model was measured in milestone 0 of the same issue, in [`packages/_onnx_experiments/public/gemma4-e2b-response-constraint-measurement`](../_onnx_experiments/public/gemma4-e2b-response-constraint-measurement/).
