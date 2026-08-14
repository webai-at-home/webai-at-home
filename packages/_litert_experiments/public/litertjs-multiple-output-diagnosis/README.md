# LiteRT.js multiple output diagnosis

Part of milestone one of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). The key/value cache residency gate next door found that WebGPU returned wrong numbers while `isFullyAccelerated` still reported true. This page names which graph shape is wrong, by changing one property at a time.

Four graphs, each differing from its neighbour in exactly one way: how many outputs it returns, whether the cache update is a constant or is derived from a reduction over another output, and what rank the cache has. Every one of them is checked against PyTorch element by element, so a wrong answer is attributed to the one property that changed and to nothing else.

The two rules the milestone came away with are recorded in [`../../tools/cache_residency_export/CONTEXT.md`](../../tools/cache_residency_export/CONTEXT.md): a key/value cache stays at rank 4 or lower, and no cache update is ever derived from a reduction.

## Run

Write the graphs first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/cache_residency_export/export_multiple_output_diagnosis.py packages/_litert_experiments/public/litertjs-multiple-output-diagnosis/models
```

Then start the development server and open `litertjs-multiple-output-diagnosis/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

The graphs are generated artifacts and are not committed. See [`../../tools/cache_residency_export/`](../../tools/cache_residency_export) for the exporter.

## Why this page exists at all

`isFullyAccelerated` reported true for a graph that returned wrong numbers. It has since done so twice more, in milestone four and in milestone five. It is not a correctness signal in either direction, and a per-graph check against PyTorch is what establishes correctness everywhere in this package.
