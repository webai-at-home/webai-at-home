# Directory Context: `/packages/_onnx_experiments/tools/model_graphs`

## Purpose

Builds every ONNX graph the browser runs — everything that is **not** an expert weight — and checks each one against the reference implementation. All Python, run with the virtual environment one level up, at `tools/.venv`.

## Key Exports & Entry Points

- `build_moe_graphs.py`: writes one graph for each layer, the head, the weightless expert graph, the token embedding, and the `graphs.json` describing them. `--model` names which of the two known models, and has no default.
- `olmoe_non_expert_graph.py` and `qwen3_moe_non_expert_graph.py`: one decoder layer, up to where the experts begin.
- `onnx_graph_helpers.py`: what those two share — the opset and intermediate representation versions, `initializer`, `root_mean_square_normalization`, `rotate_half`, `apply_rotary`.
- `expert_block_graph.py`: one expert as a graph holding no weights at all, with all nine of its tensors as runtime inputs.
- `gate_*.py`: one gate per graph, each sitting next to what it gates and importing it directly.
- `expose_graph_intermediates.py`: writes a copy of a graph that also returns every value its nodes produce.

## Rules

- Every gate here runs on the **processor**, which is not enough on its own: a graph can pass all of these and still return zeros in a browser.
- `build_moe_graphs.py` refuses any graph holding a node that binds more than eight storage buffers, because WebGPU fails such a node by returning zeros rather than by raising.
- The two decoder layer graphs are two files rather than one flag, because four things differ between the models and each produces fluent-looking nonsense when it is wrong.
- Nothing here imports from `../weight_conversion/`; the two sides meet only through the files on disk and the `manifest.json` describing them.

## Background

- What a processor-only gate misses is shown by `public/qwen3-layer-graph-webgpu-gate/`, written for [issue #169](https://github.com/webai-at-home/webai-at-home/issues/169) after the milestone had already gone wrong for want of it.
