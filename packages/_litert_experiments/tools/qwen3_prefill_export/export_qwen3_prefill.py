#!/usr/bin/env python3
"""Export one `.tflite` graph per prompt length, for milestone five of issue #179.

Static shapes mean one exported signature per prompt length, so a prompt of 32 tokens and a prompt of
128 tokens are two different graphs of the same weights. This script writes `--prefill-lengths` of them
for every decoder shard, and the reference values PyTorch produced for each.

Prefill is simpler than decode rather than harder, because it starts at position 0: there is no cache to
read and no position to write at. `Qwen3PrefillShard` therefore takes only the hidden states, the rotary
tables, and a causal mask, and returns its own keys and values followed by zeros. It shares every piece of
arithmetic with `Qwen3DecoderShard` by inheriting from it, so the two cannot drift apart.

The language-model head is not re-exported. Only the last position's hidden state is needed to choose the
next token, so the decode head chunks already do the job.

The cache a prefill graph writes has exactly the shape a decode graph reads, which is what lets a prompt be
read in one call and then be continued one token at a time.
"""

import argparse
import json
import sys
from pathlib import Path

import litert_torch
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "qwen3_litert_shard_export"))

from export_qwen3_shards import Qwen3HeadChunk, Qwen3PrefillShard  # noqa: E402


###############################################################################
###############################################################################
#	Prefill inputs
###############################################################################
###############################################################################


def prefill_rotary_tables(length: int, head_dimension: int, rope_theta: float) -> tuple[torch.Tensor, torch.Tensor]:
	"""Builds the rotary cosine and sine for positions 0 to length - 1.

	@param length How many positions the prompt covers.
	@param head_dimension The head dimension.
	@param rope_theta The rotary base.
	@returns The cosine and the sine, each shaped [1, 1, length, head dimension].
	"""
	positions = torch.arange(length, dtype=torch.float32)
	inverse_frequencies = 1.0 / (
		rope_theta ** (torch.arange(0, head_dimension, 2, dtype=torch.float32) / head_dimension)
	)
	angles = positions.unsqueeze(1) * inverse_frequencies.unsqueeze(0)
	doubled = torch.cat((angles, angles), dim=-1)
	return (
		doubled.cos().view(1, 1, length, head_dimension),
		doubled.sin().view(1, 1, length, head_dimension),
	)


def prefill_attention_mask(length: int, repeat_count: int) -> torch.Tensor:
	"""Builds the causal mask, already laid out for the folded grouped-query attention.

	The mask is tiled across the repeat axis here rather than inside the graph, because tiling it inside
	would be a widening operation and the WebGPU delegate refuses those.

	@param length How many positions the prompt covers.
	@param repeat_count How many query heads share one key/value head.
	@returns The mask, shaped [1, repeat count x length, length].
	"""
	causal = torch.triu(torch.full((length, length), float("-inf")), diagonal=1)
	return causal.repeat(repeat_count, 1).view(1, repeat_count * length, length)


def fingerprint(values: torch.Tensor) -> dict:
	"""Reduces a tensor to the few numbers the browser compares against.

	@param values The tensor to fingerprint.
	@returns Its first eight values and the sum of the absolute values of all of them.
	"""
	flattened = values.flatten()
	return {
		"firstValues": flattened[:8].tolist(),
		"absoluteSum": float(flattened.abs().sum()),
	}


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--model", default="Qwen/Qwen3-0.6B", help="The model to split.")
	parser.add_argument(
		"--prefill-length",
		type=int,
		action="append",
		dest="prefill_lengths",
		help=(
			"One graph is written per length, per decoder shard. Repeatable; defaults to 32, 128 and 512. "
			"Repeatable rather than a list, because a list would swallow the output directory after it."
		),
	)
	parser.add_argument("--cache-positions", type=int, default=512, help="Cache positions, matching the export.")
	parser.add_argument("--layers-per-shard", type=int, default=4, help="Decoder layers per shard.")
	parser.add_argument("--head-chunks", type=int, default=3, help="Vocabulary slices of the head.")
	parser.add_argument(
		"--only",
		action="append",
		help="Convert only the named decoder shards, such as decoder_00-03. Repeatable.",
	)
	parser.add_argument(
		"--skip-conversion",
		action="store_true",
		help="Rewrite the reference files without repeating the expensive litert_torch.convert.",
	)
	parser.add_argument("output", type=Path, help="Directory for the generated files")
	arguments = parser.parse_args()
	if arguments.prefill_lengths is None:
		arguments.prefill_lengths = [32, 128, 512]

	arguments.output.mkdir(parents=True, exist_ok=True)

	tokenizer = AutoTokenizer.from_pretrained(arguments.model)
	model = AutoModelForCausalLM.from_pretrained(arguments.model, dtype=torch.float32).eval()
	config = model.config
	rope_theta = float(config.rope_parameters["rope_theta"])
	head_dimension = config.head_dim
	key_value_head_count = config.num_key_value_heads
	repeat_count = config.num_attention_heads // key_value_head_count
	layer_count = config.num_hidden_layers
	longest = max(arguments.prefill_lengths)

	if longest > arguments.cache_positions:
		raise SystemExit(f"A prompt of {longest} does not fit in a cache of {arguments.cache_positions}.")

	# One real text, long enough for the longest prompt asked for. Every shorter length takes its first
	# tokens, so the lengths are directly comparable: the same prompt, read in one call of a different size.
	text = (
		"The history of computing begins long before the electronic computer. Mechanical aids to calculation "
		"appeared in many cultures, and the idea of a programmable machine was written down more than a "
		"century before one could be built. What changed in the twentieth century was not the idea but the "
		"materials. Relays gave way to vacuum tubes, tubes to transistors, and transistors to integrated "
		"circuits, and each step made the machines smaller, cheaper, and more reliable at the same time. "
	)
	tokens: list[int] = []
	while len(tokens) < longest:
		tokens.extend(tokenizer(text, return_tensors="pt").input_ids[0].tolist())
	tokens = tokens[:longest]

	boundaries = [
		(first, min(first + arguments.layers_per_shard - 1, layer_count - 1))
		for first in range(0, layer_count, arguments.layers_per_shard)
	]
	chunk_size = (config.vocab_size + arguments.head_chunks - 1) // arguments.head_chunks
	head_chunks = [
		Qwen3HeadChunk(model, index * chunk_size, min((index + 1) * chunk_size - 1, config.vocab_size - 1)).eval()
		for index in range(arguments.head_chunks)
	]

	descriptions = []
	for length in arguments.prefill_lengths:
		cosine, sine = prefill_rotary_tables(length, head_dimension, rope_theta)
		attention_mask = prefill_attention_mask(length, repeat_count)
		hidden = model.model.embed_tokens(torch.tensor([tokens[:length]], dtype=torch.long)).detach()
		embedding_rows = hidden

		shard_outputs = []
		largest_file = 0
		for first_layer, last_layer in boundaries:
			name = f"decoder_{first_layer:02d}-{last_layer:02d}"
			output_name = f"prefill_{length}_{name}"
			shard = Qwen3PrefillShard(model, first_layer, last_layer, length, arguments.cache_positions).eval()

			shard_input = hidden
			with torch.no_grad():
				hidden, produced_cache = shard(shard_input, cosine, sine, attention_mask)

			model_path = arguments.output / f"qwen3_0_6b_{output_name}.tflite"
			if arguments.skip_conversion is False and (arguments.only is None or name in arguments.only):
				converted = litert_torch.convert(shard, (shard_input, cosine, sine, attention_mask))
				converted.export(str(model_path))

			file_bytes = model_path.stat().st_size if model_path.exists() else None
			largest_file = max(largest_file, file_bytes or 0)
			shard_outputs.append(
				{
					"name": output_name,
					"referenceName": name,
					"firstLayer": first_layer,
					"lastLayer": last_layer,
					"cacheShape": [
						(last_layer - first_layer + 1) * 2,
						key_value_head_count,
						arguments.cache_positions,
						head_dimension,
					],
					"hidden": fingerprint(hidden),
					"lastRow": fingerprint(hidden[:, -1:, :]),
					"cache": fingerprint(produced_cache),
					"fileBytes": file_bytes,
				}
			)
			print(f"{output_name}: {(file_bytes or 0) / 1e6:.1f} MB")

		last_row = hidden[:, -1:, :]
		with torch.no_grad():
			logits = torch.cat([chunk(last_row) for chunk in head_chunks], dim=-1)
			unsplit_logits = model(torch.tensor([tokens[:length]], dtype=torch.long)).logits[0, -1]

		descriptions.append(
			{
				"length": length,
				"tokens": tokens[:length],
				"embeddingRowsFingerprint": fingerprint(embedding_rows),
				"shardOutputs": shard_outputs,
				"logitsFirstValues": logits.flatten()[:8].tolist(),
				"argmaxToken": int(logits.flatten().argmax()),
				"unsplitArgmaxToken": int(unsplit_logits.argmax()),
				"largestFileBytes": largest_file,
				"activationBytes": length * config.hidden_size * 4,
			}
		)
		print(
			f"  length {length}: token {int(logits.flatten().argmax())}, "
			f"unsplit model {int(unsplit_logits.argmax())}, "
			f"activation {length * config.hidden_size * 4} bytes"
		)

	index_path = arguments.output / "prefill_index.json"
	index_path.write_text(
		json.dumps(
			{
				"model": arguments.model,
				"cachePositions": arguments.cache_positions,
				"hiddenSize": config.hidden_size,
				"headDimension": head_dimension,
				"ropeTheta": rope_theta,
				"repeatCount": repeat_count,
				"vocabularySize": config.vocab_size,
				"embeddingFile": "qwen3_0_6b_embedding.bin",
				"headChunks": [f"head_{index}" for index in range(arguments.head_chunks)],
				"prefills": descriptions,
			}
		)
	)
	print(f"\nWrote {index_path}")


if __name__ == "__main__":
	main()
