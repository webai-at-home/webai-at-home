#!/usr/bin/env python3
"""Build every graph a converted mixture-of-experts model needs, apart from its experts.

Milestone 5 of issue #169 runs OLMoE-1B-7B-0924 twice and requires identical
tokens; milestone 6 runs Qwen3-30B-A3B on a machine whose graphics memory cannot
hold it. Only the expert weights ever have to be runtime inputs, so everything
else is built here with its weights baked in as ordinary initializers:

  - one graph for each decoder layer's non-expert half, from the layer builder
    that belongs to the architecture, each of which was gated against the
    reference implementation — OLMoE to 2.056e-06 and Qwen3 to 7.875e-06.
  - `head.onnx`, the final normalization and the language model head.
  - `expert.onnx`, one expert with all nine of its weight tensors as runtime
    inputs, from `expert_block_graph.py`.
  - the token embedding table as plain values, because looking a row up is not a
    matrix multiplication and does not want a graph.
  - `graphs.json`, saying what was written and what shape the model is.

The source is the `resident.safetensors` that
`convert_mixture_of_experts_to_expert_blocks.mjs` wrote, which is the published
weights copied unchanged at BF16. Reading that file rather than the published
repository again keeps both halves of the split provably from one conversion.

Single precision in every graph, not half. Both layer graphs were gated at
single precision, and halving the files would put every number those gates
measured back in doubt for a saving this project can afford not to make. The
one exception is the token embedding, which is never multiplied by anything and
is written in whatever form the checkpoint already holds.

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
from transformers.models.qwen3_moe.modeling_qwen3_moe import Qwen3MoeConfig

import olmoe_non_expert_graph
import qwen3_moe_non_expert_graph
from expert_block_graph import build_expert_graph
from onnx_graph_helpers import IR_VERSION, OPSET_VERSION, initializer, root_mean_square_normalization


# Every model this builds graphs for, named as `--model` names them and as the
# conversion pipeline names them.
#
# `headDimension` is read from the configuration when the configuration declares
# one and derived from the hidden size otherwise. Qwen3-30B-A3B declares 128
# while its hidden size over its head count is 64, so deriving it there gives a
# graph of the wrong shape that still loads.
#
# `embeddingElementType` decides how the token embedding is written. Qwen3's is
# 151936 rows of 2048, which is 1.16 gigabytes at single precision and 622
# megabytes at BF16, and BF16 is what the published checkpoint already holds. A
# lookup is not a multiplication, and widening BF16 to single precision is an
# exact shift of sixteen bits, so storing the wider form buys nothing and costs
# half a gigabyte in the browser's memory.
STORAGE_BUFFERS_FOR_EACH_SHADER_STAGE = 8
"""How many storage buffers one WebGPU compute shader may bind, which is what Chrome creates its device with. A node
binding more than this has a pipeline that never compiles, and it fails by returning zeros rather than by raising."""

MODEL_DESCRIPTIONS = {
    "OLMoE-1B-7B-0924": {
        "configurationClass": OlmoeConfig,
        "layerBuilder": olmoe_non_expert_graph.build_layer_graph,
        "expertWidthKey": "intermediate_size",
        "embeddingElementType": "float32",
    },
    "Qwen3-30B-A3B": {
        "configurationClass": Qwen3MoeConfig,
        "layerBuilder": qwen3_moe_non_expert_graph.build_layer_graph,
        "expertWidthKey": "moe_intermediate_size",
        "embeddingElementType": "bfloat16",
    },
}

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


def load_resident(path: pathlib.Path, keep_stored: set[str] | None = None) -> dict[str, numpy.ndarray]:
    """Read every tensor of the resident part, widening BF16 to single precision.

    BF16 is the top sixteen bits of a single precision value, so widening is an
    exact shift rather than a conversion, and nothing is lost or invented.

    :param path: the resident.safetensors written by the conversion pipeline.
    :param keep_stored: names to hand back in their stored form rather than
        widening. The embedding table of Qwen3-30B-A3B is 1.16 gigabytes widened
        and 622 megabytes as stored, and widening it here only to write it out
        again would need both at once.
    :returns: every tensor, keyed by its published name.
    """
    weights: dict[str, numpy.ndarray] = {}
    with safe_open(str(path), framework="numpy") as handle:
        for name in handle.keys():
            stored = handle.get_tensor(name)
            if keep_stored is not None and name in keep_stored:
                weights[name] = stored
                continue
            if stored.dtype == numpy.dtype("uint16"):
                stored = (stored.astype(numpy.uint32) << 16).view(numpy.float32)
            weights[name] = stored.astype(numpy.float32)
    return weights


def widen(stored: numpy.ndarray) -> numpy.ndarray:
    """Widen one stored tensor to single precision, exactly.

    :param stored: the tensor as safetensors held it.
    :returns: the same values at single precision.
    """
    if stored.dtype == numpy.dtype("uint16"):
        return (stored.astype(numpy.uint32) << 16).view(numpy.float32)
    return stored.astype(numpy.float32)


def _fetch(url: str) -> str:
    """Read one small text file over the network.

    :param url: what to read.
    :returns: its content.
    """
    with urllib.request.urlopen(url) as response:
        return response.read().decode("utf8")


def _require_agreement(
    configuration,
    manifest: dict,
    vocabulary_size: int,
    hidden_size: int,
    layer_count: int,
    expert_width_key: str,
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
    :param expert_width_key: which configuration key holds the expert width, which the two models disagree on.
    :returns: nothing.
    """
    # `expertsForEachToken` is absent from manifests written before the
    # conversion pipeline recorded it, including the published Qwen3-30B-A3B one.
    # A row the manifest does not carry is skipped rather than failed, because
    # the alternative is a forty-minute reconversion to add a number that the
    # configuration already states and that nothing on disk depends on.
    disagreements = []
    checks = [
        ("hidden size", configuration.hidden_size, hidden_size),
        ("vocabulary size", configuration.vocab_size, vocabulary_size),
        ("layer count", configuration.num_hidden_layers, layer_count),
        ("expert width", getattr(configuration, expert_width_key), manifest["expertWidth"]),
        ("experts for each layer", configuration.num_experts, manifest["experts"]["expertsForEachLayer"]),
    ]
    if manifest.get("expertsForEachToken") is not None:
        checks.append(
            ("experts for each token", configuration.num_experts_per_tok, manifest["expertsForEachToken"]),
        )
    for name, published, present in checks:
        if published != present:
            disagreements.append(f"{name}: the configuration says {published}, the files hold {present}")
    if len(disagreements) > 0:
        raise ValueError(
            "the published configuration does not describe these files:\n  " + "\n  ".join(disagreements),
        )


def build_head_graph(weights: dict[str, numpy.ndarray], configuration) -> onnx.ModelProto:
    """Build the final normalization and the language model head as one graph.

    :param weights: the resident weights.
    :param configuration: the model configuration.
    :returns: the model, ready to be serialized.
    """
    nodes: list = []
    initializers: list = []

    normalized = root_mean_square_normalization(
        nodes,
        initializers,
        "final_norm",
        "hidden_state",
        weights[FINAL_NORMALIZATION_TENSOR_NAME],
        configuration.rms_norm_eps,
    )
    initializers.append(initializer("head.weight", weights[HEAD_TENSOR_NAME].T))
    nodes.append(helper.make_node("MatMul", [normalized, "head.weight"], ["logits"]))

    graph = helper.make_graph(
        nodes,
        "language_model_head",
        [helper.make_tensor_value_info(
            "hidden_state", TensorProto.FLOAT, ["batch", "tokens", configuration.hidden_size],
        )],
        [helper.make_tensor_value_info(
            "logits", TensorProto.FLOAT, ["batch", "tokens", configuration.vocab_size],
        )],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", OPSET_VERSION)])
    model.ir_version = IR_VERSION
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


def _refuse_wide_nodes(model: onnx.ModelProto, where: str) -> None:
    """Refuse a graph holding a node that binds more storage buffers than WebGPU allows.

    WebGPU limits how many storage buffers one compute shader may bind, and
    Chrome creates its device with `maxStorageBuffersPerShaderStage` of 8. A node
    whose inputs and outputs together come to more than that has a pipeline that
    never compiles. What makes it worth a check here rather than a comment is how
    it fails: the pipeline is invalid, the submission it belongs to is invalid,
    the values that should have come out of it read back as zeros, and nothing is
    raised. The model loads, generates, and produces nonsense.

    Milestone 6 of https://github.com/webai-at-home/webai-at-home/issues/169 lost
    an afternoon to exactly that, from a single `Concat` of eight copies in the
    grouped-query attention repeat: eight inputs and one output is nine.

    :param model: the graph to check.
    :param where: what to call this graph in the message.
    :raises ValueError: when a node binds too many.
    :returns: nothing.
    """
    for node in model.graph.node:
        bound = len([name for name in node.input if name != ""]) + len([name for name in node.output if name != ""])
        if bound <= STORAGE_BUFFERS_FOR_EACH_SHADER_STAGE:
            continue
        raise ValueError(
            f"{where}: the {node.op_type} node named {node.name or node.output[0]} binds {bound} storage buffers, "
            f"and WebGPU allows {STORAGE_BUFFERS_FOR_EACH_SHADER_STAGE}. Its pipeline would not compile and its "
            "output would read back as zeros without anything being raised. Split it into several nodes.",
        )


def main() -> None:
    """Write every graph, the embedding table, and an index of what was written.

    :returns: nothing.
    """
    parser = argparse.ArgumentParser(description="build the non-expert graphs of a converted model")
    parser.add_argument(
        "--model", required=True, choices=sorted(MODEL_DESCRIPTIONS), help="which model these blocks hold",
    )
    parser.add_argument(
        "--blocks",
        required=True,
        help="the directory written by convert_mixture_of_experts_to_expert_blocks.mjs",
    )
    parser.add_argument("--output", required=True, help="where to write the graphs")
    arguments = parser.parse_args()

    description = MODEL_DESCRIPTIONS[arguments.model]
    blocks_directory = pathlib.Path(arguments.blocks)
    manifest = json.loads((blocks_directory / "manifest.json").read_text())
    if manifest.get("modelName") is not None and manifest["modelName"] != arguments.model:
        raise ValueError(
            f"--model says {arguments.model} and these blocks were converted from {manifest['modelName']}",
        )

    # The configuration is read at the revision the conversion pinned, not at
    # `main`. Two of the numbers it carries — the normalization epsilon and the
    # rotary theta — are not in the shapes on disk and would otherwise be
    # silently taken from the library's defaults. They happen to agree today,
    # and a default that happens to agree is not something to build on.
    published = json.loads(_fetch(
        f"https://huggingface.co/{manifest['sourceRepository']}/resolve/"
        f"{manifest['sourceRevision']}/config.json",
    ))
    configuration = description["configurationClass"](**published)

    weights = load_resident(blocks_directory / "resident.safetensors", {EMBEDDING_TENSOR_NAME})
    embedding = weights[EMBEDDING_TENSOR_NAME]
    vocabulary_size, hidden_size = embedding.shape
    layer_count = manifest["experts"]["layerCount"]
    head_dimension = published.get("head_dim", hidden_size // configuration.num_attention_heads)

    _require_agreement(
        configuration, manifest, vocabulary_size, hidden_size, layer_count, description["expertWidthKey"],
    )

    output_directory = pathlib.Path(arguments.output)
    output_directory.mkdir(parents=True, exist_ok=True)

    print(f"building the non-expert graphs of {manifest['sourceRepository']}")
    print(f"  {layer_count} layers, hidden size {hidden_size}, {configuration.num_attention_heads} query heads and "
          f"{configuration.num_key_value_heads} key and value heads of {head_dimension}, "
          f"vocabulary {vocabulary_size}")
    print(f"  reading {blocks_directory / 'resident.safetensors'}, {len(weights)} tensors")

    written: list[dict] = []
    for layer_index in range(layer_count):
        model = description["layerBuilder"](layer_weights(weights, layer_index), configuration, layer_index)
        _refuse_wide_nodes(model, f"layer {layer_index}")
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

    embedding_element_type = description["embeddingElementType"]
    embedding_name = f"token_embedding.{'bf16' if embedding_element_type == 'bfloat16' else 'f32'}.bin"
    if embedding_element_type == "bfloat16":
        # Whether safetensors hands BF16 back as its own element type or as raw
        # sixteen-bit integers depends on which numpy and which safetensors are
        # installed, and the bytes are the same either way. What must not pass is
        # a tensor that is already wider, because writing that out would produce
        # a file half the length the index claims.
        if embedding.dtype.itemsize != 2:
            raise ValueError(
                f"{EMBEDDING_TENSOR_NAME} is stored as {embedding.dtype}, which is "
                f"{embedding.dtype.itemsize} bytes for each value rather than 2",
            )
        embedding_bytes = numpy.ascontiguousarray(embedding).tobytes()
    else:
        embedding_bytes = numpy.ascontiguousarray(widen(embedding), dtype=numpy.float32).tobytes()
    (output_directory / embedding_name).write_bytes(embedding_bytes)
    print(f"  {embedding_name}, {len(embedding_bytes) / 1024 / 1024:.2f} megabytes, "
          f"{vocabulary_size} rows of {hidden_size} at {embedding_element_type}")

    index = {
        "producedBy": "packages/_onnx_experiments/tools/build_moe_graphs.py",
        "issue": "https://github.com/webai-at-home/webai-at-home/issues/169",
        "modelName": arguments.model,
        "sourceRepository": manifest["sourceRepository"],
        "sourceRevision": manifest["sourceRevision"],
        "elementType": "float32",
        "layerCount": layer_count,
        "hiddenSize": hidden_size,
        "expertWidth": manifest["expertWidth"],
        "headCount": configuration.num_attention_heads,
        "keyValueHeadCount": configuration.num_key_value_heads,
        "headDimension": head_dimension,
        "vocabularySize": vocabulary_size,
        "expertsForEachLayer": manifest["experts"]["expertsForEachLayer"],
        "expertsForEachToken": configuration.num_experts_per_tok,
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
            "fileName": embedding_name,
            "rowCount": int(vocabulary_size),
            "columnCount": int(hidden_size),
            "elementType": embedding_element_type,
        },
        "expertBlocks": {
            "fileName": "expert_blocks.bin",
            "blockByteLength": manifest["experts"]["blockByteLength"],
            "blockIndexFormula": manifest["experts"]["blockIndexFormula"],
            "parts": manifest["experts"]["parts"],
        },
    }
    (output_directory / "graphs.json").write_text(f"{json.dumps(index, indent='\t')}\n")

    total = sum(entry["byteLength"] for entry in written) + len(head) + len(expert) + len(embedding_bytes)
    print(f"\n  wrote {len(written) + 3} files, {total / 1024 / 1024 / 1024:.2f} gigabytes, to {output_directory}")


if __name__ == "__main__":
    main()
