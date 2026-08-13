# Directory Context: `/packages/_onnx_experiments/tools/model_graphs`

## Purpose

Builds every ONNX graph the browser runs — everything that is **not** an expert weight — and checks each one against the reference implementation. All Python, run with the virtual environment one level up, at `tools/.venv`.

## Key Exports & Entry Points

- `build_moe_graphs.py`: writes one graph for each layer, the head, the weightless expert graph, the token embedding, and the `graphs.json` that describes them. `--model` names which of the two known models, and has no default.
- `olmoe_non_expert_graph.py` and `qwen3_moe_non_expert_graph.py`: one decoder layer, up to where the experts begin. Two files rather than one flag, because four things differ between the two models and each produces fluent-looking nonsense when it is wrong.
- `onnx_graph_helpers.py`: what those two share — the opset and intermediate representation versions, `initializer`, `root_mean_square_normalization`, `rotate_half`, `apply_rotary`.
- `expert_block_graph.py`: one expert as a graph holding no weights at all, with all nine of its tensors as runtime inputs.
- `gate_olmoe_non_expert_graph.py`, `gate_qwen3_moe_non_expert_graph.py`, `gate_olmoe_expert_decomposition.py`, `gate_moe_whole_model.py`: each gate sits next to what it gates, and imports it directly.
- `expose_graph_intermediates.py`: writes a copy of a graph that also returns every value its nodes produce, for finding which node two things first disagree at.

## Local Rules & Boundaries

- Every gate here runs on the **processor**, which is not enough on its own. A graph can pass all of these and still return zeros in a browser; see `public/qwen3-layer-graph-webgpu-gate/`.
- `build_moe_graphs.py` refuses any graph holding a node that binds more than eight storage buffers, because WebGPU fails such a node by returning zeros rather than by raising.
- Nothing here imports from `../weight_conversion/`. The two sides meet only through the files on disk and the `manifest.json` that describes them.
