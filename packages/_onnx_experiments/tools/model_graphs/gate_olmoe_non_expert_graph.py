#!/usr/bin/env python3
"""The second de-risking gate for milestone 5 of issue #169.

The first gate proved that OLMoE's expert block takes apart exactly into a
router and eight independent expert feed-forwards. This one proves the other
half: that the rest of the layer can be an ONNX graph this project built itself,
and that the graph plus the separately computed experts reproduce what the
reference implementation produces for the whole layer.

    reference layer(x)  ==  residual + experts(expert_input, router_logits)

where residual, expert_input, and router_logits all come out of the graph.

Random weights again, and for the same reason: two computations of the same
thing either agree or they do not. The layer is run twice, once with an empty
key and value cache and once with a cache already holding tokens, because a
cache that is only ever tested empty is not tested at all.

Requires: pip install torch transformers onnx onnxruntime
"""

from __future__ import annotations

import json
import urllib.request

import numpy
import onnxruntime
import torch
from transformers.models.olmoe.modeling_olmoe import (
    OlmoeConfig,
    OlmoeDecoderLayer,
    OlmoeRotaryEmbedding,
)

from olmoe_non_expert_graph import build_layer_graph


# The published checkpoint this milestone uses.
MODEL_REPOSITORY = "allenai/OLMoE-1B-7B-0924"

# How closely the graph has to match the reference. This is the same arithmetic
# in the same precision, reassociated by two different runtimes, so what is
# allowed is the order floating point additions happen in and nothing else.
TOLERANCE = 2e-5

# How many tokens of history the second run starts from, so the key and value
# cache is exercised rather than assumed.
PAST_TOKEN_COUNT = 5


def fetch_configuration() -> dict:
    """Read the published configuration rather than trusting numbers written by hand.

    :returns: the parsed configuration of the published checkpoint.
    """
    url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/main/config.json"
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def layer_weights(layer: OlmoeDecoderLayer) -> dict[str, numpy.ndarray]:
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


def compute_experts(layer: OlmoeDecoderLayer, expert_input: numpy.ndarray, router_logits: numpy.ndarray,
                    configuration: OlmoeConfig) -> numpy.ndarray:
    """Compute the expert half the way the residency layer will, from the graph's own outputs.

    This is the decomposition the first gate proved, driven here by numbers that
    came out of the ONNX graph rather than out of PyTorch.

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
        reference is given. Setting this false is the negative control: it must
        make the gate fail, and a gate that cannot fail has not tested anything.
    :returns: the relative difference, and the reference output's scale.
    """
    head_count = configuration.num_attention_heads
    head_dim = configuration.hidden_size // head_count
    total = past_token_count + token_count

    torch.manual_seed(4 + token_count + past_token_count)
    hidden_states = torch.randn(1, token_count, configuration.hidden_size)
    past_key = torch.randn(1, head_count, past_token_count, head_dim)
    past_value = torch.randn(1, head_count, past_token_count, head_dim)

    position_ids = torch.arange(past_token_count, total).unsqueeze(0)
    cos, sin = rotary(hidden_states, position_ids)

    # A causal bias: zero where a token may attend, and a large negative value
    # where it may not. With a single token there is nothing to hide, so this is
    # all zeros, which is exactly why the single-token case cannot test masking
    # and the multi-token case must.
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

    expert_output = compute_experts(layer, expert_input, router_logits, configuration)
    assembled = residual + expert_output

    # The reference layer is given the same cache, so both sides see the same
    # history rather than one of them starting from nothing.
    from transformers.cache_utils import DynamicCache
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
    configuration = OlmoeConfig(**published)
    configuration._attn_implementation = "eager"

    print("gate: does a hand-built ONNX graph plus separately computed experts reproduce one whole OLMoE layer?")
    print(f"  hidden size {configuration.hidden_size}, {configuration.num_attention_heads} heads of "
          f"{configuration.hidden_size // configuration.num_attention_heads}, "
          f"{configuration.num_key_value_heads} key and value heads")
    print(f"  normalization epsilon {configuration.rms_norm_eps}")

    torch.manual_seed(11)
    layer = OlmoeDecoderLayer(configuration, layer_idx=0).eval()
    with torch.no_grad():
        for parameter in layer.parameters():
            parameter.normal_(mean=0.0, std=configuration.initializer_range)

    model = build_layer_graph(layer_weights(layer), configuration, 0)
    session = onnxruntime.InferenceSession(model.SerializeToString(), providers=["CPUExecutionProvider"])
    print(f"  the graph has {len(model.graph.node)} nodes and "
          f"{len(model.graph.initializer)} initializers, and passes the ONNX checker")

    rotary = OlmoeRotaryEmbedding(configuration)

    print()
    worst = 0.0
    for token_count, past_token_count in [(1, 0), (1, PAST_TOKEN_COUNT), (4, 0), (3, PAST_TOKEN_COUNT)]:
        relative, scale, cache_matches, present_shape = run_once(
            session, layer, configuration, rotary, token_count, past_token_count,
        )
        worst = max(worst, relative)
        print(f"  {token_count} token(s) after {past_token_count} of history: "
              f"relative difference {relative:.3e}, output scale {scale:.4f}, "
              f"cache {'matches' if cache_matches else 'DIFFERS'}, present {present_shape}")

    print()
    print("  a negative control, to show this gate can fail: the same multi-token case with the causal")
    print("  bias replaced by zeros, so the graph lets every token attend to every other one:")
    unmasked, _, _, _ = run_once(
        session, layer, configuration, rotary, 3, PAST_TOKEN_COUNT, use_causal_bias=False,
    )
    print(f"    relative difference {unmasked:.3e}, which is {unmasked / worst:.0f} times the worst real case")

    print()
    if worst < TOLERANCE:
        print(f"GATE GREEN — the worst case is {worst:.3e}, inside {TOLERANCE:.0e}.")
        print("  The non-expert half of OLMoE can be a graph this project builds and owns.")
    else:
        print(f"GATE RED — the worst case is {worst:.3e}, outside {TOLERANCE:.0e}.")
        print("  Milestone 5 cannot be built on this graph until the difference is explained.")


if __name__ == "__main__":
    main()
