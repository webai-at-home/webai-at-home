# `qwen3_decode_reference`

Writes the autoregressive reference milestone four is checked against: what every decoder shard produced at every position of a whole generated sequence, and which tokens came out.

## Run

```sh
packages/_litert_experiments/tools/.venv/bin/python packages/_litert_experiments/tools/qwen3_decode_reference/export_decode_reference.py packages/_litert_experiments/public/qwen3-litert-shards/models
```

Writes `decode_reference.json` next to the shards. Takes `--prompt` and `--steps`. It is a generated artifact and is never committed.

`--steps` is the number of tokens generated, not the number of positions: the last prompt position already produces the first generated token, so generating N tokens needs N − 1 positions beyond the prompt.

## What it records, and why

- **The arithmetic is imported from [`../qwen3_litert_shard_export/export_qwen3_shards.py`](../qwen3_litert_shard_export), never restated here.** Two copies of a decoder layer would let the reference and the exported graph drift apart silently, which is the one failure this file exists to catch.
- **Every step records a fingerprint of each shard's hidden state** — its first eight values and the sum of the absolute values of all of them — rather than the whole state. A cache that decays, drifts, or is written at the wrong position moves that sum long before it moves the sampled token.
- **The unsplit Hugging Face model is run over the same prompt** and its tokens are recorded beside the split ones, so the file says for itself whether splitting the residual stream changed which token was sampled. It did not: 32 tokens, no divergence.

## What it cannot check on its own

Only the first decoder shard can be checked from this file alone, because only its input at every position is known in advance: the embedding row of that position's token. Every later shard needs the shards before it to have run, which is what the browser pages do.

Read alongside [`CONTEXT.md`](CONTEXT.md), and [`../README.md`](../README.md) for the shared Python virtual environment.
