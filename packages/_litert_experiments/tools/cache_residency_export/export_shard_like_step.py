#!/usr/bin/env python3
"""Export a shard-shaped step to a single .tflite file, for the milestone one gate.

Milestone one of issue #179 asks whether a shard's own key/value cache can stay resident on the
graphics processor between repeated `model.run()` calls, instead of being copied out to JavaScript
and back on every generated token.

The module exported here is not a transformer. It is the smallest thing that has the *shape* of one
decoding step of one shard:

    inputs:   hidden state, key/value cache
    outputs:  new hidden state, updated key/value cache

That shape is what the question needs. The new hidden state is the tensor that has to leave the
graphics processor on every token, because the next shard is on another device. The updated cache is
the tensor that must never leave it. A graph with one of each lets the browser page feed the cache
output straight back into the next call and read back only the hidden state.

The cache update is `cache + scalar`, an elementwise pass over the whole cache. That is deliberately
not a realistic write, which would touch one position only. It is the memory-bandwidth floor of any
update that reads and writes the whole tensor, so it keeps the measurement honest about the cache
being genuinely read and genuinely written, without pulling in the question of which write strategy
converts cleanly. Which write strategy to use is milestone four's question.

The cache dimensions default to one shard of Qwen3-0.6B: 10 of its 28 decoder layers, 8 key/value
heads, a head dimension of 128, and 512 cache positions.
"""

import argparse
import json
from pathlib import Path

import litert_torch
import torch


###############################################################################
###############################################################################
#	ShardLikeStep — one decoding step of one shard, in shape only
###############################################################################
###############################################################################


# How much every cache element grows in one step, when the update is a constant. The value is the one the
# derived update happened to produce, so that both forms of the graph are directly comparable.
CONSTANT_INCREMENT = 0.007006107363849878


class ShardLikeStep(torch.nn.Module):
	"""A step with the input and output shape of one shard decoding one token."""

	def __init__(self, hidden_size: int, update: str) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)
		self.update = update

	def forward(
		self,
		hidden_state: torch.Tensor,
		key_value_cache: torch.Tensor,
	) -> tuple[torch.Tensor, torch.Tensor]:
		new_hidden_state = self.linear(hidden_state)
		if self.update == "derived":
			# Deriving the increment from the hidden state makes the cache update depend on the input, which is
			# what a real shard does. It is also what WebGPU computes wrongly: the reduction and its broadcast are
			# miscomputed, as the multiple output diagnosis shows. Keep this form only to reproduce that.
			return new_hidden_state, key_value_cache + new_hidden_state.mean()
		return new_hidden_state, key_value_cache + CONSTANT_INCREMENT


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


# One shard of Qwen3-0.6B owns 10 of its 28 decoder layers, and Qwen3-0.6B has 8 key/value heads and a head
# dimension of 128. At 512 cache positions that is 10,485,760 elements, or 41,943,040 bytes.
#
# The same 10,485,760 elements are written at three different ranks, and a fourth, much smaller cache is written at
# rank 4. Rank and size are varied separately on purpose: WebGPU returns wrong numbers for the natural rank-5 cache,
# and telling apart "the rank is too high" from "the tensor is too large" needs both to move independently.
DEFAULT_CACHE_SHAPES = (
	[10, 2, 8, 512, 128],
	[20, 8, 512, 128],
	[20, 8, 65536],
	[2, 8, 64, 128],
)


def export_one(output_directory: Path, hidden_size: int, cache_shape: list[int], update: str) -> None:
	"""Exports one shard-shaped step for one cache shape.

	@param output_directory Where to write the .tflite file and its reference JSON file.
	@param hidden_size The hidden size, which is the width of the hidden state.
	@param cache_shape The shape of the key/value cache this shard owns.
	@param update Whether the cache increment is `derived` from the hidden state or a `constant`.
	@returns Nothing.
	"""
	hidden_shape = [1, 1, hidden_size]
	name = "x".join(str(dimension) for dimension in cache_shape) + f"_{update}"

	torch.manual_seed(hidden_size)
	step = ShardLikeStep(hidden_size, update).eval()

	sample_hidden_state = torch.randn(*hidden_shape)
	sample_cache = torch.zeros(*cache_shape)

	with torch.no_grad():
		expected_hidden_state, expected_cache = step(sample_hidden_state, sample_cache)

	converted = litert_torch.convert(step, (sample_hidden_state, sample_cache))
	model_path = output_directory / f"shard_like_step_{name}.tflite"
	converted.export(str(model_path))

	cache_element_count = 1
	for dimension in cache_shape:
		cache_element_count *= dimension

	reference_path = output_directory / f"shard_like_step_{name}.reference.json"
	reference_path.write_text(
		json.dumps(
			{
				"name": name,
				"update": update,
				"cacheRank": len(cache_shape),
				"hiddenShape": hidden_shape,
				"cacheShape": cache_shape,
				"cacheElementCount": cache_element_count,
				"cacheBytes": cache_element_count * 4,
				"hiddenState": sample_hidden_state.flatten().tolist(),
				"expectedHiddenState": expected_hidden_state.flatten().tolist(),
				# The cache starts at zero and every element is updated by the same scalar, so one number
				# describes the whole expected cache and 42 megabytes of it need not be written down.
				"expectedCacheIncrementPerStep": float(expected_cache.flatten()[0]),
			}
		)
	)

	print(
		f"Wrote {model_path} ({model_path.stat().st_size} bytes): cache shape {cache_shape}, "
		f"rank {len(cache_shape)}, {cache_element_count} elements, {cache_element_count * 4} bytes"
	)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--hidden-size", type=int, default=1024, help="Hidden size. Qwen3-0.6B uses 1024.")
	parser.add_argument(
		"--cache-shape",
		action="append",
		dest="cache_shapes",
		help="A cache shape, written as comma-separated dimensions. May be repeated.",
	)
	parser.add_argument(
		"--update",
		action="append",
		dest="updates",
		choices=["constant", "derived"],
		help="Whether the cache increment is derived from the hidden state or a constant. May be repeated.",
	)
	parser.add_argument("output", type=Path, help="Directory for the generated .tflite files and reference JSON files")
	arguments = parser.parse_args()

	updates = arguments.updates if arguments.updates else ["constant", "derived"]
	cache_shapes = (
		[[int(dimension) for dimension in shape.split(",")] for shape in arguments.cache_shapes]
		if arguments.cache_shapes
		else [list(shape) for shape in DEFAULT_CACHE_SHAPES]
	)

	arguments.output.mkdir(parents=True, exist_ok=True)

	names = []
	for cache_shape in cache_shapes:
		for update in updates:
			export_one(arguments.output, arguments.hidden_size, cache_shape, update)
			names.append("x".join(str(dimension) for dimension in cache_shape) + f"_{update}")

	# The browser page reads this list rather than being told the shapes twice.
	(arguments.output / "index.json").write_text(json.dumps({"names": names}))
	print(f"Wrote {arguments.output / 'index.json'} naming {len(names)} models")


if __name__ == "__main__":
	main()
