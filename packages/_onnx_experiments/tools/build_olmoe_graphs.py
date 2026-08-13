#!/usr/bin/env python3
"""Build every graph OLMoE-1B-7B-0924 needs, apart from its experts.

Milestone 5 of issue #169 runs OLMoE twice, once with every expert resident and
once through the residency layer, and requires identical tokens. Only the expert
weights ever have to be runtime inputs, so everything else is built here with
its weights baked in as ordinary initializers:

  - `layer_00.onnx` to `layer_15.onnx`, the non-expert half of each decoder
    layer, from `olmoe_non_expert_graph.py`, which was gated against the
    reference implementation to 2.056e-06.
  - `head.onnx`, the final normalization and the language model head.
  - `expert.onnx`, one expert with all nine of its weight tensors as runtime
    inputs, from `expert_block_graph.py`.
  - `token_embedding.f32.bin`, the embedding table as plain single precision
    values, because looking a row up is not a matrix multiplication and does not
    want a graph.
  - `graphs.json`, saying what was written and what shape the model is.

The source is the `resident.safetensors` that
`convert_mixture_of_experts_to_expert_blocks.mjs` wrote, which is the published
weights copied unchanged at BF16. Reading that file rather than the published
repository again keeps both halves of the split provably from one conversion.

Single precision throughout, not half. The layer graph was gated at single
precision, and this milestone is the one whose whole purpose is correctness;
halving the size of these files buys nothing that matters here and would put
every number the gate measured back in doubt.

Requires: pip install onnx numpy safetensors transformers
"""

from __future__ import annotations

import argparse
import json
import pathlib
import urllib.request

import numpy
import onnx
from onnx import TensorProto, helper
from safetensors import safe_open
from transformers.models.olmoe.modeling_olmoe import OlmoeConfig

from expert_block_graph import build_expert_graph
from olmoe_non_expert_graph import (
    OPSET_VERSION,
    _initializer,
    _root_mean_square_normalization,
    build_layer_graph,
)


# The names of the tensors that belong to no layer.
EMBEDDING_TENSOR_NAME = "model.embed_tokens.weight"
FINAL_NORMALIZATION_TENSOR_NAME = "model.norm.weight"
HEAD_TENSOR_NAME = "lm_head.weight"

# The nine non-expert tensors each layer holds, without their `model.layers.N.` prefix.
LAYER_TENSOR_NAMES = [
    "input_layernorm.weight",
    "post_attention_layernorm.weight",
    "self_attn.q_proj.weight",
    "self_attn.k_proj.weight",
    "self_attn.v_proj.weight",
    "self_attn.o_proj.weight",
    "self_attn.q_norm.weight",
    "self_attn.k_norm.weight",
    "mlp.gate.weight",
]


def load_resident(path: pathlib.Path) -> dict[str, numpy.ndarray]:
    """Read every tensor of the resident part, widening BF16 to single precision.

    BF16 is the top sixteen bits of a single precision value, so widening is an
    exact shift rather than a conversion, and nothing is lost or invented.

    :param path: the resident.safetensors written by the conversion pipeline.
    :returns: every tensor, keyed by its published name.
    """
    weights: dict[str, numpy.ndarray] = {}
    with safe_open(str(path), framework="numpy") as handle:
        for name in handle.keys():
            stored = handle.get_tensor(name)
            if stored.dtype == numpy.dtype("uint16"):
                stored = (stored.astype(numpy.uint32) << 16).view(numpy.float32)
            weights[name] = stored.astype(numpy.float32)
    return weights


def _fetch(url: str) -> str:
    """Read one small text file over the network.

    :param url: what to read.
    :returns: its content.
    """
    with urllib.request.urlopen(url) as response:
        return response.read().decode("utf8")


def _require_agreement(
    configuration: OlmoeConfig,
    manifest: dict,
    vocabulary_size: int,
    hidden_size: int,
    layer_count: int,
) -> None:
    """Refuse to build unless the published configuration describes the files actually on disk.

    The graphs and the expert blocks are two halves of one model that are written
    by two different tools and are only ever joined at run time. If they disagree
    about a size, every graph still loads and the model still generates, and what
    it generates is nonsense.

    :param configuration: the published configuration, read at the pinned revision.
    :param manifest: what the conversion pipeline recorded about the blocks.
    :param vocabulary_size: the row count of the embedding table actually present.
    :param hidden_size: the column count of the embedding table actually present.
    :param layer_count: the layer count the conversion recorded.
    :returns: nothing.
    """
    disagreements = []
    for name, published, present in [
        ("hidden size", configuration.hidden_size, hidden_size),
        ("vocabulary size", configuration.vocab_size, vocabulary_size),
        ("layer count", configuration.num_hidden_layers, layer_count),
        ("expert width", configuration.intermediate_size, manifest["expertWidth"]),
        ("experts for each layer", configuration.num_experts, manifest["experts"]["expertsForEachLayer"]),
        ("experts for each token", configuration.num_experts_per_tok, manifest["expertsForEachToken"]),
    ]:
        if published != present:
            disagreements.append(f"{name}: the configuration says {published}, the files hold {present}")
    if len(disagreements) > 0:
        raise ValueError(
            "the published configuration does not describe these files:\n  " + "\n  ".join(disagreements),
        )


def build_head_graph(weights: dict[str, numpy.ndarray], configuration: OlmoeConfig) -> onnx.ModelProto:
    """Build the final normalization and the language model head as one graph.

    :param weights: the resident weights.
    :param configuration: the model configuration.
    :returns: the model, ready to be serialized.
    """
    nodes: list = []
    initializers: list = []

    normalized = _root_mean_square_normalization(
        nodes,
        initializers,
        "final_norm",
        "hidden_state",
        weights[FINAL_NORMALIZATION_TENSOR_NAME],
        configuration.rms_norm_eps,
    )
    initializers.append(_initializer("head.weight", weights[HEAD_TENSOR_NAME].T))
    nodes.append(helper.make_node("MatMul", [normalized, "head.weight"], ["logits"]))

    graph = helper.make_graph(
        nodes,
        "olmoe_head",
        [helper.make_tensor_value_info(
            "hidden_state", TensorProto.FLOAT, ["batch", "tokens", configuration.hidden_size],
        )],
        [helper.make_tensor_value_info(
            "logits", TensorProto.FLOAT, ["batch", "tokens", configuration.vocab_size],
        )],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", OPSET_VERSION)])
    model.ir_version = 10
    onnx.checker.check_model(model)
    return model


def layer_weights(weights: dict[str, numpy.ndarray], layer_index: int) -> dict[str, numpy.ndarray]:
    """Collect one layer's non-expert weights under the names the graph builder expects.

    :param weights: every resident weight.
    :param layer_index: which layer.
    :returns: that layer's nine tensors, without their prefix.
    """
    collected: dict[str, numpy.ndarray] = {}
    for name in LAYER_TENSOR_NAMES:
        collected[name] = weights[f"model.layers.{layer_index}.{name}"]
    return collected


def main() -> None:
    """Write every graph, the embedding table, and an index of what was written.

    :returns: nothing.
    """
    parser = argparse.ArgumentParser(description="build the non-expert graphs of OLMoE-1B-7B-0924")
    parser.add_argument(
        "--blocks",
        required=True,
        help="the directory written by convert_mixture_of_experts_to_expert_blocks.mjs",
    )
    parser.add_argument("--output", required=True, help="where to write the graphs")
    arguments = parser.parse_args()

    blocks_directory = pathlib.Path(arguments.blocks)
    manifest = json.loads((blocks_directory / "manifest.json").read_text())

    # The configuration is read at the revision the conversion pinned, not at
    # `main`. Two of the numbers it carries — the normalization epsilon and the
    # rotary theta — are not in the shapes on disk and would otherwise be
    # silently taken from the library's defaults. They happen to agree today,
    # and a default that happens to agree is not something to build on.
    published = json.loads(_fetch(
        f"https://huggingface.co/{manifest['sourceRepository']}/resolve/"
        f"{manifest['sourceRevision']}/config.json",
    ))
    configuration = OlmoeConfig(**published)

    weights = load_resident(blocks_directory / "resident.safetensors")
    embedding = weights[EMBEDDING_TENSOR_NAME]
    vocabulary_size, hidden_size = embedding.shape
    layer_count = manifest["experts"]["layerCount"]

    _require_agreement(configuration, manifest, vocabulary_size, hidden_size, layer_count)

    output_directory = pathlib.Path(arguments.output)
    output_directory.mkdir(parents=True, exist_ok=True)

    print(f"building the non-expert graphs of {manifest['sourceRepository']}")
    print(f"  {layer_count} layers, hidden size {hidden_size}, {configuration.num_attention_heads} heads of "
          f"{hidden_size // configuration.num_attention_heads}, vocabulary {vocabulary_size}")
    print(f"  reading {blocks_directory / 'resident.safetensors'}, {len(weights)} tensors")

    written: list[dict] = []
    for layer_index in range(layer_count):
        model = build_layer_graph(layer_weights(weights, layer_index), configuration, layer_index)
        name = f"layer_{layer_index:02d}.onnx"
        data = model.SerializeToString()
        (output_directory / name).write_bytes(data)
        written.append({"fileName": name, "byteLength": len(data)})
        print(f"  {name}, {len(data) / 1024 / 1024:.2f} megabytes, {len(model.graph.node)} nodes")

    head = build_head_graph(weights, configuration).SerializeToString()
    (output_directory / "head.onnx").write_bytes(head)
    print(f"  head.onnx, {len(head) / 1024 / 1024:.2f} megabytes")

    expert = build_expert_graph(
        hidden_size, manifest["expertWidth"], manifest["quantization"]["blockSize"],
    ).SerializeToString()
    (output_directory / "expert.onnx").write_bytes(expert)
    print(f"  expert.onnx, {len(expert)} bytes, holding no weights at all")

    (output_directory / "token_embedding.f32.bin").write_bytes(
        numpy.ascontiguousarray(embedding, dtype=numpy.float32).tobytes(),
    )
    print(f"  token_embedding.f32.bin, {embedding.nbytes / 1024 / 1024:.2f} megabytes, "
          f"{vocabulary_size} rows of {hidden_size}")

    index = {
        "producedBy": "packages/_onnx_experiments/tools/build_olmoe_graphs.py",
        "issue": "https://github.com/webai-at-home/webai-at-home/issues/169",
        "sourceRepository": manifest["sourceRepository"],
        "sourceRevision": manifest["sourceRevision"],
        "elementType": "float32",
        "layerCount": layer_count,
        "hiddenSize": hidden_size,
        "expertWidth": manifest["expertWidth"],
        "headCount": configuration.num_attention_heads,
        "keyValueHeadCount": configuration.num_key_value_heads,
        "headDimension": hidden_size // configuration.num_attention_heads,
        "vocabularySize": vocabulary_size,
        "expertsForEachLayer": manifest["experts"]["expertsForEachLayer"],
        "expertsForEachToken": manifest["expertsForEachToken"],
        "normalizeTopExpertWeights": configuration.norm_topk_prob,
        # Read from the published file rather than from the configuration object,
        # because where the library keeps the rotary theta has moved between
        # versions and the published file is the thing that does not move.
        "rotaryTheta": published.get("rope_theta", configuration.rope_parameters["rope_theta"]),
        "rotaryScaling": published.get("rope_scaling"),
        "normalizationEpsilon": configuration.rms_norm_eps,
        "layerGraphs": written,
        "headGraph": "head.onnx",
        "expertGraph": "expert.onnx",
        "tokenEmbedding": {
            "fileName": "token_embedding.f32.bin",
            "rowCount": int(vocabulary_size),
            "columnCount": int(hidden_size),
            "elementType": "float32",
        },
        "expertBlocks": {
            "fileName": "expert_blocks.bin",
            "blockByteLength": manifest["experts"]["blockByteLength"],
            "blockIndexFormula": manifest["experts"]["blockIndexFormula"],
            "parts": manifest["experts"]["parts"],
        },
    }
    (output_directory / "graphs.json").write_text(f"{json.dumps(index, indent='\t')}\n")

    total = sum(entry["byteLength"] for entry in written) + len(head) + len(expert) + embedding.nbytes
    print(f"\n  wrote {len(written) + 3} files, {total / 1024 / 1024 / 1024:.2f} gigabytes, to {output_directory}")


if __name__ == "__main__":
    main()
