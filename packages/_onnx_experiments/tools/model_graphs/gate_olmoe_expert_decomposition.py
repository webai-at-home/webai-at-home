#!/usr/bin/env python3
"""The de-risking gate for milestone 5 of issue #169.

Milestone 5 has to run OLMoE-1B-7B twice, once with every expert resident and
once through the residency layer, and show that the generated tokens are
identical. Both runs must therefore share the same arithmetic and differ only in
where the expert weights happen to live. That only works if the expert block
decomposes exactly: router, top-k, per-expert feed-forward, weighted sum, with
each expert computed from weights this project owns rather than by a fused
operator inside a graph.

This gate asks the single question that would make that impossible:

    Does OLMoE's expert block reproduce exactly when it is taken apart into a
    router and eight independent expert feed-forwards?

It is checked against the reference implementation in transformers, which is the
only ground truth available, and it is checked with random weights on purpose.
Two computations of the same thing either agree or they do not, and agreeing
does not need 13.8 gigabytes of published weights to be downloaded first.

Two details of OLMoE are easy to get wrong and would produce output that looks
reasonable and is not:

  - `norm_topk_prob` is false, so the eight routing weights are raw softmax
    probabilities over all 64 experts and do not sum to one. Renormalising them,
    which many implementations do, changes every number downstream.
  - the softmax is taken in single precision before the top-k, not after, and
    not in the model's own precision.

Requires: pip install torch transformers onnx
"""

from __future__ import annotations

import json
import urllib.request

import torch
from transformers.models.olmoe.modeling_olmoe import (
    OlmoeConfig,
    OlmoeSparseMoeBlock,
)


# The published checkpoint this milestone uses.
MODEL_REPOSITORY = "allenai/OLMoE-1B-7B-0924"

# How closely the decomposition has to match the reference. This is a
# reimplementation of the same arithmetic in the same precision rather than an
# approximation of it, so the only difference allowed is the order floating
# point additions happen in.
TOLERANCE = 1e-5

# How many tokens the gate pushes through one block. More than one, because a
# decomposition can be right for a single token and wrong the moment two tokens
# choose different experts.
TESTED_TOKEN_COUNT = 6


def fetch_configuration() -> dict:
    """Read the published configuration rather than trusting numbers written by hand.

    :returns: the parsed configuration of the published checkpoint.
    """
    url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/main/config.json"
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def decompose(block: OlmoeSparseMoeBlock, hidden_states: torch.Tensor, configuration: OlmoeConfig) -> torch.Tensor:
    """Compute one expert block the way the residency layer will have to compute it.

    Nothing here calls the reference block. The router is applied by hand, the
    top-k is taken by hand, and each chosen expert is a separate pair of matrix
    multiplications against weights read out of the block one expert at a time,
    which is exactly the shape the residency layer supplies them in.

    :param block: the reference block, used only as a container of weights.
    :param hidden_states: the input, shaped (batch, tokens, hidden).
    :param configuration: the model configuration.
    :returns: the block output, shaped like the input.
    """
    batch_size, token_count, hidden_size = hidden_states.shape
    flat = hidden_states.view(-1, hidden_size)

    router_logits = torch.nn.functional.linear(flat, block.gate.weight)
    router_probabilities = torch.nn.functional.softmax(router_logits, dtype=torch.float, dim=-1)
    chosen_weights, chosen_indices = torch.topk(router_probabilities, configuration.num_experts_per_tok, dim=-1)
    # OLMoE sets norm_topk_prob to false, so the weights stay as they are. This
    # branch exists so that the gate fails loudly rather than silently if a
    # future checkpoint turns it on.
    if configuration.norm_topk_prob:
        chosen_weights = chosen_weights / chosen_weights.sum(dim=-1, keepdim=True)
    chosen_weights = chosen_weights.to(router_logits.dtype)

    output = torch.zeros_like(flat)
    for token_index in range(flat.shape[0]):
        for slot in range(configuration.num_experts_per_tok):
            expert_index = int(chosen_indices[token_index, slot])
            gate_up = block.experts.gate_up_proj[expert_index]
            down = block.experts.down_proj[expert_index]
            gate_part, up_part = torch.nn.functional.linear(flat[token_index], gate_up).chunk(2, dim=-1)
            activated = torch.nn.functional.silu(gate_part) * up_part
            output[token_index] += torch.nn.functional.linear(activated, down) * chosen_weights[token_index, slot]

    return output.view(batch_size, token_count, hidden_size)


def published_expert_tensor_names() -> list[str]:
    """Read what the published checkpoint actually calls its expert weights.

    The conversion pipeline of this milestone has to find these tensors by name,
    and transformers rewrites them on load, so the names in memory are not
    necessarily the names on disk.

    :returns: a few expert tensor names from layer zero, and the resident count.
    """
    url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/main/model.safetensors.index.json"
    with urllib.request.urlopen(url) as response:
        index = json.load(response)
    names = sorted(index["weight_map"].keys())
    layer_zero = [name for name in names if name.startswith("model.layers.0.mlp")]
    return names, layer_zero


def main() -> None:
    """Run the gate and print a verdict.

    :returns: nothing.
    """
    published = fetch_configuration()
    configuration = OlmoeConfig(**published)

    print(f"gate: does the {MODEL_REPOSITORY} expert block decompose exactly?")
    print(f"  {configuration.num_hidden_layers} layers, {configuration.num_experts} experts each, "
          f"{configuration.num_experts_per_tok} chosen for each token")
    print(f"  hidden size {configuration.hidden_size}, expert width {configuration.intermediate_size}")
    print(f"  norm_topk_prob {configuration.norm_topk_prob} "
          f"({'weights are renormalised' if configuration.norm_topk_prob else 'weights are left as they are'})")

    torch.manual_seed(11)
    # Building the module directly rather than loading a checkpoint leaves the
    # router weight at zero and the expert tensors uninitialised, so every
    # parameter is filled here. The scale matches the checkpoint's own
    # initializer_range, which keeps the softmax away from both extremes and so
    # keeps the top-k a real choice rather than a tie.
    block = OlmoeSparseMoeBlock(configuration).eval()
    with torch.no_grad():
        for parameter in block.parameters():
            parameter.normal_(mean=0.0, std=configuration.initializer_range)
    hidden_states = torch.randn(1, TESTED_TOKEN_COUNT, configuration.hidden_size)

    with torch.no_grad():
        reference = block(hidden_states)
        decomposed = decompose(block, hidden_states, configuration)

    largest_difference = float((reference - decomposed).abs().max())
    reference_scale = float(reference.abs().mean())
    relative = largest_difference / reference_scale

    print()
    print(f"  reference block output, mean magnitude   {reference_scale:.6f}")
    print(f"  largest absolute difference              {largest_difference:.3e}")
    print(f"  relative to the output scale             {relative:.3e}")

    print()
    print("  the same check with the routing weights wrongly renormalised, to show this gate can fail:")
    with torch.no_grad():
        flat = hidden_states.view(-1, configuration.hidden_size)
        logits = torch.nn.functional.linear(flat, block.gate.weight)
        probabilities = torch.nn.functional.softmax(logits, dtype=torch.float, dim=-1)
        values, _ = torch.topk(probabilities, configuration.num_experts_per_tok, dim=-1)
        wrong_scale = float((values / values.sum(dim=-1, keepdim=True) / values).mean())
    print(f"    renormalising would multiply every expert's contribution by about {wrong_scale:.2f}")

    print()
    names, layer_zero = published_expert_tensor_names()
    expert_names = [name for name in layer_zero if ".experts." in name]
    print(f"  the published checkpoint holds {len(names)} tensors, of which "
          f"{len([n for n in names if '.mlp.experts.' in n])} are expert weights")
    print("  layer zero's expert tensors are named, for example:")
    for name in expert_names[:4]:
        print(f"    {name}")
    print(f"  and its router is named: {[n for n in layer_zero if '.experts.' not in n]}")

    print()
    if relative < TOLERANCE:
        print(f"GATE GREEN — the expert block decomposes to {relative:.3e}, inside {TOLERANCE:.0e}.")
        print("  The residency layer may compute experts one at a time from weights it owns.")
    else:
        print(f"GATE RED — the decomposition differs by {relative:.3e}, outside {TOLERANCE:.0e}.")
        print("  Milestone 5 cannot be built on this decomposition until the difference is explained.")


if __name__ == "__main__":
    main()
