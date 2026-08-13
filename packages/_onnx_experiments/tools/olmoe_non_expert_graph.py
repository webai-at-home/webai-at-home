#!/usr/bin/env python3
"""Build the non-expert half of one OLMoE decoder layer as an ONNX graph.

Milestone 5 of issue #169 runs OLMoE-1B-7B twice, once with every expert
resident and once through the residency layer, and requires identical tokens.
Both runs therefore have to share the same arithmetic and differ only in where
the expert weights live. That rules out any published exporter: every one of
them emits a whole model with the weights as session-owned initializers, so the
two runs would differ in their entire implementation rather than only in
residency, and two implementations agreeing bit for bit is not something
floating point offers.

So the graph is built here, and it deliberately stops at the expert block. One
layer becomes:

    residual, expert_input, router_logits, present_key, present_value
        = graph(hidden_state, past_key, past_value, cos, sin)

The caller then routes, computes the chosen experts from weights it owns, and
adds the result to `residual`. That is the seam the residency layer lives in.

Only the *expert* weights have to be runtime inputs. Everything here is resident
for the life of the model and never changes, so it stays an ordinary initializer
and costs nothing to keep.

Two shapes of this graph are deliberately not fused into a single attention
operator. Plain operators are slower and are supported everywhere, and this is
the milestone whose whole purpose is correctness. Fusing is a later decision
with a measurement behind it.

Requires: pip install torch transformers onnx onnxruntime
"""

from __future__ import annotations

import numpy
import onnx
from onnx import TensorProto, helper, numpy_helper


# The opset this graph targets. Seventeen keeps ReduceMean's axes an attribute
# rather than an input, which keeps the builder readable, and it is old enough
# that every execution provider in play supports all of it.
OPSET_VERSION = 17


def _initializer(name: str, array: numpy.ndarray) -> onnx.TensorProto:
    """Wrap an array as a named initializer in single precision.

    :param name: the name the graph refers to it by.
    :param array: the values.
    :returns: the initializer.
    """
    return numpy_helper.from_array(array.astype(numpy.float32), name)


def _root_mean_square_normalization(
    nodes: list,
    initializers: list,
    prefix: str,
    input_name: str,
    weight: numpy.ndarray,
    epsilon: float,
) -> str:
    """Append the nodes computing one root mean square normalization.

    This is written out rather than fused because the reference implementation
    computes it in single precision whatever the model's own precision is, and
    a fused operator would hide whether that is being honoured.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: what to normalize.
    :param weight: the learned scale, one value for each channel.
    :param epsilon: the value added to the variance before the square root.
    :returns: the name of the normalized output.
    """
    initializers.append(_initializer(f"{prefix}.weight", weight))
    initializers.append(_initializer(f"{prefix}.epsilon", numpy.array([epsilon])))

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


def _rotate_half(nodes: list, initializers: list, prefix: str, input_name: str, head_dim: int) -> str:
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


def _apply_rotary(
    nodes: list,
    initializers: list,
    prefix: str,
    input_name: str,
    head_dim: int,
) -> str:
    """Append the nodes applying the rotary position embedding.

    The cosine and sine tables are graph inputs rather than being built here.
    They depend only on the position, they are the same for every layer, and
    computing them once outside is both simpler and cheaper than building the
    table into sixteen graphs.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: the query or key, shaped (batch, heads, tokens, head width).
    :param head_dim: the head width.
    :returns: the name of the embedded output.
    """
    rotated = _rotate_half(nodes, initializers, f"{prefix}.rotate", input_name, head_dim)
    nodes.append(helper.make_node("Mul", [input_name, "cos"], [f"{prefix}.straight"]))
    nodes.append(helper.make_node("Mul", [rotated, "sin"], [f"{prefix}.turned"]))
    nodes.append(helper.make_node("Add", [f"{prefix}.straight", f"{prefix}.turned"], [f"{prefix}.embedded"]))
    return f"{prefix}.embedded"


def build_layer_graph(weights: dict[str, numpy.ndarray], configuration, layer_index: int) -> onnx.ModelProto:
    """Build the non-expert half of one decoder layer.

    :param weights: the layer's weights, keyed by the names the published
        checkpoint uses without the `model.layers.N.` prefix.
    :param configuration: the model configuration.
    :param layer_index: which layer this is, used only for naming.
    :returns: the model, ready to be serialized.
    """
    hidden_size = configuration.hidden_size
    head_count = configuration.num_attention_heads
    head_dim = hidden_size // head_count
    epsilon = configuration.rms_norm_eps
    scaling = float(head_dim) ** -0.5

    nodes: list = []
    initializers: list = []

    normalized = _root_mean_square_normalization(
        nodes, initializers, "input_layernorm", "hidden_state", weights["input_layernorm.weight"], epsilon,
    )

    # A linear layer holds its weight as (out, in) and computes x @ weight.T, so
    # every one of them is transposed once here rather than by a node at every
    # single step.
    for projection in ["q_proj", "k_proj", "v_proj"]:
        initializers.append(_initializer(f"{projection}.weight", weights[f"self_attn.{projection}.weight"].T))
        nodes.append(helper.make_node("MatMul", [normalized, f"{projection}.weight"], [f"{projection}.output"]))

    query = _root_mean_square_normalization(
        nodes, initializers, "q_norm", "q_proj.output", weights["self_attn.q_norm.weight"], epsilon,
    )
    key = _root_mean_square_normalization(
        nodes, initializers, "k_norm", "k_proj.output", weights["self_attn.k_norm.weight"], epsilon,
    )

    initializers.append(numpy_helper.from_array(
        numpy.array([0, -1, head_count, head_dim], dtype=numpy.int64), "head_shape",
    ))
    for name, source in [("query", query), ("key", key), ("value", "v_proj.output")]:
        nodes.append(helper.make_node("Reshape", [source, "head_shape"], [f"{name}.split"], allowzero=0))
        nodes.append(helper.make_node("Transpose", [f"{name}.split"], [f"{name}.heads"], perm=[0, 2, 1, 3]))

    embedded_query = _apply_rotary(nodes, initializers, "query", "query.heads", head_dim)
    embedded_key = _apply_rotary(nodes, initializers, "key", "key.heads", head_dim)

    nodes.append(helper.make_node("Concat", ["past_key", embedded_key], ["present_key"], axis=2))
    nodes.append(helper.make_node("Concat", ["past_value", "value.heads"], ["present_value"], axis=2))

    initializers.append(_initializer("attention.scaling", numpy.array([scaling])))
    nodes.append(helper.make_node("Transpose", ["present_key"], ["key.transposed"], perm=[0, 1, 3, 2]))
    nodes.append(helper.make_node("MatMul", [embedded_query, "key.transposed"], ["attention.scores"]))
    nodes.append(helper.make_node("Mul", ["attention.scores", "attention.scaling"], ["attention.scaled"]))
    # The bias is a real graph input rather than a causal mask built into the
    # graph. Decoding one token at a time never needs a mask at all, since that
    # token may attend to the whole history, and a graph carrying a mask it does
    # not need would be a graph nobody checks. Feeding it as a tensor means the
    # multi-token case is masked by whoever asks for it, and is testable.
    nodes.append(helper.make_node("Add", ["attention.scaled", "attention_bias"], ["attention.biased"]))
    nodes.append(helper.make_node("Softmax", ["attention.biased"], ["attention.weights"], axis=-1))
    nodes.append(helper.make_node("MatMul", ["attention.weights", "present_value"], ["attention.context"]))

    initializers.append(numpy_helper.from_array(numpy.array([0, -1, hidden_size], dtype=numpy.int64), "merge_shape"))
    nodes.append(helper.make_node("Transpose", ["attention.context"], ["context.ordered"], perm=[0, 2, 1, 3]))
    nodes.append(helper.make_node("Reshape", ["context.ordered", "merge_shape"], ["context.merged"], allowzero=0))

    initializers.append(_initializer("o_proj.weight", weights["self_attn.o_proj.weight"].T))
    nodes.append(helper.make_node("MatMul", ["context.merged", "o_proj.weight"], ["o_proj.output"]))
    nodes.append(helper.make_node("Add", ["hidden_state", "o_proj.output"], ["residual"]))

    expert_input = _root_mean_square_normalization(
        nodes, initializers, "post_attention_layernorm", "residual",
        weights["post_attention_layernorm.weight"], epsilon,
    )
    nodes.append(helper.make_node("Identity", [expert_input], ["expert_input"]))

    initializers.append(_initializer("router.weight", weights["mlp.gate.weight"].T))
    nodes.append(helper.make_node("MatMul", ["expert_input", "router.weight"], ["router_logits"]))

    graph = helper.make_graph(
        nodes,
        f"olmoe_layer_{layer_index}_non_expert",
        [
            helper.make_tensor_value_info("hidden_state", TensorProto.FLOAT, ["batch", "tokens", hidden_size]),
            helper.make_tensor_value_info("past_key", TensorProto.FLOAT, ["batch", head_count, "past", head_dim]),
            helper.make_tensor_value_info("past_value", TensorProto.FLOAT, ["batch", head_count, "past", head_dim]),
            helper.make_tensor_value_info("cos", TensorProto.FLOAT, ["batch", 1, "tokens", head_dim]),
            helper.make_tensor_value_info("sin", TensorProto.FLOAT, ["batch", 1, "tokens", head_dim]),
            helper.make_tensor_value_info("attention_bias", TensorProto.FLOAT, ["batch", 1, "tokens", "total"]),
        ],
        [
            helper.make_tensor_value_info("residual", TensorProto.FLOAT, ["batch", "tokens", hidden_size]),
            helper.make_tensor_value_info("expert_input", TensorProto.FLOAT, ["batch", "tokens", hidden_size]),
            helper.make_tensor_value_info(
                "router_logits", TensorProto.FLOAT, ["batch", "tokens", configuration.num_experts],
            ),
            helper.make_tensor_value_info("present_key", TensorProto.FLOAT, ["batch", head_count, "total", head_dim]),
            helper.make_tensor_value_info("present_value", TensorProto.FLOAT, ["batch", head_count, "total", head_dim]),
        ],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", OPSET_VERSION)])
    model.ir_version = 10
    onnx.checker.check_model(model)
    return model
