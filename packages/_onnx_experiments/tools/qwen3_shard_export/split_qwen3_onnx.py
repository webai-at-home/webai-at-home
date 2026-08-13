#!/usr/bin/env python3
"""Export the Qwen3 decoder graph as three independently runnable ONNX shards.

The source graph is kept intact as the reference. Each exported graph receives
the hidden state from the previous graph and owns the key/value cache entries
for its decoder layers. The first shard includes token embeddings; the last
shard includes final RMSNorm and the language-model head.

Requires: pip install onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path

import onnx
from onnx import helper


# Qwen3-0.6B has 28 decoder layers numbered 0 through 27. The constant is
# documented here because the shard ranges below must cover every decoder layer
# exactly once.
LAYER_COUNT = 28

# The ranges are deliberately explicit. Keeping the ranges in this file makes
# it easy to replace the equal three-way split later with memory-aware ranges.
# The first shard also owns the token embedding, while the last shard owns the
# final normalisation and language-model head.
SHARDS = (
    ("shard-1", 0, 8),
    ("shard-2", 9, 18),
    ("shard-3", 19, 27),
)


def cache_inputs(start: int, end: int) -> list[str]:
    # A volunteer only needs the key/value cache for the layers owned by that
    # volunteer. Passing the full cache to every shard would defeat the memory
    # savings that make model sharding useful.
    return [
        name
        for layer in range(start, end + 1)
        for name in (f"past_key_values.{layer}.key", f"past_key_values.{layer}.value")
    ]


def cache_outputs(start: int, end: int) -> list[str]:
    # The output cache names are changed back to past_key_values names by the
    # browser before the next autoregressive token is evaluated.
    return [
        name
        for layer in range(start, end + 1)
        for name in (f"present.{layer}.key", f"present.{layer}.value")
    ]


def shard_inputs(index: int, start: int, end: int) -> list[str]:
    # Every shard receives the token and position metadata because the exported
    # Qwen3 graph uses those values while preparing rotary positions and the
    # attention mask. Only shard 1 consumes token IDs as model activations.
    # Qwen3's exported graph fuses the residual addition with input
    # normalisation. A shard boundary therefore carries two tensors: the
    # normalised activation used by attention and the residual activation used
    # by the following fused skip-normalisation operator.
    boundary = "9" if index == 1 else "19"
    return (
        (["input_ids"] if index == 0 else [
            f"/model/layers.{boundary}/input_layernorm/output_0",
            f"/model/layers.{boundary}/input_layernorm/output_3",
            "input_ids",
        ])
        + ["attention_mask", "position_ids"]
        + cache_inputs(start, end)
    )


def shard_outputs(index: int, start: int, end: int) -> list[str]:
    # The first two shards expose the two activation tensors needed by the next
    # shard. The last shard exposes logits because it completes the model.
    if index == 0:
        hidden_output = [
            "/model/layers.9/input_layernorm/output_0",
            "/model/layers.9/input_layernorm/output_3",
        ]
    elif index == 1:
        hidden_output = [
            "/model/layers.19/input_layernorm/output_0",
            "/model/layers.19/input_layernorm/output_3",
        ]
    else:
        hidden_output = ["logits"]
    return hidden_output + cache_outputs(start, end)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Path to model_q4f16.onnx")
    parser.add_argument("output", type=Path, help="Directory for the three shard files")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    # Keep external tensor data disabled: this Qwen3 file stores its weights in
    # the ONNX file itself, and the exported shard files should be self-contained
    # files that can be downloaded independently by browser volunteers.
    source = onnx.load(args.source, load_external_data=False)
    if len(source.graph.node) == 0:
        raise ValueError("The source ONNX graph is empty.")

    for index, (name, start, end) in enumerate(SHARDS):
        destination = args.output / f"{name}.onnx"
        inputs = shard_inputs(index, start, end)
        outputs = shard_outputs(index, start, end)
        print(f"Exporting {name}: decoder layers {start}-{end}; {len(inputs)} inputs; {len(outputs)} outputs")
        export_graph(source, destination, inputs, outputs)
        exported = onnx.load(destination, load_external_data=False)
        actual_inputs = {value.name for value in exported.graph.input}
        actual_outputs = {value.name for value in exported.graph.output}
        missing_inputs = set(inputs) - actual_inputs
        missing_outputs = set(outputs) - actual_outputs
        if missing_inputs or missing_outputs:
            raise ValueError(f"{name} lost interface tensors: inputs={missing_inputs}, outputs={missing_outputs}")
        print(f"  wrote {destination} ({destination.stat().st_size / 1024 / 1024:.1f} MiB)")


def export_graph(source: onnx.ModelProto, destination: Path, inputs: list[str], outputs: list[str]) -> None:
    """Write a graph whose requested inputs are true graph boundaries.

    ``onnx.utils.extract_model`` follows an intermediate input backwards into
    the source graph. That is correct for ordinary extraction, but wrong for a
    distributed shard: the previous shard's hidden state must become an
    external input. This dependency walk stops at the declared shard inputs.
    """

    # Build a reverse index from tensor name to the node that creates it. This
    # lets the exporter walk backwards from the requested outputs and retain
    # only the computation required by one shard.
    initializers = {value.name: value for value in source.graph.initializer}
    producers = {
        output: node
        for node in source.graph.node
        for output in node.output
        if output
    }
    # These are the real distributed boundaries. When the dependency walk sees
    # one of these names, it stops instead of pulling earlier layers into the
    # current shard. This is the important difference from a normal ONNX graph
    # extraction: an intermediate activation becomes a graph input here.
    stop_inputs = set(inputs)
    needed_nodes: set[int] = set()
    visited_values: set[str] = set()

    def visit(value_name: str) -> None:
        # Empty output names are legal in ONNX for unused outputs of fused
        # operators and must not be followed.
        if not value_name or value_name in visited_values or value_name in stop_inputs or value_name in initializers:
            return
        visited_values.add(value_name)
        node = producers.get(value_name)
        if node is None:
            raise ValueError(f"No producer found for tensor {value_name!r}")
        node_index = next(index for index, candidate in enumerate(source.graph.node) if candidate is node)
        needed_nodes.add(node_index)
        for input_name in node.input:
            visit(input_name)

    for output in outputs:
        visit(output)

    # Preserve the original topological order. ONNX Runtime expects producers
    # to appear before the nodes that consume their outputs.
    selected_nodes = [node for index, node in enumerate(source.graph.node) if index in needed_nodes]
    used_initializers = {
        input_name
        for node in selected_nodes
        for input_name in node.input
        if input_name in initializers
    }
    source_inputs = {value.name: value for value in source.graph.input}
    source_value_info = {value.name: value for value in source.graph.value_info}
    graph_inputs = []
    for name in inputs:
        value_info = source_inputs.get(name) or source_value_info.get(name)
        if value_info is None:
            raise ValueError(f"No type information found for shard input {name!r}")
        graph_inputs.append(value_info)

    graph_outputs = []
    source_outputs = {value.name: value for value in source.graph.output}
    for name in outputs:
        value_info = source_outputs.get(name) or source_value_info.get(name)
        if value_info is None:
            raise ValueError(f"No type information found for shard output {name!r}")
        graph_outputs.append(value_info)

    # Keep only initializers referenced by the selected nodes. This prevents a
    # shard from carrying weights belonging exclusively to another shard.
    graph = helper.make_graph(
        selected_nodes,
        destination.stem,
        graph_inputs,
        graph_outputs,
        initializer=[initializers[name] for name in sorted(used_initializers)],
        value_info=[value for name, value in source_value_info.items() if name in visited_values],
    )
    # Preserve the source operator set, including Microsoft's custom operators
    # used by ONNX Runtime for the quantised Qwen3 graph.
    model = helper.make_model(
        graph,
        producer_name="webai-at-home Qwen3 shard exporter",
        ir_version=source.ir_version,
    )
    del model.opset_import[:]
    model.opset_import.extend(source.opset_import)
    model.functions.extend(source.functions)
    onnx.save(model, destination)

    actual_inputs = {value.name for value in model.graph.input}
    actual_outputs = {value.name for value in model.graph.output}
    missing_inputs = set(inputs) - actual_inputs
    missing_outputs = set(outputs) - actual_outputs
    if missing_inputs or missing_outputs:
        raise ValueError(f"{destination.name} lost interface tensors: inputs={missing_inputs}, outputs={missing_outputs}")


if __name__ == "__main__":
    main()
