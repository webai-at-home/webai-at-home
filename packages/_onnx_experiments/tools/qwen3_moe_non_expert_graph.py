#!/usr/bin/env python3
"""Build the non-expert half of one Qwen3-30B-A3B decoder layer as an ONNX graph.

Milestone 6 of issue #169 generates with Qwen3-30B-A3B on a machine whose
graphics memory cannot hold it. Milestone 5 did the same for OLMoE-1B-7B-0924,
and this is the same shape of graph for a different architecture:

    residual, expert_input, router_logits, present_key, present_value
        = graph(hidden_state, past_key, past_value, cos, sin, attention_bias)

Three things differ from OLMoE, and every one of them produces output that looks
entirely reasonable when it is got wrong.

  - **Grouped-query attention.** There are 32 query heads and only 4 key and
    value heads, so each key head serves eight query heads. The cache holds the
    4, not the 32, which is where an eighth of the cache size comes from.
  - **Per-head normalization.** Qwen3 normalizes its queries and keys across each
    128-wide head, after the split into heads. OLMoE normalizes across the whole
    2048-wide vector, before the split. The same nodes; a different place.
  - **The head width is declared, not derived.** `head_dim` is 128 while
    `hidden_size / num_attention_heads` is 64, so the query projection widens to
    4096 rather than staying at 2048. Deriving it, which works for every dense
    Qwen3, gives a graph of the wrong shape here.

Only the *expert* weights are runtime inputs. Everything in this graph is
resident for the life of the model and stays an ordinary initializer.

Requires: pip install onnx numpy
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


def _repeat_key_value_heads(
    nodes: list,
    initializers: list,
    prefix: str,
    input_name: str,
    query_head_count: int,
    repeat_count: int,
    head_dim: int,
) -> str:
    """Append the nodes that give every query head a key or value head to attend to.

    The reference implementation writes this as an expand followed by a reshape,
    which puts the eight copies of key head `h` at query heads `8h` to `8h + 7`.
    That ordering is the whole content of grouped-query attention: get it wrong
    and every head attends to the wrong quarter of the model, which still
    produces fluent-looking numbers.

    A concatenation of copies is used rather than `Expand`, because `Expand`
    needs the sequence length as a value inside the graph and the sequence length
    is not known until the graph runs.

    The copies are doubled two at a time rather than concatenated all at once,
    and that is a browser constraint rather than a preference. WebGPU limits how
    many storage buffers one compute shader may bind, and Chrome creates the
    device with a limit of 8. A single `Concat` of eight copies binds eight
    inputs and one output, which is nine, so its pipeline never compiles. The
    submission it belongs to is then invalid, and the values that should have
    come out of it read back as zeros without anything being raised — the model
    still generates, and it generates nonsense. Doubling binds three buffers at a
    time whatever the repeat count is. Concatenating a tensor with itself three
    times gives exactly what concatenating eight copies gives, because all eight
    copies are the same tensor.

    :param nodes: the node list to append to.
    :param initializers: the initializer list to append to.
    :param prefix: a unique prefix for the names this creates.
    :param input_name: the key or value, shaped (batch, key heads, tokens, head width).
    :param query_head_count: how many query heads there are.
    :param repeat_count: how many query heads each key head serves.
    :param head_dim: the head width.
    :returns: the name of the repeated output.
    """
    if repeat_count == 1:
        return input_name

    initializers.append(numpy_helper.from_array(numpy.array([2], dtype=numpy.int64), f"{prefix}.repeat_axis"))
    initializers.append(numpy_helper.from_array(
        numpy.array([0, query_head_count, -1, head_dim], dtype=numpy.int64), f"{prefix}.repeat_shape",
    ))
    nodes.append(helper.make_node(
        "Unsqueeze", [input_name, f"{prefix}.repeat_axis"], [f"{prefix}.spread"],
    ))

    grown_name = f"{prefix}.spread"
    present_count = 1
    step = 0
    while present_count * 2 <= repeat_count:
        nodes.append(helper.make_node("Concat", [grown_name, grown_name], [f"{prefix}.grown_{step}"], axis=2))
        grown_name = f"{prefix}.grown_{step}"
        present_count *= 2
        step += 1
    # A repeat count that is not a power of two finishes one copy at a time. Every
    # repeat count this project uses is a power of two, so this loop runs zero
    # times, but a construction that is only correct for the numbers at hand is
    # not correct.
    while present_count < repeat_count:
        nodes.append(helper.make_node(
            "Concat", [grown_name, f"{prefix}.spread"], [f"{prefix}.grown_{step}"], axis=2,
        ))
        grown_name = f"{prefix}.grown_{step}"
        present_count += 1
        step += 1

    nodes.append(helper.make_node(
        "Reshape", [grown_name, f"{prefix}.repeat_shape"], [f"{prefix}.repeated"], allowzero=0,
    ))
    return f"{prefix}.repeated"


def build_layer_graph(weights: dict[str, numpy.ndarray], configuration, layer_index: int) -> onnx.ModelProto:
    """Build the non-expert half of one decoder layer.

    :param weights: the layer's weights, keyed by the names the published
        checkpoint uses without the `model.layers.N.` prefix.
    :param configuration: the model configuration.
    :param layer_index: which layer this is, used only for naming.
    :returns: the model, ready to be serialized.
    """
    hidden_size = configuration.hidden_size
    query_head_count = configuration.num_attention_heads
    key_value_head_count = configuration.num_key_value_heads
    head_dim = configuration.head_dim
    repeat_count = query_head_count // key_value_head_count
    epsilon = configuration.rms_norm_eps
    scaling = float(head_dim) ** -0.5
    # 32 heads of 128 is 4096, which is wider than the 2048 that goes in and the
    # 2048 that comes back out of the output projection.
    query_width = query_head_count * head_dim

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

    # The split into heads happens before the query and key normalizations, not
    # after, because those normalizations run across one head rather than across
    # the whole vector.
    initializers.append(numpy_helper.from_array(
        numpy.array([0, -1, query_head_count, head_dim], dtype=numpy.int64), "query_head_shape",
    ))
    initializers.append(numpy_helper.from_array(
        numpy.array([0, -1, key_value_head_count, head_dim], dtype=numpy.int64), "key_value_head_shape",
    ))
    for name, source, shape_name in [
        ("query", "q_proj.output", "query_head_shape"),
        ("key", "k_proj.output", "key_value_head_shape"),
        ("value", "v_proj.output", "key_value_head_shape"),
    ]:
        nodes.append(helper.make_node("Reshape", [source, shape_name], [f"{name}.split"], allowzero=0))

    query_normalized = root_mean_square_normalization(
        nodes, initializers, "q_norm", "query.split", weights["self_attn.q_norm.weight"], epsilon,
    )
    key_normalized = root_mean_square_normalization(
        nodes, initializers, "k_norm", "key.split", weights["self_attn.k_norm.weight"], epsilon,
    )

    for name, source in [("query", query_normalized), ("key", key_normalized), ("value", "value.split")]:
        nodes.append(helper.make_node("Transpose", [source], [f"{name}.heads"], perm=[0, 2, 1, 3]))

    embedded_query = apply_rotary(nodes, initializers, "query", "query.heads", head_dim)
    embedded_key = apply_rotary(nodes, initializers, "key", "key.heads", head_dim)

    # The cache holds the four key and value heads, not the thirty-two the query
    # side has. Caching after the repeat would store eight identical copies of
    # every key and make the cache eight times larger for nothing.
    nodes.append(helper.make_node("Concat", ["past_key", embedded_key], ["present_key"], axis=2))
    nodes.append(helper.make_node("Concat", ["past_value", "value.heads"], ["present_value"], axis=2))

    repeated_key = _repeat_key_value_heads(
        nodes, initializers, "key", "present_key", query_head_count, repeat_count, head_dim,
    )
    repeated_value = _repeat_key_value_heads(
        nodes, initializers, "value", "present_value", query_head_count, repeat_count, head_dim,
    )

    initializers.append(initializer("attention.scaling", numpy.array([scaling])))
    nodes.append(helper.make_node("Transpose", [repeated_key], ["key.transposed"], perm=[0, 1, 3, 2]))
    nodes.append(helper.make_node("MatMul", [embedded_query, "key.transposed"], ["attention.scores"]))
    nodes.append(helper.make_node("Mul", ["attention.scores", "attention.scaling"], ["attention.scaled"]))
    nodes.append(helper.make_node("Add", ["attention.scaled", "attention_bias"], ["attention.biased"]))
    nodes.append(helper.make_node("Softmax", ["attention.biased"], ["attention.weights"], axis=-1))
    nodes.append(helper.make_node("MatMul", ["attention.weights", repeated_value], ["attention.context"]))

    initializers.append(numpy_helper.from_array(numpy.array([0, -1, query_width], dtype=numpy.int64), "merge_shape"))
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
        f"qwen3_moe_layer_{layer_index}_non_expert",
        [
            helper.make_tensor_value_info("hidden_state", TensorProto.FLOAT, ["batch", "tokens", hidden_size]),
            helper.make_tensor_value_info(
                "past_key", TensorProto.FLOAT, ["batch", key_value_head_count, "past", head_dim],
            ),
            helper.make_tensor_value_info(
                "past_value", TensorProto.FLOAT, ["batch", key_value_head_count, "past", head_dim],
            ),
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
            helper.make_tensor_value_info(
                "present_key", TensorProto.FLOAT, ["batch", key_value_head_count, "total", head_dim],
            ),
            helper.make_tensor_value_info(
                "present_value", TensorProto.FLOAT, ["batch", key_value_head_count, "total", head_dim],
            ),
        ],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", OPSET_VERSION)])
    model.ir_version = IR_VERSION
    onnx.checker.check_model(model)
    return model
