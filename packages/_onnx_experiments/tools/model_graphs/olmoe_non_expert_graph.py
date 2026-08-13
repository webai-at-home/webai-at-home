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

from onnx_graph_helpers import (
    IR_VERSION,
    OPSET_VERSION,
    apply_rotary,
    initializer,
    root_mean_square_normalization,
)


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

    normalized = root_mean_square_normalization(
        nodes, initializers, "input_layernorm", "hidden_state", weights["input_layernorm.weight"], epsilon,
    )

    # A linear layer holds its weight as (out, in) and computes x @ weight.T, so
    # every one of them is transposed once here rather than by a node at every
    # single step.
    for projection in ["q_proj", "k_proj", "v_proj"]:
        initializers.append(initializer(f"{projection}.weight", weights[f"self_attn.{projection}.weight"].T))
        nodes.append(helper.make_node("MatMul", [normalized, f"{projection}.weight"], [f"{projection}.output"]))

    query = root_mean_square_normalization(
        nodes, initializers, "q_norm", "q_proj.output", weights["self_attn.q_norm.weight"], epsilon,
    )
    key = root_mean_square_normalization(
        nodes, initializers, "k_norm", "k_proj.output", weights["self_attn.k_norm.weight"], epsilon,
    )

    initializers.append(numpy_helper.from_array(
        numpy.array([0, -1, head_count, head_dim], dtype=numpy.int64), "head_shape",
    ))
    for name, source in [("query", query), ("key", key), ("value", "v_proj.output")]:
        nodes.append(helper.make_node("Reshape", [source, "head_shape"], [f"{name}.split"], allowzero=0))
        nodes.append(helper.make_node("Transpose", [f"{name}.split"], [f"{name}.heads"], perm=[0, 2, 1, 3]))

    embedded_query = apply_rotary(nodes, initializers, "query", "query.heads", head_dim)
    embedded_key = apply_rotary(nodes, initializers, "key", "key.heads", head_dim)

    nodes.append(helper.make_node("Concat", ["past_key", embedded_key], ["present_key"], axis=2))
    nodes.append(helper.make_node("Concat", ["past_value", "value.heads"], ["present_value"], axis=2))

    initializers.append(initializer("attention.scaling", numpy.array([scaling])))
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

    initializers.append(initializer("o_proj.weight", weights["self_attn.o_proj.weight"].T))
    nodes.append(helper.make_node("MatMul", ["context.merged", "o_proj.weight"], ["o_proj.output"]))
    nodes.append(helper.make_node("Add", ["hidden_state", "o_proj.output"], ["residual"]))

    expert_input = root_mean_square_normalization(
        nodes, initializers, "post_attention_layernorm", "residual",
        weights["post_attention_layernorm.weight"], epsilon,
    )
    nodes.append(helper.make_node("Identity", [expert_input], ["expert_input"]))

    initializers.append(initializer("router.weight", weights["mlp.gate.weight"].T))
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
    model.ir_version = IR_VERSION
    onnx.checker.check_model(model)
    return model
