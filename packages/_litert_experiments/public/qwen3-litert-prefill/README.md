# Prefill at fixed prompt lengths

Milestone five of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179). LiteRT.js graphs have static shapes, so a prompt of 32 tokens and a prompt of 128 tokens are two different graphs of the same weights. This page runs one exported signature per prompt length, at 32, 128 and 512, and measures what reading a whole prompt in one call is worth against reading it one token at a time.

## Prefill is simpler than decode, not harder

This was the surprise of the milestone. Prefill starts at position 0, so there is no cache to read, no position to write at, and no blend between the two:

| | decode | prefill |
| --- | --- | --- |
| inputs | hidden, cache, cosine, sine, write mask, attention mask | hidden, cosine, sine, attention mask |
| cache in | `[8, 8, 512, 128]` | none |
| cache out | blended with the incoming cache at one position | its own keys and values, then zeros |

`Qwen3PrefillShard` inherits from `Qwen3DecoderShard` and overrides only `forward`, so the normalizations, the rotary embedding and the grouped attention layout are shared rather than restated and the two cannot drift apart. The language-model head is not re-exported at all: only the last position chooses the next token, so the decode head chunks do that job unchanged.

## Run

Write the prefill graphs first:

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_prefill_export/export_qwen3_prefill.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Then start the development server and open `qwen3-litert-prefill/`:

```sh
npm run dev --workspace @webai/litert-experiments
```

The prefill graphs total about 5.3 gigabytes and are not committed. See [`../../tools/qwen3_prefill_export/`](../../tools/qwen3_prefill_export) for the exporter.

## The last section

Milestone five also asks whether sending one long activation beats sending several short ones. The page answers the transfer half of that question over the same relay milestone four used. It does **not** answer the whole question: prefilling in four chunks is not the same computation, because chunks after the first must attend to the cache the earlier chunks wrote, which needs a graph that writes its cache at an offset rather than at position 0. No such graph is built here.
