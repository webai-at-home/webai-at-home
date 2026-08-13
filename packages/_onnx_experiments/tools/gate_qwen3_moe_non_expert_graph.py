#!/usr/bin/env python3
"""The de-risking gate for the Qwen3-30B-A3B layer graph of milestone 6 of issue #169.

Milestone 5 proved the same thing for OLMoE-1B-7B-0924 and it is not
transferable. Qwen3-30B-A3B has grouped-query attention where OLMoE has none,
normalizes its queries across each head where OLMoE normalizes across the whole
vector, declares a head width that is not the hidden size divided by the head
count, and renormalises its routing weights where OLMoE leaves them alone. Every
one of those produces output that looks entirely reasonable when it is got
wrong, and three of them are silent for a single attention head.

    reference layer(x)  ==  residual + experts(expert_input, router_logits)

where residual, expert_input, and router_logits all come out of the graph.

Random weights on purpose, and no download of the published 57 gigabytes. Two
computations of the same thing either agree or they do not.

Requires: pip install torch transformers onnx onnxruntime
"""

from __future__ import annotations

import json
import urllib.request

import numpy
import onnxruntime
import torch
from transformers.cache_utils import DynamicCache
from transformers.models.qwen3_moe.modeling_qwen3_moe import (
    Qwen3MoeConfig,
    Qwen3MoeDecoderLayer,
    Qwen3MoeRotaryEmbedding,
)

from qwen3_moe_non_expert_graph import build_layer_graph


# The published checkpoint this milestone uses, at the revision the conversion pinned.
MODEL_REPOSITORY = "Qwen/Qwen3-30B-A3B"
MODEL_REVISION = "ad44e777bcd18fa416d9da3bd8f70d33ebb85d39"

# How closely the graph has to match. This is the same arithmetic in the same
# precision reassociated by two different runtimes, so what is allowed is the
# order floating point additions happen in and nothing else.
TOLERANCE = 2e-5

# How many tokens of history the cached cases start from.
PAST_TOKEN_COUNT = 5

# A layer built at full size would hold 128 experts of 768, which is 300 million
# parameters this gate has no use for: it never runs the reference expert block,
# only the router in front of it. The expert count is kept and the width is cut,
# because the router's output width is the expert count and that one matters.
TESTED_EXPERT_WIDTH = 32


def fetch_configuration() -> dict:
    """Read the published configuration at the pinned revision.

    :returns: the parsed configuration.
    """
    url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/config.json"
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def layer_weights(layer: Qwen3MoeDecoderLayer) -> dict[str, numpy.ndarray]:
    """Collect the non-expert weights of one layer under the names the graph builder expects.

    :param layer: the reference layer.
    :returns: the weights, as arrays.
    """
    return {
        "input_layernorm.weight": layer.input_layernorm.weight.detach().numpy(),
        "post_attention_layernorm.weight": layer.post_attention_layernorm.weight.detach().numpy(),
        "self_attn.q_proj.weight": layer.self_attn.q_proj.weight.detach().numpy(),
        "self_attn.k_proj.weight": layer.self_attn.k_proj.weight.detach().numpy(),
        "self_attn.v_proj.weight": layer.self_attn.v_proj.weight.detach().numpy(),
        "self_attn.o_proj.weight": layer.self_attn.o_proj.weight.detach().numpy(),
        "self_attn.q_norm.weight": layer.self_attn.q_norm.weight.detach().numpy(),
        "self_attn.k_norm.weight": layer.self_attn.k_norm.weight.detach().numpy(),
        "mlp.gate.weight": layer.mlp.gate.weight.detach().numpy(),
    }


def compute_experts(layer, expert_input: numpy.ndarray, router_logits: numpy.ndarray,
                    configuration: Qwen3MoeConfig) -> numpy.ndarray:
    """Compute the expert half the way the residency layer will, from the graph's own outputs.

    Qwen3 sets `norm_topk_prob` to true, so the eight chosen weights are divided
    by their own sum. That is the opposite of OLMoE, and doing what OLMoE does
    here would scale every contribution by about a third while leaving the output
    looking entirely reasonable.

    :param layer: the reference layer, used only as a container of expert weights.
    :param expert_input: what the graph produced for the experts to consume.
    :param router_logits: what the graph produced for the router.
    :param configuration: the model configuration.
    :returns: the expert block output.
    """
    flat_input = torch.from_numpy(expert_input.reshape(-1, configuration.hidden_size))
    flat_logits = torch.from_numpy(router_logits.reshape(-1, configuration.num_experts))

    probabilities = torch.nn.functional.softmax(flat_logits, dtype=torch.float, dim=-1)
    chosen_weights, chosen_indices = torch.topk(probabilities, configuration.num_experts_per_tok, dim=-1)
    if configuration.norm_topk_prob:
        chosen_weights = chosen_weights / chosen_weights.sum(dim=-1, keepdim=True)
    chosen_weights = chosen_weights.to(flat_logits.dtype)

    # The reference keeps its experts as three-dimensional tensors with the gate
    # and up projections stacked into one, so an expert is read out by index
    # rather than reached as a module. The published checkpoint stores them
    # separately, which is what the conversion pipeline reads, and the halves are
    # in that same order.
    output = torch.zeros_like(flat_input)
    with torch.no_grad():
        for token_index in range(flat_input.shape[0]):
            for slot in range(configuration.num_experts_per_tok):
                expert_index = int(chosen_indices[token_index, slot])
                gate_part, up_part = torch.nn.functional.linear(
                    flat_input[token_index], layer.mlp.experts.gate_up_proj[expert_index],
                ).chunk(2, dim=-1)
                activated = torch.nn.functional.silu(gate_part) * up_part
                contribution = torch.nn.functional.linear(activated, layer.mlp.experts.down_proj[expert_index])
                output[token_index] += contribution * chosen_weights[token_index, slot]
    return output.numpy().reshape(expert_input.shape)


def run_once(session, layer, configuration, rotary, token_count, past_token_count, use_causal_bias=True):
    """Run one layer both ways and report how far apart they are.

    :param session: the ONNX session holding the non-expert graph.
    :param layer: the reference layer.
    :param configuration: the model configuration.
    :param rotary: the rotary embedding module.
    :param token_count: how many tokens to push through.
    :param past_token_count: how many tokens the cache already holds.
    :param use_causal_bias: whether the graph is given the causal bias the
        reference is given. Setting this false is the negative control.
    :returns: the relative difference, the output's scale, whether the cache
        matched, and the shape of the returned cache.
    """
    key_value_head_count = configuration.num_key_value_heads
    head_dim = configuration.head_dim
    total = past_token_count + token_count

    torch.manual_seed(4 + token_count + past_token_count)
    hidden_states = torch.randn(1, token_count, configuration.hidden_size)
    past_key = torch.randn(1, key_value_head_count, past_token_count, head_dim)
    past_value = torch.randn(1, key_value_head_count, past_token_count, head_dim)

    position_ids = torch.arange(past_token_count, total).unsqueeze(0)
    cos, sin = rotary(hidden_states, position_ids)

    positions = torch.arange(total).unsqueeze(0)
    queries = torch.arange(past_token_count, total).unsqueeze(1)
    attention_bias = torch.where(positions <= queries, 0.0, float("-inf")).view(1, 1, token_count, total)

    graph_outputs = session.run(None, {
        "hidden_state": hidden_states.numpy(),
        "past_key": past_key.numpy(),
        "past_value": past_value.numpy(),
        "cos": cos.unsqueeze(1).numpy(),
        "sin": sin.unsqueeze(1).numpy(),
        "attention_bias": (attention_bias if use_causal_bias else torch.zeros_like(attention_bias)).numpy(),
    })
    residual, expert_input, router_logits, present_key, present_value = graph_outputs

    assembled = residual + compute_experts(layer, expert_input, router_logits, configuration)

    cache = DynamicCache(config=configuration)
    if past_token_count > 0:
        cache.update(past_key, past_value, 0)

    with torch.no_grad():
        reference = layer(
            hidden_states,
            attention_mask=attention_bias,
            position_ids=position_ids,
            past_key_values=cache,
            use_cache=True,
            position_embeddings=(cos, sin),
        )

    reference_array = reference.numpy()
    largest = float(numpy.abs(reference_array - assembled).max())
    scale = float(numpy.abs(reference_array).mean())
    cache_matches = (
        numpy.abs(cache.layers[0].keys.numpy() - present_key).max() < TOLERANCE
        and numpy.abs(cache.layers[0].values.numpy() - present_value).max() < TOLERANCE
    )
    return largest / scale, scale, cache_matches, present_key.shape


def main() -> None:
    """Run the gate and print a verdict.

    :returns: nothing.
    """
    published = fetch_configuration()
    configuration = Qwen3MoeConfig(**published)
    configuration._attn_implementation = "eager"

    print(f"gate: does a hand-built ONNX graph plus separately computed experts reproduce one whole "
          f"{MODEL_REPOSITORY} layer?")
    print(f"  hidden size {configuration.hidden_size}, {configuration.num_attention_heads} query heads and "
          f"{configuration.num_key_value_heads} key and value heads of {configuration.head_dim}")
    print(f"  each key head serves {configuration.num_attention_heads // configuration.num_key_value_heads} "
          "query heads, and the cache holds the key heads rather than the query heads")
    print(f"  hidden size over head count is {configuration.hidden_size // configuration.num_attention_heads}, "
          f"and the declared head width is {configuration.head_dim}, so the query projection widens to "
          f"{configuration.num_attention_heads * configuration.head_dim}")
    print(f"  norm_topk_prob {configuration.norm_topk_prob} "
          f"({'weights are renormalised' if configuration.norm_topk_prob else 'weights are left as they are'})")
    print(f"  normalization epsilon {configuration.rms_norm_eps}, rotary theta {published['rope_theta']}")

    # Only the expert width is cut down. Everything the graph touches keeps its
    # published size, including the expert count, because that is the width of
    # the router output the graph produces.
    tested = Qwen3MoeConfig(**{**published, "moe_intermediate_size": TESTED_EXPERT_WIDTH})
    tested._attn_implementation = "eager"

    torch.manual_seed(11)
    layer = Qwen3MoeDecoderLayer(tested, layer_idx=0).eval()
    with torch.no_grad():
        for parameter in layer.parameters():
            parameter.normal_(mean=0.0, std=tested.initializer_range)

    model = build_layer_graph(layer_weights(layer), tested, 0)
    session = onnxruntime.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
    print(f"\n  the graph has {len(model.graph.node)} nodes and "
          f"{len(model.graph.initializer)} initializers, and passes the ONNX checker")

    rotary = Qwen3MoeRotaryEmbedding(tested)

    print()
    worst = 0.0
    for token_count, past_token_count in [(1, 0), (1, PAST_TOKEN_COUNT), (4, 0), (3, PAST_TOKEN_COUNT)]:
        relative, scale, cache_matches, present_shape = run_once(
            session, layer, tested, rotary, token_count, past_token_count,
        )
        worst = max(worst, relative)
        print(f"  {token_count} token(s) after {past_token_count} of history: "
              f"relative difference {relative:.3e}, output scale {scale:.4f}, "
              f"cache {'matches' if cache_matches else 'DIFFERS'}, present {present_shape}")

    print()
    print("  a negative control, to show this gate can fail: the same multi-token case with the causal")
    print("  bias replaced by zeros, so the graph lets every token attend to every other one:")
    unmasked, _, _, _ = run_once(session, layer, tested, rotary, 3, PAST_TOKEN_COUNT, use_causal_bias=False)
    print(f"    relative difference {unmasked:.3e}, which is {unmasked / worst:.0f} times the worst real case")

    print()
    if worst < TOLERANCE:
        print(f"GATE GREEN — the worst case is {worst:.3e}, inside {TOLERANCE:.0e}.")
        print("  The non-expert half of Qwen3-30B-A3B can be a graph this project builds and owns.")
    else:
        print(f"GATE RED — the worst case is {worst:.3e}, outside {TOLERANCE:.0e}.")
        print("  Milestone 6 cannot be built on this graph until the difference is explained.")


if __name__ == "__main__":
    main()
