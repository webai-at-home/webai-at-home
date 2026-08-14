# Directory Context: `/packages/_litert_experiments/tools/qwen3_decode_reference`

## Purpose

Writes the autoregressive reference that milestone four of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179) is checked against: what every decoder shard produced at every position of a whole generated sequence, and which tokens came out. This supports the `public/qwen3-litert-resident-decode` experiment.

## Key Exports & Entry Points

- `export_decode_reference.py`: writes `decode_reference.json` next to the shards. Takes `--prompt` and `--steps`.
- Command to run this folder: `tools/.venv/bin/python tools/qwen3_decode_reference/export_decode_reference.py public/qwen3-litert-shards/models`

## Rules

- The arithmetic is imported from `../qwen3_litert_shard_export/export_qwen3_shards.py`, never restated here. Two copies of a decoder layer would let the reference and the exported graph drift apart silently, which is the one failure this file exists to catch.
- Every step records a fingerprint of each shard's hidden state — its first eight values and the sum of the absolute values of all of them — rather than the whole state. A cache that decays, drifts, or is written at the wrong position moves the sum long before it moves the sampled token.
- The unsplit Hugging Face model is run over the same prompt and its tokens are compared, so the file says for itself whether splitting changed which token was sampled.
- `--steps` is the number of tokens generated, not the number of positions. The last prompt position already produces the first generated token.
- `decode_reference.json` is a generated artifact and is never committed.

## Background

- This folder is the de-risking gate of milestone four of [issue #179](https://github.com/webai-at-home/webai-at-home/issues/179).
- Only the first decoder shard can be checked from this file alone, because only its input at every position is known in advance: the embedding row of that position's token. Later shards need the shards before them to have run.
