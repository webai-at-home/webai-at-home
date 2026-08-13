#!/usr/bin/env python3
"""Assemble a whole converted mixture-of-experts model from its parts and make it generate.

The three gates before this one each checked one piece against a reference: the
expert block decomposes exactly, the non-expert half of a layer reproduces the
reference implementation, and one converted block computes correctly through the
graph that reads it. None of them checks the **wiring**: sixteen layers in the
right order, the key and value cache carried from step to step, the routing
weights applied to the right experts, the final normalization before the head
rather than after it.

Nothing this project owns can check that wiring against a reference, because the
reference is 13.8 gigabytes of weights and a machine with more memory than this
one. But wiring mistakes have a very loud symptom: every one of them turns
fluent text into nonsense. So the check is to generate, and to read what comes
out.

    the model, assembled from 16 layer graphs + 1 head graph + 1 expert graph
    + 1024 expert blocks read straight off the disk, generating greedily

This runs the **same** graphs the browser will run, so a browser that produces
different words has a browser problem rather than an assembly problem. It is not
a bit-for-bit reference: this runs on the processor and the browser runs on the
graphics processor, and two floating point implementations of the same
arithmetic do not agree to the last bit.

No residency layer here on purpose. Every expert is read from the file the
moment it is wanted. That is what makes this the control the browser's two runs
are read against.

Requires: pip install onnx onnxruntime numpy transformers
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time

import numpy
import onnxruntime
from transformers import AutoTokenizer


# The three projections of one expert, in the order a block holds them.
PROJECTION_NAMES = ["gate_proj", "up_proj", "down_proj"]

# How many parts one projection contributes to a block.
PARTS_FOR_EACH_PROJECTION = 3

# What to generate from, and how much. Short on purpose: every token costs 16
# layer runs and 128 expert runs on the processor, and the question this asks is
# answered by a sentence.
DEFAULT_PROMPT = "The capital of France is"
DEFAULT_TOKEN_COUNT = 24


class WholeModel:
    """Every graph and every weight of one converted model, assembled and ready to generate."""

    def __init__(self, graphs_directory: pathlib.Path, blocks_directory: pathlib.Path) -> None:
        """Load every graph, the embedding table, and the expert block file.

        :param graphs_directory: what build_olmoe_graphs.py wrote.
        :param blocks_directory: what convert_mixture_of_experts_to_expert_blocks.ts wrote.
        :returns: nothing.
        """
        self.index = json.loads((graphs_directory / "graphs.json").read_text())
        """What was built, and what shape the model is."""

        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3

        self.layer_sessions = [
            onnxruntime.InferenceSession(
                str(graphs_directory / entry["fileName"]), options, providers=["CPUExecutionProvider"],
            )
            for entry in self.index["layerGraphs"]
        ]
        """One session for each decoder layer's non-expert half."""

        self.head_session = onnxruntime.InferenceSession(
            str(graphs_directory / self.index["headGraph"]), options, providers=["CPUExecutionProvider"],
        )
        """The final normalization and the language model head."""

        self.expert_session = onnxruntime.InferenceSession(
            str(graphs_directory / self.index["expertGraph"]), options, providers=["CPUExecutionProvider"],
        )
        """One expert, with all nine of its weight tensors as runtime inputs."""

        embedding = self.index["tokenEmbedding"]
        self.embedding = numpy.memmap(
            graphs_directory / embedding["fileName"],
            dtype=numpy.uint16 if embedding["elementType"] == "bfloat16" else numpy.float32,
            mode="r",
            shape=(embedding["rowCount"], embedding["columnCount"]),
        )
        """The token embedding table, looked up rather than multiplied."""

        self.embedding_is_brain_float = embedding["elementType"] == "bfloat16"
        """Whether a row has to be widened before use. BF16 is the top sixteen bits of a single precision value, so
        widening is an exact shift rather than a conversion."""

        self.blocks = numpy.memmap(
            blocks_directory / self.index["expertBlocks"]["fileName"], dtype=numpy.uint8, mode="r",
        )
        """Every expert block, in one file, read at a computed offset."""

        self.inverse_frequencies = 1.0 / (
            self.index["rotaryTheta"]
            ** (numpy.arange(0, self.index["headDimension"], 2, dtype=numpy.float32)
                / self.index["headDimension"])
        )
        """The rotary frequencies, which depend only on the position and are the same for every layer."""

        self.expert_read_count = 0
        """How many expert blocks have been read, which is the figure a residency layer exists to reduce."""

    def embed(self, token_id: int) -> numpy.ndarray:
        """Look one token's row out of the embedding table.

        :param token_id: which token.
        :returns: its row at single precision, shaped for one token of one batch.
        """
        row = self.embedding[token_id]
        if self.embedding_is_brain_float:
            row = (numpy.asarray(row, dtype=numpy.uint32) << 16).view(numpy.float32)
        return numpy.asarray(row, dtype=numpy.float32).reshape(1, 1, -1)

    def rotary(self, position: int) -> tuple[numpy.ndarray, numpy.ndarray]:
        """Build the cosine and sine tables for one position.

        :param position: which position in the sequence.
        :returns: the cosine and the sine, each shaped (1, 1, 1, head width).
        """
        angles = numpy.float32(position) * self.inverse_frequencies
        doubled = numpy.concatenate([angles, angles])
        shape = (1, 1, 1, self.index["headDimension"])
        return numpy.cos(doubled).reshape(shape).astype(numpy.float32), \
            numpy.sin(doubled).reshape(shape).astype(numpy.float32)

    def expert_feeds(self, layer_index: int, expert_index: int) -> dict[str, numpy.ndarray]:
        """Read one expert block off the disk and turn its nine parts into the graph's nine inputs.

        :param layer_index: which layer the expert belongs to.
        :param expert_index: which expert of that layer.
        :returns: the nine weight tensors, keyed by input name.
        """
        blocks = self.index["expertBlocks"]
        block_number = layer_index * self.index["expertsForEachLayer"] + expert_index
        start = block_number * blocks["blockByteLength"]
        block = self.blocks[start:start + blocks["blockByteLength"]]
        self.expert_read_count += 1

        block_size = self.index["expertBlocks"].get("blockSize", 32)
        feeds: dict[str, numpy.ndarray] = {}
        for index, name in enumerate(PROJECTION_NAMES):
            input_size = self.index["expertWidth"] if name == "down_proj" else self.index["hiddenSize"]
            output_size = self.index["hiddenSize"] if name == "down_proj" else self.index["expertWidth"]
            blocks_for_each_row = -(-input_size // block_size)

            quantized_part = blocks["parts"][index * PARTS_FOR_EACH_PROJECTION]
            scales_part = blocks["parts"][index * PARTS_FOR_EACH_PROJECTION + 1]
            zero_points_part = blocks["parts"][index * PARTS_FOR_EACH_PROJECTION + 2]

            feeds[f"{name}_quantized"] = numpy.asarray(
                block[quantized_part["offset"]:quantized_part["offset"] + quantized_part["byteLength"]],
            ).reshape(output_size, blocks_for_each_row, block_size * 4 // 8)
            feeds[f"{name}_scales"] = numpy.asarray(
                block[scales_part["offset"]:scales_part["offset"] + scales_part["byteLength"]],
            ).view(numpy.float16)
            feeds[f"{name}_zero_points"] = numpy.asarray(
                block[zero_points_part["offset"]:zero_points_part["offset"] + zero_points_part["byteLength"]],
            )
        return feeds

    def experts_for_one_token(
        self, layer_index: int, expert_input: numpy.ndarray, router_logits: numpy.ndarray,
    ) -> numpy.ndarray:
        """Route one token and add up the experts it chose.

        The softmax is taken in single precision over all 64 experts before the
        top-k, and the eight weights are left exactly as they come out. OLMoE
        sets `norm_topk_prob` to false, and renormalising them — which many
        implementations do — multiplies every contribution by about 2.64 while
        leaving the output looking entirely reasonable.

        :param layer_index: which layer.
        :param expert_input: what the layer graph produced for the experts.
        :param router_logits: what the layer graph's router produced.
        :returns: the expert block output, shaped like the input.
        """
        logits = router_logits.reshape(-1).astype(numpy.float32)
        shifted = logits - logits.max()
        probabilities = numpy.exp(shifted) / numpy.exp(shifted).sum()

        chosen = numpy.argsort(-probabilities, kind="stable")[:self.index["expertsForEachToken"]]
        weights = probabilities[chosen]
        # Qwen3-30B-A3B sets norm_topk_prob true and OLMoE-1B-7B-0924 sets it
        # false, so this is read out of the model rather than assumed either way.
        # Getting it wrong scales every expert's contribution — by about 2.64 in
        # one direction for OLMoE — and leaves the output looking reasonable.
        if self.index["normalizeTopExpertWeights"]:
            weights = weights / weights.sum()

        total = numpy.zeros_like(expert_input)
        for position, expert_index in enumerate(chosen):
            feeds = self.expert_feeds(layer_index, int(expert_index))
            feeds["expert_input"] = expert_input
            contribution = self.expert_session.run(None, feeds)[0]
            total = total + contribution * numpy.float32(weights[position])
        return total

    def generate(self, token_ids: list[int], new_token_count: int, report) -> list[int]:
        """Generate greedily, one token at a time, from a prompt.

        One token at a time throughout, including the prompt. Feeding the prompt
        in one pass would be faster and would need a causal mask; decoding one
        token at a time needs no mask at all, since that token may attend to the
        whole history. This is the milestone about correctness, so it takes the
        shape with fewer ways to be wrong.

        :param token_ids: the prompt.
        :param new_token_count: how many tokens to generate after it.
        :param report: called with each newly generated token id.
        :returns: the prompt followed by what was generated.
        """
        # The cache holds the key and value heads, of which Qwen3-30B-A3B has a
        # quarter as many as it has query heads. Sizing this from the query head
        # count instead gives a cache eight times too large that the graph then
        # refuses.
        head_count = self.index["keyValueHeadCount"]
        head_dimension = self.index["headDimension"]
        past_keys = [
            numpy.zeros((1, head_count, 0, head_dimension), dtype=numpy.float32)
            for _ in self.layer_sessions
        ]
        past_values = [
            numpy.zeros((1, head_count, 0, head_dimension), dtype=numpy.float32)
            for _ in self.layer_sessions
        ]

        produced = list(token_ids)
        for step in range(len(token_ids) + new_token_count - 1):
            position = step
            current = produced[step]
            hidden = self.embed(current)
            cosine, sine = self.rotary(position)
            # Every token may attend to the whole history, so the bias is zero
            # everywhere. It exists as an input because the graph is also correct
            # for a multi-token pass, which does need one.
            bias = numpy.zeros((1, 1, 1, position + 1), dtype=numpy.float32)

            for layer_index, session in enumerate(self.layer_sessions):
                residual, expert_input, router_logits, present_key, present_value = session.run(None, {
                    "hidden_state": hidden,
                    "past_key": past_keys[layer_index],
                    "past_value": past_values[layer_index],
                    "cos": cosine,
                    "sin": sine,
                    "attention_bias": bias,
                })
                past_keys[layer_index] = present_key
                past_values[layer_index] = present_value
                hidden = residual + self.experts_for_one_token(layer_index, expert_input, router_logits)

            if step + 1 < len(token_ids):
                continue

            logits = self.head_session.run(None, {"hidden_state": hidden})[0]
            next_token = int(numpy.argmax(logits.reshape(-1)))
            produced.append(next_token)
            report(next_token)

        return produced


def main() -> None:
    """Assemble the model, generate, and print what came out.

    :returns: nothing.
    """
    parser = argparse.ArgumentParser(description="assemble a whole converted model and make it generate")
    parser.add_argument("--graphs", required=True, help="the directory written by build_olmoe_graphs.py")
    parser.add_argument("--blocks", required=True, help="the directory holding expert_blocks.bin")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="what to generate from")
    parser.add_argument("--tokens", type=int, default=DEFAULT_TOKEN_COUNT, help="how many tokens to generate")
    arguments = parser.parse_args()

    model = WholeModel(pathlib.Path(arguments.graphs), pathlib.Path(arguments.blocks))
    print(f"gate: does the assembled {model.index['sourceRepository']} generate anything that reads as English?")
    print(f"  {model.index['layerCount']} layer graphs, one head graph, one expert graph of 1379 bytes")
    print(f"  {model.index['expertsForEachLayer'] * model.index['layerCount']} expert blocks on disk, "
          f"{model.index['expertsForEachToken']} chosen for each token of each layer")
    print(f"  read at revision {model.index['sourceRevision']}")

    tokenizer = AutoTokenizer.from_pretrained(
        model.index["sourceRepository"], revision=model.index["sourceRevision"],
    )
    prompt_ids = tokenizer(arguments.prompt, return_tensors=None)["input_ids"]
    print(f"\n  prompt: {arguments.prompt!r}, which is {len(prompt_ids)} tokens")
    print(f"  generating {arguments.tokens} tokens, greedily, one at a time\n")

    started = time.time()
    pieces: list[str] = []

    def report(token_id: int) -> None:
        """Print each token as it arrives, so a run that is going wrong shows it early.

        :param token_id: the token just generated.
        :returns: nothing.
        """
        pieces.append(tokenizer.decode([token_id]))
        print(f"    {''.join(pieces)}")

    produced = model.generate(prompt_ids, arguments.tokens, report)
    elapsed = time.time() - started

    print(f"\n  {arguments.prompt}{''.join(pieces)}")
    print(f"\n  {len(produced) - len(prompt_ids)} tokens in {elapsed:.1f} seconds, "
          f"{elapsed / max(1, len(produced) - len(prompt_ids)):.2f} seconds each")
    print(f"  {model.expert_read_count} expert blocks read, with no residency layer and no cache at all, "
          f"which is {model.expert_read_count * model.index['expertBlocks']['blockByteLength'] / 1024 / 1024:.0f} "
          "megabytes")
    print("\n  Read the text above. Wiring mistakes do not produce fluent sentences.")


if __name__ == "__main__":
    main()
