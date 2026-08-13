#!/usr/bin/env python3
"""Build one expert of a mixture-of-experts model as a weightless ONNX graph.

This is the other half of `olmoe_non_expert_graph.py`. That one holds every
weight that stays resident for the life of the model, as ordinary initializers.
This one holds no weights at all: all nine tensors of an expert arrive as
**graph inputs**, so the caller owns the buffers they live in and may overwrite
them between calls. Milestone 0 of issue #169 proved a live ONNX Runtime Web
does that, on a WebGPU buffer this project allocated, without a new session.

    expert_output = graph(expert_input,
                          gate_proj_quantized, gate_proj_scales, gate_proj_zero_points,
                          up_proj_quantized,   up_proj_scales,   up_proj_zero_points,
                          down_proj_quantized, down_proj_scales, down_proj_zero_points)

The nine inputs are exactly the nine parts, in exactly the order,
`convert_mixture_of_experts_to_expert_blocks.mjs` writes into one block on disk.

The arithmetic inside is half precision and the seam is single precision. That
is not a preference: milestone 3 measured that storing the scales at half
precision costs 0.0001 percentage points of accuracy and saves 1.69 gigabytes
across Qwen3-30B-A3B, so it stored them that way, and `MatMulNBits` requires the
activation and the scales to have the same element type. The two `Cast` nodes at
the ends keep that choice inside this graph, where it is written down, rather
than spreading it through everything that calls it.

Requires: pip install onnx
"""

from __future__ import annotations

import argparse
import json
import pathlib

import onnx
from onnx import TensorProto, helper


# The opset this graph targets in the default ONNX domain.
OPSET_VERSION = 17

# The operator set version this graph targets in the Microsoft contributed
# domain, which is the domain MatMulNBits belongs to. It is not a standard ONNX
# operator.
MICROSOFT_OPSET_VERSION = 1

# The domain MatMulNBits belongs to.
MICROSOFT_DOMAIN = "com.microsoft"

# How many bits one stored weight occupies.
BITS_FOR_EACH_WEIGHT = 4

# The three projections one expert is made of, in the order a block holds them.
PROJECTION_NAMES = ["gate_proj", "up_proj", "down_proj"]


def _quantized_projection(
    nodes: list,
    inputs: list,
    name: str,
    activation_name: str,
    output_name: str,
    input_size: int,
    output_size: int,
    block_size: int,
) -> None:
    """Append one 4-bit quantized projection, declaring its three weight tensors as graph inputs.

    :param nodes: the node list to append to.
    :param inputs: the graph input list to append to.
    :param name: which projection this is, used as the prefix of its three input names.
    :param activation_name: the half precision activation entering the projection.
    :param output_name: what to call the half precision activation leaving it.
    :param input_size: the length of the entering activation, which MatMulNBits calls K.
    :param output_size: the length of the leaving activation, which MatMulNBits calls N.
    :param block_size: how many weights share one scale.
    :returns: nothing.
    """
    blocks_for_each_row = -(-input_size // block_size)
    blob_size = block_size * BITS_FOR_EACH_WEIGHT // 8
    zero_point_byte_length = output_size * -(-blocks_for_each_row // 2)

    inputs.append(helper.make_tensor_value_info(
        f"{name}_quantized", TensorProto.UINT8, [output_size, blocks_for_each_row, blob_size],
    ))
    inputs.append(helper.make_tensor_value_info(
        f"{name}_scales", TensorProto.FLOAT16, [output_size * blocks_for_each_row],
    ))
    # The zero point tensor is padded so that every row starts on a whole byte,
    # which is why this is N * ceil(blocks / 2) rather than half the block count.
    inputs.append(helper.make_tensor_value_info(
        f"{name}_zero_points", TensorProto.UINT8, [zero_point_byte_length],
    ))

    nodes.append(helper.make_node(
        "MatMulNBits",
        [activation_name, f"{name}_quantized", f"{name}_scales", f"{name}_zero_points"],
        [output_name],
        name=name,
        domain=MICROSOFT_DOMAIN,
        K=input_size,
        N=output_size,
        bits=BITS_FOR_EACH_WEIGHT,
        block_size=block_size,
        accuracy_level=0,
    ))


def build_expert_graph(hidden_size: int, expert_width: int, block_size: int) -> onnx.ModelProto:
    """Build one expert as a graph whose every weight is a runtime input.

    :param hidden_size: the model's hidden size.
    :param expert_width: the width of the expert's inner projection.
    :param block_size: how many weights share one scale.
    :returns: the model, ready to be serialized.
    """
    nodes: list = []
    inputs: list = [
        helper.make_tensor_value_info("expert_input", TensorProto.FLOAT, ["batch", "tokens", hidden_size]),
    ]

    nodes.append(helper.make_node("Cast", ["expert_input"], ["half_input"], to=TensorProto.FLOAT16))

    _quantized_projection(
        nodes, inputs, "gate_proj", "half_input", "gate_proj.output", hidden_size, expert_width, block_size,
    )
    _quantized_projection(
        nodes, inputs, "up_proj", "half_input", "up_proj.output", hidden_size, expert_width, block_size,
    )

    # SiLU, written out as x * sigmoid(x). There is no SiLU operator in ONNX, and
    # the fused alternatives are contributed operators with their own support
    # story, which is not worth taking on for two nodes.
    nodes.append(helper.make_node("Sigmoid", ["gate_proj.output"], ["gate_proj.sigmoid"]))
    nodes.append(helper.make_node("Mul", ["gate_proj.output", "gate_proj.sigmoid"], ["gate_proj.activated"]))
    nodes.append(helper.make_node("Mul", ["gate_proj.activated", "up_proj.output"], ["expert.inner"]))

    _quantized_projection(
        nodes, inputs, "down_proj", "expert.inner", "down_proj.output", expert_width, hidden_size, block_size,
    )

    nodes.append(helper.make_node("Cast", ["down_proj.output"], ["expert_output"], to=TensorProto.FLOAT))

    graph = helper.make_graph(
        nodes,
        "expert_block",
        inputs,
        [helper.make_tensor_value_info("expert_output", TensorProto.FLOAT, ["batch", "tokens", hidden_size])],
        [],
    )
    model = helper.make_model(graph, opset_imports=[
        helper.make_operatorsetid("", OPSET_VERSION),
        helper.make_operatorsetid(MICROSOFT_DOMAIN, MICROSOFT_OPSET_VERSION),
    ])
    model.ir_version = 10
    # The checker is not asked about the graph as a whole, because MatMulNBits is
    # a contributed operator it has no shape inference rule for and it would
    # refuse a graph ONNX Runtime runs perfectly well.
    onnx.checker.check_model(model, full_check=False)
    return model


def main() -> None:
    """Write the expert graph for one converted model, sized from that model's own manifest.

    The three sizes are read out of the manifest rather than given on the command
    line, because a graph built to sizes that do not match the blocks on disk
    loads perfectly well and then reads the wrong bytes.

    :returns: nothing.
    """
    parser = argparse.ArgumentParser(description="write the weightless expert graph for a converted model")
    parser.add_argument(
        "--manifest",
        required=True,
        help="the manifest.json written by convert_mixture_of_experts_to_expert_blocks.mjs",
    )
    parser.add_argument("--output", required=True, help="where to write expert.onnx")
    arguments = parser.parse_args()

    manifest = json.loads(pathlib.Path(arguments.manifest).read_text())
    model = build_expert_graph(
        manifest["hiddenSize"],
        manifest["expertWidth"],
        manifest["quantization"]["blockSize"],
    )
    written = model.SerializeToString()
    pathlib.Path(arguments.output).write_bytes(written)

    print(f"wrote {arguments.output}, {len(written)} bytes, holding no weights at all")
    print(f"  for {manifest['sourceRepository']} at {manifest['sourceRevision']}")
    print(f"  hidden size {manifest['hiddenSize']}, expert width {manifest['expertWidth']}, "
          f"blocks of {manifest['quantization']['blockSize']}")
    print(f"  inputs: {', '.join(entry.name for entry in model.graph.input)}")


if __name__ == "__main__":
    main()
