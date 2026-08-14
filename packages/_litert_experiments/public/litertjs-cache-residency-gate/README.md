# LiteRT.js key/value cache residency gate

Milestone one of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179), and the milestone the whole investigation turns on. Issue [#178](https://github.com/webai-at-home/webai-at-home/issues/178) names it risk 3 and calls it the most important runtime question:

> Can a tensor stay on the graphics processor between repeated `model.run()` calls, so that a shard's own key/value cache is never copied out to JavaScript and back on every generated token?

The graphs here are not transformers. They have the input and output *shape* of one shard decoding one token and nothing else, at several cache sizes. The page runs each of them several hundred times in a loop and measures the time inside `model.run()`, the time spent moving the cache out of the graphics processor and back if that movement turns out to be unavoidable, and the growth of memory across the loop, to catch a leak.

## Two rules this gate established

- **The key/value cache must stay at rank 4 or lower.** At rank 5 the WebGPU boundary falls back to `HOST_MEMORY`, the cache can no longer stay on the graphics processor, and the whole design is defeated.
- **A cache update must never be derived from a reduction over another output.** WebGPU computes that wrongly, silently, while `isFullyAccelerated` still reports true. Which graph shape is wrong is named one property at a time by [`../litertjs-multiple-output-diagnosis/`](../litertjs-multiple-output-diagnosis).

## Run

Write the graphs first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/cache_residency_export/export_shard_like_step.py --update constant packages/_litert_experiments/public/litertjs-cache-residency-gate/models
```

Then start the development server and open `litertjs-cache-residency-gate/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

The graphs are generated artifacts and are not committed. See [`../../tools/cache_residency_export/`](../../tools/cache_residency_export) for the exporter.
