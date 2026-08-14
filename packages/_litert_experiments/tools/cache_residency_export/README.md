# `cache_residency_export`

Writes the graphs the milestone one key/value cache residency gate reads, and the four graphs that name what WebGPU computes wrongly.

## Run

The residency graphs, one per cache shape:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/cache_residency_export/export_shard_like_step.py --update constant packages/_litert_experiments/public/litertjs-cache-residency-gate/models
```

The four diagnosis graphs:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/cache_residency_export/export_multiple_output_diagnosis.py packages/_litert_experiments/public/litertjs-multiple-output-diagnosis/models
```

The generated files are never committed.

## What it exports, and what it deliberately does not

The exported modules are **not** transformers. They have the input and output *shape* of one shard decoding one token and nothing else. Whether a real transformer converts is milestone two's question.

## The two rules this folder enforces

- **The key/value cache stays at rank 4 or lower.** At rank 5 the WebGPU boundary falls back to `HOST_MEMORY`, the cache can no longer stay on the graphics processor, and the whole design of [issue #178](https://github.com/webai-at-home/webai-at-home/issues/178) is defeated.
- **No cache update is derived from a reduction over another output.** WebGPU computes that wrongly and silently, while `isFullyAccelerated` still reports true. The `derived` update form exists only to reproduce that failure, and is never the default.

Both were measured rather than assumed; the numbers are in the milestone one comment on [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179).

Read alongside [`CONTEXT.md`](CONTEXT.md), and [`../README.md`](../README.md) for the shared Python virtual environment.
