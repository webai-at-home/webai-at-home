#!/usr/bin/env python3
"""Export four graphs that differ one property at a time, to find what WebGPU gets wrong.

The milestone one gate found that `shard_like_step` produces wrong numbers on WebGPU and correct
numbers on WebAssembly, identically for every cache shape tried: ranks 3, 4, and 5, and sizes from
half a megabyte to 42 megabytes. Neither the rank nor the size is the trigger.

Two things stand out in the wrong answer. The hidden state comes back as exactly zero, and the cache
comes back updated by the wrong scalar. In `shard_like_step` the hidden state is both an output of
the graph and the input of the operation that computes that scalar, so the suspicion is that WebGPU
mishandles a value that is returned *and* consumed inside the same graph.

These four graphs separate that suspicion into its parts:

- `one_output_hidden_only`: one output, the hidden state. This is milestone zero's graph again, and
  is the control: it was already correct on WebGPU.
- `one_output_cache_only`: one output, the cache, updated by a scalar derived from the hidden state.
  The derived value is consumed but never returned.
- `two_outputs_independent`: two outputs, but the cache is updated by a constant, so nothing is both
  returned and consumed.
- `two_outputs_shared`: two outputs, and the hidden state is both returned and consumed. This is
  `shard_like_step` again, at the small cache size, as the reproduction case.

The cache is kept small throughout, because size has already been ruled out and a small cache makes
the sweep fast.
"""

import argparse
import json
from pathlib import Path

import litert_torch
import torch


###############################################################################
###############################################################################
#	The four graphs
###############################################################################
###############################################################################


class OneOutputHiddenOnly(torch.nn.Module):
	"""Returns the hidden state only. The control, already known to be correct on WebGPU."""

	def __init__(self, hidden_size: int) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)

	def forward(self, hidden_state: torch.Tensor, key_value_cache: torch.Tensor) -> torch.Tensor:
		return self.linear(hidden_state) + key_value_cache.mean() * 0.0


class OneOutputCacheOnly(torch.nn.Module):
	"""Returns the cache only, updated by a scalar derived from the hidden state but never returned."""

	def __init__(self, hidden_size: int) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)

	def forward(self, hidden_state: torch.Tensor, key_value_cache: torch.Tensor) -> torch.Tensor:
		return key_value_cache + self.linear(hidden_state).mean()


class TwoOutputsIndependent(torch.nn.Module):
	"""Returns both, with nothing both returned and consumed: the cache grows by a constant."""

	def __init__(self, hidden_size: int) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)

	def forward(
		self,
		hidden_state: torch.Tensor,
		key_value_cache: torch.Tensor,
	) -> tuple[torch.Tensor, torch.Tensor]:
		return self.linear(hidden_state), key_value_cache + 0.007006107363849878


class TwoOutputsShared(torch.nn.Module):
	"""Returns both, and the hidden state is both returned and consumed. The reproduction case."""

	def __init__(self, hidden_size: int) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)

	def forward(
		self,
		hidden_state: torch.Tensor,
		key_value_cache: torch.Tensor,
	) -> tuple[torch.Tensor, torch.Tensor]:
		new_hidden_state = self.linear(hidden_state)
		return new_hidden_state, key_value_cache + new_hidden_state.mean()


GRAPHS = {
	"one_output_hidden_only": OneOutputHiddenOnly,
	"one_output_cache_only": OneOutputCacheOnly,
	"two_outputs_independent": TwoOutputsIndependent,
	"two_outputs_shared": TwoOutputsShared,
}


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--hidden-size", type=int, default=1024, help="Hidden size. Qwen3-0.6B uses 1024.")
	parser.add_argument("--cache-shape", default="2,8,64,128", help="Cache shape, as comma-separated dimensions.")
	parser.add_argument("output", type=Path, help="Directory for the generated .tflite files and reference JSON files")
	arguments = parser.parse_args()

	arguments.output.mkdir(parents=True, exist_ok=True)
	cache_shape = [int(dimension) for dimension in arguments.cache_shape.split(",")]
	hidden_shape = [1, 1, arguments.hidden_size]

	cache_element_count = 1
	for dimension in cache_shape:
		cache_element_count *= dimension

	names = []
	for name, graph_class in GRAPHS.items():
		# Every graph is seeded the same way, so all four hold the same weights and their answers are comparable.
		torch.manual_seed(arguments.hidden_size)
		graph = graph_class(arguments.hidden_size).eval()

		sample_hidden_state = torch.randn(*hidden_shape)
		sample_cache = torch.zeros(*cache_shape)

		with torch.no_grad():
			produced = graph(sample_hidden_state, sample_cache)

		outputs = produced if isinstance(produced, tuple) else (produced,)
		converted = litert_torch.convert(graph, (sample_hidden_state, sample_cache))
		model_path = arguments.output / f"{name}.tflite"
		converted.export(str(model_path))

		reference_path = arguments.output / f"{name}.reference.json"
		reference_path.write_text(
			json.dumps(
				{
					"name": name,
					"hiddenShape": hidden_shape,
					"cacheShape": cache_shape,
					"cacheElementCount": cache_element_count,
					"hiddenState": sample_hidden_state.flatten().tolist(),
					# One first element per output is enough to tell a right answer from a wrong one here: the
					# wrong answers are wrong by whole factors, not by rounding.
					"expectedFirstValues": [float(output.flatten()[0]) for output in outputs],
					"outputCount": len(outputs),
				}
			)
		)
		names.append(name)
		print(f"Wrote {model_path}: {len(outputs)} output(s), first values {[float(o.flatten()[0]) for o in outputs]}")

	(arguments.output / "index.json").write_text(json.dumps({"names": names}))
	print(f"Wrote {arguments.output / 'index.json'} naming {len(names)} models")


if __name__ == "__main__":
	main()
