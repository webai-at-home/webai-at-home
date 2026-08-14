# Resident key/value cache over a real decode

The de-risking gate of milestone four of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). Milestone one showed that a key/value cache *can* stay on the graphics processor between calls, using graphs that had a shard's shape and nothing else. This page asks the same question of a real decoder shard over a whole sequence:

> Does a real decoder shard's key/value cache survive staying on the graphics processor across a whole decode, or does it decay, drift, or get written at the wrong position?

One decoder shard, decoded step by step over the reference prompt, in two variants that differ only in where the cache lives between calls:

- **resident** — the cache tensor `run()` returned is fed straight back into the next `run()`, never read into JavaScript;
- **cache round-trip** — the cache is read out to JavaScript and uploaded again on every step.

Both are checked against `decode_reference.json` at every step, so a cache that goes wrong is caught at the position where it goes wrong rather than at the end.

## Run

Write the graphs and the decode reference first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_decode_reference/export_decode_reference.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Then start the development server and open `qwen3-litert-resident-decode/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

`?shard=` picks which decoder shard to run, and `?accelerators=` picks `webgpu` or `wasm`.

## What this gate found

Keeping the cache on the graphics processor was, at first, **slower** — and that turned out to be a symptom of something else entirely. The exported grouped-query attention widened its key and value heads up to the query heads, which emits a `BROADCAST_TO` operation the WebGPU delegate refuses, and one refusal sent 273 of the graph's 355 operations to the central processor. Exporting the attention in the grouped layout instead removed the refusal, made the graph about ten times faster, and turned residency from a penalty into a 2.6 to 3.1 times win.

That rule now lives in [`../../tools/qwen3_litert_shard_export/CONTEXT.md`](../../tools/qwen3_litert_shard_export/CONTEXT.md).
