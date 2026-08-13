# Directory Context: `/packages/_onnx_experiments/tools/weight_conversion`

## Purpose

Everything that reads the **published** weights of a mixture-of-experts model over HTTP range requests and turns them into the on-disk layout this project needs: the always-resident part in one file, and one contiguous 256-byte-aligned block for each expert holding its quantized weights, scales and zero points together. All JavaScript, run with `node`.

## Key Exports & Entry Points

- `convert_mixture_of_experts_to_expert_blocks.ts`: the conversion pipeline. `--model` names which of the two known models, and has no default.
- `safetensors_reader.ts` (`SafetensorsReader`) and `quantize_matmulnbits.ts` (`QuantizeMatmulnbits`): the two libraries the rest of this folder is built on — reading a published safetensors shard by byte range, and quantizing one matrix to 4 bits in the layout `MatMulNBits` reads.
- `gate_quantize_real_expert.ts`: the gate that chose the quantization scheme, by comparing against a published 4-bit conversion of the same model.
- `measure_qwen3_moe_residency.ts`: the residency arithmetic, read from the real published tensor shapes rather than from `config.json`.
- `make_expert_block_graph_fixture.ts`: writes what `public/expert-block-graph-gate/` compares against.

## Rules

- Nothing here downloads a model whole. Every tensor arrives by HTTP range request, so no copy of the source model is ever written to disk.
- Nothing here imports from `../model_graphs/`, and nothing there imports from here. The two sides meet only through the files on disk and the `manifest.json` that describes them.
- Converted blocks are never committed. They are published to Hugging Face on a pinned revision.

## Background

- The on-disk layout, the quantization scheme, and the residency arithmetic come from the milestones of [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169).
