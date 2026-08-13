#!/usr/bin/env python3
"""The pieces both hand-built decoder layer graphs of issue #169 are made of.

`olmoe_non_expert_graph.py` and `qwen3_moe_non_expert_graph.py` build the
non-expert half of one decoder layer for two different models. The two
architectures really do differ — one normalizes its queries across the whole
2048-wide vector and the other across each 128-wide head, one has as many key
heads as query heads and the other has a quarter as many — but normalization,
rotation, and wrapping an array as an initializer are the same operation in
both. They live here so that a correction to one of them is a correction to
both.

Nothing here decides anything about a model. Every size and every weight is
passed in.

Requires: pip install onnx numpy
"""

from __future__ import annotations

import numpy
import onnx
from onnx import helper, numpy_helper


# The opset these graphs target. Seventeen keeps ReduceMean's axes an attribute
# rather than an input, which keeps the builders readable, and it is old enough
# that every execution provider in play supports all of it.
OPSET_VERSION = 17

# The ONNX intermediate representation version the produced models declare.
IR_VERSION = 10


def initializer(name: str, array: numpy.ndarray) -> onnx.TensorProto:
    """Wrap an array as a named initializer in single precision.

    :param name: the name the graph refers to it by.
    :param array: the values.
    :returns: the initializer.
    """
    return numpy_helper.from_array(array.astype(numpy.float32), name)


def root_mean_square_normalization(
    nodes: list,
    initializers: list,
    prefix: str,
    input_name: str,
    weight: numpy.ndarray,
    epsilon: float,
) -> str:
    """Append the nodes computing one root mean square normalization over the last axis.

    This is written out rather than fused because the reference implementation
    computes it in single precision whatever the model's own precision is, and a
    fused operator would hide whether that is being honoured.

    Which axis it runs over is what separates the two models: OLMoE normalizes
    its queries before they are split into heads, so the last axis is the whole
    2048-wide vector, while Qwen3 normalizes after the split, so the last axis is
    one 128-wide head. The same nodes serve both; only where they are placed
    differs.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: what to normalize.
    :param weight: the learned scale, one value for each channel of the last axis.
    :param epsilon: the value added to the variance before the square root.
    :returns: the name of the normalized output.
    """
    initializers.append(initializer(f"{prefix}.weight", weight))
    initializers.append(initializer(f"{prefix}.epsilon", numpy.array([epsilon])))

    nodes.append(helper.make_node("Mul", [input_name, input_name], [f"{prefix}.squared"]))
    nodes.append(helper.make_node(
        "ReduceMean",
        [f"{prefix}.squared"],
        [f"{prefix}.variance"],
        axes=[-1],
        keepdims=1,
    ))
    nodes.append(helper.make_node("Add", [f"{prefix}.variance", f"{prefix}.epsilon"], [f"{prefix}.shifted"]))
    nodes.append(helper.make_node("Sqrt", [f"{prefix}.shifted"], [f"{prefix}.deviation"]))
    nodes.append(helper.make_node("Div", [input_name, f"{prefix}.deviation"], [f"{prefix}.normalized"]))
    nodes.append(helper.make_node("Mul", [f"{prefix}.weight", f"{prefix}.normalized"], [f"{prefix}.scaled"]))
    return f"{prefix}.scaled"


def rotate_half(nodes: list, initializers: list, prefix: str, input_name: str, head_dim: int) -> str:
    """Append the nodes computing the rotate-half of the rotary embedding.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: the tensor to rotate, whose last dimension is the head width.
    :param head_dim: the head width.
    :returns: the name of the rotated output.
    """
    half = head_dim // 2
    initializers.append(numpy_helper.from_array(numpy.array([0], dtype=numpy.int64), f"{prefix}.zero"))
    initializers.append(numpy_helper.from_array(numpy.array([half], dtype=numpy.int64), f"{prefix}.half"))
    initializers.append(numpy_helper.from_array(numpy.array([head_dim], dtype=numpy.int64), f"{prefix}.full"))
    initializers.append(numpy_helper.from_array(numpy.array([-1], dtype=numpy.int64), f"{prefix}.axis"))

    nodes.append(helper.make_node(
        "Slice",
        [input_name, f"{prefix}.zero", f"{prefix}.half", f"{prefix}.axis"],
        [f"{prefix}.first"],
    ))
    nodes.append(helper.make_node(
        "Slice",
        [input_name, f"{prefix}.half", f"{prefix}.full", f"{prefix}.axis"],
        [f"{prefix}.second"],
    ))
    nodes.append(helper.make_node("Neg", [f"{prefix}.second"], [f"{prefix}.negated"]))
    nodes.append(helper.make_node(
        "Concat",
        [f"{prefix}.negated", f"{prefix}.first"],
        [f"{prefix}.rotated"],
        axis=-1,
    ))
    return f"{prefix}.rotated"


def apply_rotary(nodes: list, initializers: list, prefix: str, input_name: str, head_dim: int) -> str:
    """Append the nodes applying the rotary position embedding.

    The cosine and sine tables are graph inputs named `cos` and `sin` rather than
    being built here. They depend only on the position, they are the same for
    every layer, and computing them once outside is both simpler and cheaper than
    building the table into forty-eight graphs.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: the query or key, shaped (batch, heads, tokens, head width).
    :param head_dim: the head width.
    :returns: the name of the embedded output.
    """
    rotated = rotate_half(nodes, initializers, f"{prefix}.rotate", input_name, head_dim)
    nodes.append(helper.make_node("Mul", [input_name, "cos"], [f"{prefix}.straight"]))
    nodes.append(helper.make_node("Mul", [rotated, "sin"], [f"{prefix}.turned"]))
    nodes.append(helper.make_node("Add", [f"{prefix}.straight", f"{prefix}.turned"], [f"{prefix}.embedded"]))
    return f"{prefix}.embedded"
