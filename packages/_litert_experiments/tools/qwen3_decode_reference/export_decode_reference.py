#!/usr/bin/env python3
"""Write the autoregressive reference that milestone four of issue #179 is checked against.

Milestone two checked one decode step at one fixed position with an all-zero cache. Milestone four
generates a whole sequence, and every step after the first reads what the previous steps wrote into
the key/value cache. Nothing checked so far exercises that.

This script runs the same decomposition the exported shards implement — the classes come straight out
of `export_qwen3_shards.py`, so there is one definition of the arithmetic and not two — greedily for
`--steps` tokens, and writes down what it saw at every step. It also runs the unsplit Hugging Face
model over the same prompt, greedily, so that the two token sequences can be compared. That comparison
is the numerical-stability question of section 35 of issue #178, asked over a whole sequence rather
than over one token.

Two things are written for every step:

- a fingerprint of each decoder shard's output hidden state: its first eight values and the sum of the
  absolute values of all 1024. A cache that decays, drifts, or is written at the wrong position moves
  the sum long before it moves the sampled token, so the fingerprint catches what the token sequence
  hides.
- the sampled token, and the first eight logits behind it.

The fingerprint is what the resident-cache gate compares against. It can check decoder shard 0 on its
own, without any other shard, because that shard's input at every position is just the embedding row
of the token at that position, and this file lists those tokens.
"""

import argparse
import json
import sys
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "qwen3_litert_shard_export"))

from export_qwen3_shards import Qwen3DecoderShard, Qwen3HeadChunk, rotary_tables  # noqa: E402


###############################################################################
###############################################################################
#	Fingerprints
###############################################################################
###############################################################################


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


def decode_masks(position: int, cache_positions: int) -> tuple[torch.Tensor, torch.Tensor]:
	"""Builds the cache write mask and the attention mask for one position.

	@param position The token position being decoded.
	@param cache_positions How many positions the cache holds.
	@returns The one-hot write mask and the attention mask.
	"""
	write_mask = torch.zeros(1, cache_positions, 1, dtype=torch.float32)
	write_mask[0, position, 0] = 1.0
	attention_mask = torch.full((1, 1, 1, cache_positions), float("-inf"), dtype=torch.float32)
	attention_mask[..., : position + 1] = 0.0
	return write_mask, attention_mask


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--model", default="Qwen/Qwen3-0.6B", help="The model to run.")
	parser.add_argument("--prompt", default="The capital of France is", help="The prompt to decode from.")
	parser.add_argument("--steps", type=int, default=32, help="How many tokens to generate.")
	parser.add_argument("--cache-positions", type=int, default=512, help="Cache positions, matching the export.")
	parser.add_argument(
		"--layers-per-shard",
		type=int,
		default=4,
		help="Decoder layers per shard, matching the export.",
	)
	parser.add_argument(
		"--head-chunks",
		type=int,
		default=3,
		help="Vocabulary slices of the language-model head, matching the export.",
	)
	parser.add_argument("output", type=Path, help="Directory for the generated file")
	arguments = parser.parse_args()

	arguments.output.mkdir(parents=True, exist_ok=True)

	tokenizer = AutoTokenizer.from_pretrained(arguments.model)
	model = AutoModelForCausalLM.from_pretrained(arguments.model, dtype=torch.float32).eval()
	config = model.config
	rope_theta = float(config.rope_parameters["rope_theta"])
	head_dimension = config.head_dim
	key_value_head_count = config.num_key_value_heads
	layer_count = config.num_hidden_layers
	vocabulary_size = config.vocab_size
	cache_positions = arguments.cache_positions

	prompt_tokens = tokenizer(arguments.prompt, return_tensors="pt").input_ids[0].tolist()
	# The last prompt position already produces the first generated token, so generating `steps` tokens
	# needs `steps - 1` positions beyond the prompt, not `steps`.
	total_positions = len(prompt_tokens) + arguments.steps - 1
	if total_positions > cache_positions:
		raise SystemExit(f"{total_positions} positions do not fit in a cache of {cache_positions}.")

	shards = []
	for first_layer in range(0, layer_count, arguments.layers_per_shard):
		last_layer = min(first_layer + arguments.layers_per_shard - 1, layer_count - 1)
		shards.append(
			{
				"name": f"decoder_{first_layer:02d}-{last_layer:02d}",
				"module": Qwen3DecoderShard(model, first_layer, last_layer).eval(),
				"cache": torch.zeros(
					(last_layer - first_layer + 1) * 2,
					key_value_head_count,
					cache_positions,
					head_dimension,
					dtype=torch.float32,
				),
			}
		)

	chunk_size = (vocabulary_size + arguments.head_chunks - 1) // arguments.head_chunks
	head_chunks = []
	for chunk_index in range(arguments.head_chunks):
		first_token = chunk_index * chunk_size
		last_token = min(first_token + chunk_size - 1, vocabulary_size - 1)
		head_chunks.append(
			{
				"name": f"head_{chunk_index}",
				"module": Qwen3HeadChunk(model, first_token, last_token).eval(),
			}
		)

	# The whole prompt is decoded one position at a time, exactly as the browser will: this decomposition
	# has no prefill signature, which is milestone five's job, so a prompt is simply the first few decode
	# steps whose sampled tokens are thrown away.
	steps = []
	input_tokens = list(prompt_tokens)
	generated_tokens = []
	position = 0
	while position < total_positions:
		input_token = input_tokens[position]
		cosine, sine = rotary_tables(position, head_dimension, rope_theta)
		write_mask, attention_mask = decode_masks(position, cache_positions)

		hidden = model.model.embed_tokens(torch.tensor([[input_token]], dtype=torch.long)).detach()
		shard_outputs = []
		with torch.no_grad():
			for shard in shards:
				hidden, shard["cache"] = shard["module"](
					hidden, shard["cache"], cosine, sine, write_mask, attention_mask
				)
				shard_outputs.append({"name": shard["name"], **fingerprint(hidden)})
			logits = torch.cat([chunk["module"](hidden) for chunk in head_chunks], dim=-1)

		sampled_token = int(logits.flatten().argmax())
		steps.append(
			{
				"position": position,
				"inputToken": input_token,
				"isPrompt": position < len(prompt_tokens),
				"shardOutputs": shard_outputs,
				"logitsFirstValues": logits.flatten()[:8].tolist(),
				"sampledToken": sampled_token,
			}
		)

		position += 1
		if position >= len(prompt_tokens):
			input_tokens.append(sampled_token)
			generated_tokens.append(sampled_token)

	# The unsplit model, greedily, over the same prompt. This is what says whether splitting the residual
	# stream across shards changes which token gets sampled — asked over a whole sequence, not one token.
	unsplit_tokens = []
	unsplit_input = torch.tensor([prompt_tokens], dtype=torch.long)
	with torch.no_grad():
		for _ in range(arguments.steps):
			unsplit_logits = model(unsplit_input).logits[0, -1]
			unsplit_token = int(unsplit_logits.argmax())
			unsplit_tokens.append(unsplit_token)
			unsplit_input = torch.cat(
				[unsplit_input, torch.tensor([[unsplit_token]], dtype=torch.long)], dim=1
			)

	if len(generated_tokens) != len(unsplit_tokens):
		raise SystemExit(
			f"{len(generated_tokens)} tokens from the decomposition against "
			f"{len(unsplit_tokens)} from the unsplit model: the two runs are not comparable."
		)

	first_divergence = None
	for index, (split_token, unsplit_token) in enumerate(zip(generated_tokens, unsplit_tokens)):
		if split_token != unsplit_token:
			first_divergence = index
			break

	description = {
		"model": arguments.model,
		"prompt": arguments.prompt,
		"promptTokens": prompt_tokens,
		"cachePositions": cache_positions,
		"hiddenSize": config.hidden_size,
		"headDimension": head_dimension,
		"ropeTheta": rope_theta,
		"vocabularySize": vocabulary_size,
		"embeddingFile": "qwen3_0_6b_embedding.bin",
		"decoderShards": [shard["name"] for shard in shards],
		"headChunks": [chunk["name"] for chunk in head_chunks],
		"inputTokens": input_tokens[:total_positions],
		"generatedTokens": generated_tokens,
		"generatedText": tokenizer.decode(generated_tokens),
		"unsplitTokens": unsplit_tokens,
		"unsplitText": tokenizer.decode(unsplit_tokens),
		"firstDivergence": first_divergence,
		"steps": steps,
	}
	output_path = arguments.output / "decode_reference.json"
	output_path.write_text(json.dumps(description))

	print(f"prompt: {arguments.prompt!r} -> {len(prompt_tokens)} tokens {prompt_tokens}")
	print(f"decomposition generated: {generated_tokens}")
	print(f"  {tokenizer.decode(generated_tokens)!r}")
	print(f"unsplit model generated: {unsplit_tokens}")
	print(f"  {tokenizer.decode(unsplit_tokens)!r}")
	if first_divergence is None:
		print(f"the two token sequences agree on all {len(generated_tokens)} generated tokens")
	else:
		print(f"the two token sequences first differ at generated token {first_divergence}")
	print(f"\nWrote {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
	main()
