# Directory Context: `/packages/_litert_experiments/tools/cache_residency_export`

## Purpose

Writes the graphs the milestone one key/value cache residency gate reads, and the four graphs that name what WebGPU computes wrongly.

## Key Exports & Entry Points

- `export_shard_like_step.py`: writes one `shard_like_step_<cache shape>_<update>.tflite` per requested cache shape and update form, plus `index.json` naming them all. Run it with the Python virtual environment one level up, at `tools/.venv`.
- `export_multiple_output_diagnosis.py`: writes four graphs differing by one property at a time, for `public/litertjs-multiple-output-diagnosis/`.

## Rules

- The exported modules are not transformers. They have the input and output *shape* of one shard decoding one token, and nothing else; whether a real transformer converts is milestone two's question.
- The key/value cache must stay at rank 4 or lower. At rank 5 the WebGPU boundary falls back to `HOST_MEMORY` and the cache can no longer stay resident on the graphics processor, which defeats the whole design.
- Do not derive the cache update from a reduction over another output. WebGPU computes that wrongly and silently, while `isFullyAccelerated` still reports true. The `derived` update form exists only to reproduce that, and is never the default.
- The generated files are artifacts and are never committed.

## Background

- This folder is milestone one of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), the milestone the whole investigation turns on.
- The rank-4 rule and the reduction rule were both measured, not assumed; the numbers are in the milestone one comment on [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179).
