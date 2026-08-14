#!/usr/bin/env python3
"""Export a trivial PyTorch module to a single .tflite file, for the milestone zero gate.

This is deliberately not a transformer. Milestone zero of issue #179 asks one question only:
does @litertjs/core load a .tflite graph and compile it for WebGPU in a real browser? A single
linear layer answers that question, and it keeps the export path itself out of the way, because
whether a real transformer converts is milestone two's question and not this one.

The module is `y = x @ weight + bias`, with `x` shaped `[1, 1, hidden_size]`, which is the shape
one shard boundary carries during decoding. Alongside the .tflite file the script writes a
reference JSON file holding one input and the output PyTorch produced for it, so the browser page
can state a real numerical difference rather than the word "matches".
"""

import argparse
import json
from pathlib import Path

import litert_torch
import torch


###############################################################################
###############################################################################
#	TrivialShard — one linear layer with the shape of a shard boundary
###############################################################################
###############################################################################


class TrivialShard(torch.nn.Module):
	"""A single linear layer whose input and output both have the shape of a shard boundary."""

	def __init__(self, hidden_size: int) -> None:
		super().__init__()
		self.linear = torch.nn.Linear(hidden_size, hidden_size)

	def forward(self, hidden_state: torch.Tensor) -> torch.Tensor:
		return self.linear(hidden_state)


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"--hidden-size",
		type=int,
		action="append",
		dest="hidden_sizes",
		help="A hidden size to export. May be repeated. Defaults to 1024 and 4096.",
	)
	parser.add_argument(
		"output",
		type=Path,
		help="Directory for the generated .tflite files and their reference JSON files",
	)
	arguments = parser.parse_args()

	hidden_sizes = arguments.hidden_sizes if arguments.hidden_sizes else [1024, 4096]
	arguments.output.mkdir(parents=True, exist_ok=True)

	for hidden_size in hidden_sizes:
		# The seed is fixed so that re-running the export produces the same weights, and so that a
		# difference seen in the browser is a difference in the runtime rather than in the weights.
		torch.manual_seed(hidden_size)

		shard = TrivialShard(hidden_size).eval()
		sample_input = torch.randn(1, 1, hidden_size)

		with torch.no_grad():
			expected_output = shard(sample_input)

		converted = litert_torch.convert(shard, (sample_input,))
		model_path = arguments.output / f"trivial_shard_{hidden_size}.tflite"
		converted.export(str(model_path))

		reference_path = arguments.output / f"trivial_shard_{hidden_size}.reference.json"
		reference_path.write_text(
			json.dumps(
				{
					"hiddenSize": hidden_size,
					"shape": [1, 1, hidden_size],
					"input": sample_input.flatten().tolist(),
					"expectedOutput": expected_output.flatten().tolist(),
				}
			)
		)

		print(
			f"Wrote {model_path} ({model_path.stat().st_size} bytes) "
			f"and {reference_path} ({reference_path.stat().st_size} bytes)"
		)


if __name__ == "__main__":
	main()
