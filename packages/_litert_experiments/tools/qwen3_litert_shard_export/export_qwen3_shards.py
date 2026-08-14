#!/usr/bin/env python3
"""Export Qwen3-0.6B as independently runnable .tflite shards, for milestone two of issue #179.

The first attempt at this milestone split Qwen3-0.6B into the three shards the ONNX Runtime Web
experiment uses — decoder layers 0-8, 9-18, and 19-27. All three converted, and none of them could
be loaded: `loadAndCompile()` in `@litertjs/core` 2.5.3 fails above roughly 460 megabytes, and the
three shards were 629 to 1189 megabytes.

Nothing forces three shards. Section 28 of issue #178 already contemplates exporting several shard
granularities and composing larger stages from them. So this script splits finer, and separates the
three things that were making the shards large for three different reasons:

    the token embedding      622 MB, and needed one row at a time
    the decoder layers       62.9 MB each, 28 of them
    the language-model head  622 MB, one matrix multiplication

- **The token embedding is not exported at all.** Decoding one token needs exactly one row of it,
  1024 floats. It is written as a raw binary file, and the browser fetches the 4096 bytes it needs
  with an HTTP range request. A 622 megabyte constant inside a graph would be the single largest
  thing in the whole model, and it buys nothing that a range request does not.
- **The decoder layers are grouped `--layers-per-shard` at a time**, four by default, which is
  251.7 megabytes per shard — comfortably below the 441 megabyte file that was measured loading.
- **The language-model head is split across the vocabulary** into `--head-chunks` pieces, three by
  default, which is 207.4 megabytes each. Each chunk produces the logits for its own slice of the
  vocabulary, and the slices concatenate to the whole. Each chunk applies the final normalization
  itself, which duplicates 1024 floats of weight per chunk and costs nothing worth counting.

Everything that would otherwise need a dynamic shape is passed in as a tensor: the rotary cosine and
sine for the current position, the attention mask over the whole cache, and a one-hot mask naming the
cache position being written. This keeps every dimension static, which the conversion path requires.

Every cache is rank 4, `[layers in this shard x 2, key/value heads, cache positions, head dimension]`.
The natural rank-5 layout forces the WebGPU boundary to host memory and destroys residency; this was
measured in milestone one.

Grouped-query attention is written the way `--attention-layout grouped` describes, folding the query
heads down onto their own key/value head. The obvious way round — widening the key/value heads up to
the query heads with `expand` — emits BROADCAST_TO, which the WebGPU delegate of `@litertjs/core`
2.5.3 refuses. One refused operation sends 273 of the graph's 355 operations to the central processor,
which makes the shard about ten times slower per step and turns a resident key/value cache from a
2.6 to 3.1 times saving into a 4.9 times penalty. Measured in milestone four of issue #179.
"""

import argparse
import json
from pathlib import Path

import litert_torch
import torch
from transformers import AutoModelForCausalLM


###############################################################################
###############################################################################
#	Qwen3DecoderShard — a contiguous run of decoder layers, with its own cache
###############################################################################
###############################################################################


class Qwen3DecoderShard(torch.nn.Module):
	"""A contiguous run of Qwen3-0.6B decoder layers, owning only its own key/value cache."""

	def __init__(self, model, first_layer: int, last_layer: int, attention_layout: str = "expand") -> None:
		super().__init__()
		self.first_layer = first_layer
		self.last_layer = last_layer
		self.layers = torch.nn.ModuleList(model.model.layers[first_layer : last_layer + 1])
		self.head_dimension = model.config.head_dim
		self.query_head_count = model.config.num_attention_heads
		self.key_value_head_count = model.config.num_key_value_heads
		self.repeat_count = self.query_head_count // self.key_value_head_count
		self.normalization_epsilon = model.config.rms_norm_eps
		self.attention_layout = attention_layout

	def _root_mean_square_norm(self, values: torch.Tensor, weight: torch.Tensor) -> torch.Tensor:
		"""Applies one root-mean-square normalization.

		@param values The tensor to normalize.
		@param weight The learned scale.
		@returns The normalized tensor.
		"""
		variance = values.pow(2).mean(-1, keepdim=True)
		return weight * (values * torch.rsqrt(variance + self.normalization_epsilon))

	def _apply_rotary(self, values: torch.Tensor, cosine: torch.Tensor, sine: torch.Tensor) -> torch.Tensor:
		"""Applies the rotary position embedding to one tensor of heads.

		@param values The tensor, shaped [1, heads, 1, head dimension].
		@param cosine The cosine for the current position, shaped [1, 1, 1, head dimension].
		@param sine The sine for the current position, shaped [1, 1, 1, head dimension].
		@returns The rotated tensor.
		"""
		half = values.shape[-1] // 2
		first = values[..., :half]
		second = values[..., half:]
		rotated = torch.cat((-second, first), dim=-1)
		return values * cosine + rotated * sine

	def forward(
		self,
		hidden: torch.Tensor,
		key_value_cache: torch.Tensor,
		rotary_cosine: torch.Tensor,
		rotary_sine: torch.Tensor,
		write_mask: torch.Tensor,
		attention_mask: torch.Tensor,
	) -> tuple[torch.Tensor, torch.Tensor]:
		updated_cache_entries = []
		for index, layer in enumerate(self.layers):
			residual = hidden
			normalized = self._root_mean_square_norm(hidden, layer.input_layernorm.weight)

			attention = layer.self_attn
			queries = attention.q_proj(normalized).view(1, 1, self.query_head_count, self.head_dimension)
			keys = attention.k_proj(normalized).view(1, 1, self.key_value_head_count, self.head_dimension)
			values = attention.v_proj(normalized).view(1, 1, self.key_value_head_count, self.head_dimension)

			# Qwen3 normalizes the queries and the keys per head before the rotary embedding is applied.
			queries = self._root_mean_square_norm(queries, attention.q_norm.weight)
			keys = self._root_mean_square_norm(keys, attention.k_norm.weight)

			queries = self._apply_rotary(queries.transpose(1, 2), rotary_cosine, rotary_sine)
			keys = self._apply_rotary(keys.transpose(1, 2), rotary_cosine, rotary_sine)
			values = values.transpose(1, 2)

			# The cache is written with a one-hot mask rather than an index, because a data-dependent index
			# is exactly the kind of dynamic shape the conversion path refuses.
			cached_keys = key_value_cache[2 * index]
			cached_values = key_value_cache[2 * index + 1]
			new_keys = cached_keys * (1.0 - write_mask) + keys[0] * write_mask
			new_values = cached_values * (1.0 - write_mask) + values[0] * write_mask
			updated_cache_entries.append(new_keys)
			updated_cache_entries.append(new_values)

			if self.attention_layout == "grouped":
				# The query heads are folded down onto their own key/value head instead of the key/value
				# heads being widened up to the query heads. Both compute the same attention; this one
				# never widens a tensor, so it emits no BROADCAST_TO, which the WebGPU delegate of
				# @litertjs/core 2.5.3 refuses. Query head q belongs to key/value head q // repeat_count,
				# so [query heads, head dimension] and [key/value heads, repeat count, head dimension]
				# hold their values in the same order and reshaping between them moves nothing.
				grouped_queries = queries.reshape(
					self.key_value_head_count, self.repeat_count, self.head_dimension
				)
				scores = torch.matmul(grouped_queries, new_keys.transpose(1, 2)) / (
					self.head_dimension**0.5
				)
				scores = scores + attention_mask.reshape(1, 1, -1)
				attended = torch.matmul(torch.softmax(scores, dim=-1), new_values)
				attended = attended.reshape(1, 1, self.query_head_count * self.head_dimension)
			else:
				# The key/value heads are repeated up to the query head count: grouped-query attention.
				position_count = new_keys.shape[1]
				expanded_keys = (
					new_keys.unsqueeze(1)
					.expand(self.key_value_head_count, self.repeat_count, position_count, self.head_dimension)
					.reshape(1, self.query_head_count, position_count, self.head_dimension)
				)
				expanded_values = (
					new_values.unsqueeze(1)
					.expand(self.key_value_head_count, self.repeat_count, position_count, self.head_dimension)
					.reshape(1, self.query_head_count, position_count, self.head_dimension)
				)

				scores = torch.matmul(queries, expanded_keys.transpose(2, 3)) / (self.head_dimension**0.5)
				scores = scores + attention_mask
				attended = torch.matmul(torch.softmax(scores, dim=-1), expanded_values)
				attended = attended.transpose(1, 2).reshape(1, 1, self.query_head_count * self.head_dimension)

			hidden = residual + attention.o_proj(attended)

			residual = hidden
			normalized = self._root_mean_square_norm(hidden, layer.post_attention_layernorm.weight)
			gated = layer.mlp.act_fn(layer.mlp.gate_proj(normalized)) * layer.mlp.up_proj(normalized)
			hidden = residual + layer.mlp.down_proj(gated)

		return hidden, torch.stack(updated_cache_entries, dim=0)


###############################################################################
###############################################################################
#	Qwen3PrefillShard — the same layers, reading a whole prompt at once
###############################################################################
###############################################################################


class Qwen3PrefillShard(Qwen3DecoderShard):
	"""The same decoder layers as `Qwen3DecoderShard`, reading `sequence_length` tokens in one call.

	Prefill is simpler than decode, not harder, because it starts at position 0: there is no cache to read,
	and the cache it writes is its own keys and values followed by zeros. That removes the one-hot write mask,
	the incoming cache, and the blend between them, and leaves a plain padding.

	Everything else — the normalizations, the rotary embedding, the grouped attention layout that avoids
	BROADCAST_TO — is inherited rather than restated, so prefill and decode cannot drift apart.
	"""

	def __init__(self, model, first_layer: int, last_layer: int, sequence_length: int, cache_positions: int) -> None:
		super().__init__(model, first_layer, last_layer, "grouped")
		self.sequence_length = sequence_length
		self.cache_positions = cache_positions

	def forward(
		self,
		hidden: torch.Tensor,
		rotary_cosine: torch.Tensor,
		rotary_sine: torch.Tensor,
		attention_mask: torch.Tensor,
	) -> tuple[torch.Tensor, torch.Tensor]:
		length = self.sequence_length
		padding = self.cache_positions - length
		updated_cache_entries = []
		for layer in self.layers:
			residual = hidden
			normalized = self._root_mean_square_norm(hidden, layer.input_layernorm.weight)

			attention = layer.self_attn
			queries = attention.q_proj(normalized).view(1, length, self.query_head_count, self.head_dimension)
			keys = attention.k_proj(normalized).view(1, length, self.key_value_head_count, self.head_dimension)
			values = attention.v_proj(normalized).view(1, length, self.key_value_head_count, self.head_dimension)

			queries = self._root_mean_square_norm(queries, attention.q_norm.weight)
			keys = self._root_mean_square_norm(keys, attention.k_norm.weight)

			queries = self._apply_rotary(queries.transpose(1, 2), rotary_cosine, rotary_sine)
			keys = self._apply_rotary(keys.transpose(1, 2), rotary_cosine, rotary_sine)
			values = values.transpose(1, 2)

			new_keys = keys[0]
			new_values = values[0]

			# The same fold as decode: query head q belongs to key/value head q // repeat_count, so the query
			# heads and their positions collapse into one axis and no tensor is ever widened.
			grouped_queries = queries.reshape(
				self.key_value_head_count, self.repeat_count * length, self.head_dimension
			)
			scores = torch.matmul(grouped_queries, new_keys.transpose(1, 2)) / (self.head_dimension**0.5)
			scores = scores + attention_mask
			attended = torch.matmul(torch.softmax(scores, dim=-1), new_values)
			attended = attended.reshape(1, self.query_head_count, length, self.head_dimension)
			attended = attended.transpose(1, 2).reshape(
				1, length, self.query_head_count * self.head_dimension
			)
			hidden = residual + attention.o_proj(attended)

			residual = hidden
			normalized = self._root_mean_square_norm(hidden, layer.post_attention_layernorm.weight)
			gated = layer.mlp.act_fn(layer.mlp.gate_proj(normalized)) * layer.mlp.up_proj(normalized)
			hidden = residual + layer.mlp.down_proj(gated)

			# The unwritten end of the cache is concatenated on rather than padded on. `pad` converts to a
			# PADV2 that the WebGPU delegate accepts and then computes wrongly: the first of the eight
			# entries came back as zeros while WebAssembly returned all eight correctly. Measured in
			# milestone five of issue #179.
			empty = torch.zeros(
				self.key_value_head_count, padding, self.head_dimension, dtype=new_keys.dtype
			)
			updated_cache_entries.append(torch.cat((new_keys, empty), dim=1))
			updated_cache_entries.append(torch.cat((new_values, empty), dim=1))

		return hidden, torch.stack(updated_cache_entries, dim=0)


###############################################################################
###############################################################################
#	Qwen3HeadChunk — the final normalization and one slice of the vocabulary
###############################################################################
###############################################################################


class Qwen3HeadChunk(torch.nn.Module):
	"""The final normalization, and the language-model head over one slice of the vocabulary."""

	def __init__(self, model, first_token: int, last_token: int) -> None:
		super().__init__()
		self.normalization_epsilon = model.config.rms_norm_eps
		self.register_buffer("norm_weight", model.model.norm.weight.detach().clone())
		# The slice is copied out rather than referenced, so that each chunk carries only its own share of
		# the 622 megabyte matrix and nothing else.
		self.register_buffer(
			"head_weight", model.lm_head.weight.detach()[first_token : last_token + 1].clone()
		)

	def forward(self, hidden: torch.Tensor) -> torch.Tensor:
		variance = hidden.pow(2).mean(-1, keepdim=True)
		normalized = self.norm_weight * (hidden * torch.rsqrt(variance + self.normalization_epsilon))
		return torch.matmul(normalized, self.head_weight.t())


###############################################################################
###############################################################################
#	Export
###############################################################################
###############################################################################


def rotary_tables(position: int, head_dimension: int, rope_theta: float) -> tuple[torch.Tensor, torch.Tensor]:
	"""Builds the rotary cosine and sine for one position.

	@param position The token position.
	@param head_dimension The head dimension.
	@param rope_theta The rotary base.
	@returns The cosine and the sine, each shaped [1, 1, 1, head dimension].
	"""
	inverse_frequencies = 1.0 / (
		rope_theta ** (torch.arange(0, head_dimension, 2, dtype=torch.float32) / head_dimension)
	)
	angles = torch.tensor([float(position)], dtype=torch.float32).unsqueeze(1) * inverse_frequencies.unsqueeze(0)
	doubled = torch.cat((angles, angles), dim=-1)
	return doubled.cos().view(1, 1, 1, head_dimension), doubled.sin().view(1, 1, 1, head_dimension)


def main() -> None:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--model", default="Qwen/Qwen3-0.6B", help="The model to split.")
	parser.add_argument("--cache-positions", type=int, default=512, help="Cache positions, the maximum context.")
	parser.add_argument(
		"--layers-per-shard",
		type=int,
		default=4,
		help="Decoder layers per shard. Four is 251.7 megabytes, below the measured loading limit.",
	)
	parser.add_argument(
		"--head-chunks",
		type=int,
		default=3,
		help="How many vocabulary slices the language-model head is split into. Three is 207.4 megabytes each.",
	)
	parser.add_argument(
		"--skip-conversion",
		action="store_true",
		help="Recompute and rewrite the reference files without repeating the expensive litert_torch.convert.",
	)
	parser.add_argument(
		"--attention-layout",
		choices=("expand", "grouped"),
		default="grouped",
		help=(
			"How grouped-query attention is arranged. 'expand' widens the key/value heads up to the query "
			"heads and emits BROADCAST_TO, which the WebGPU delegate refuses. 'grouped' folds the query "
			"heads onto their own key/value head instead and emits none."
		),
	)
	parser.add_argument(
		"--name-suffix",
		default="",
		help="Appended to every generated name, so one layout does not overwrite another.",
	)
	parser.add_argument(
		"--only",
		action="append",
		help=(
			"Convert only the named graphs, by their unsuffixed name such as decoder_00-03. Repeatable. "
			"Every graph still gets a reference file; this only limits the expensive conversion."
		),
	)
	parser.add_argument("output", type=Path, help="Directory for the generated files")
	arguments = parser.parse_args()

	arguments.output.mkdir(parents=True, exist_ok=True)

	model = AutoModelForCausalLM.from_pretrained(arguments.model, dtype=torch.float32).eval()
	config = model.config
	rope_theta = float(config.rope_parameters["rope_theta"])
	head_dimension = config.head_dim
	key_value_head_count = config.num_key_value_heads
	hidden_size = config.hidden_size
	layer_count = config.num_hidden_layers
	vocabulary_size = config.vocab_size
	cache_positions = arguments.cache_positions

	# One fixed position is exported. Decoding at any other position uses the same graph with different
	# rotary, mask, and write-mask tensors, which is the whole reason those are inputs.
	sample_position = 3
	cosine, sine = rotary_tables(sample_position, head_dimension, rope_theta)
	write_mask = torch.zeros(1, cache_positions, 1, dtype=torch.float32)
	write_mask[0, sample_position, 0] = 1.0
	attention_mask = torch.full((1, 1, 1, cache_positions), float("-inf"), dtype=torch.float32)
	attention_mask[..., : sample_position + 1] = 0.0
	sample_token = 9707

	# The token embedding is written as a raw binary, not exported into a graph. Decoding one token reads
	# one row of it, and the browser fetches exactly that row with an HTTP range request.
	embedding_path = arguments.output / "qwen3_0_6b_embedding.bin"
	should_write_embedding = embedding_path.exists() is False or (
		arguments.skip_conversion is False and arguments.only is None
	)
	if should_write_embedding:
		embedding_weights = model.model.embed_tokens.weight.detach().to(torch.float32).contiguous()
		embedding_path.write_bytes(embedding_weights.numpy().tobytes())
		print(f"Wrote {embedding_path} ({embedding_path.stat().st_size} bytes)")

	hidden = model.model.embed_tokens(torch.tensor([[sample_token]], dtype=torch.long)).detach()
	embedding_row = hidden.flatten().tolist()

	decoder_shards = []
	for first_layer in range(0, layer_count, arguments.layers_per_shard):
		last_layer = min(first_layer + arguments.layers_per_shard - 1, layer_count - 1)
		name = f"decoder_{first_layer:02d}-{last_layer:02d}"
		output_name = f"{name}{arguments.name_suffix}"
		shard_layer_count = last_layer - first_layer + 1
		cache_shape = [shard_layer_count * 2, key_value_head_count, cache_positions, head_dimension]

		shard = Qwen3DecoderShard(model, first_layer, last_layer, arguments.attention_layout).eval()
		sample_cache = torch.zeros(*cache_shape, dtype=torch.float32)
		shard_input = hidden

		with torch.no_grad():
			produced_hidden, produced_cache = shard(
				shard_input, sample_cache, cosine, sine, write_mask, attention_mask
			)

		model_path = arguments.output / f"qwen3_0_6b_{output_name}.tflite"
		if arguments.skip_conversion is False and (arguments.only is None or name in arguments.only):
			converted = litert_torch.convert(
				shard, (shard_input, sample_cache, cosine, sine, write_mask, attention_mask)
			)
			converted.export(str(model_path))

		cache_element_count = 1
		for dimension in cache_shape:
			cache_element_count *= dimension

		description = {
			"kind": "decoder",
			"name": output_name,
			"referenceName": name,
			"attentionLayout": arguments.attention_layout,
			"firstLayer": first_layer,
			"lastLayer": last_layer,
			"cacheShape": cache_shape,
			"cacheRank": len(cache_shape),
			"cacheElementCount": cache_element_count,
			"cacheBytes": cache_element_count * 4,
			"inputShape": list(shard_input.shape),
			"outputShape": list(produced_hidden.shape),
			"sampleInput": shard_input.flatten().tolist(),
			"expectedOutput": produced_hidden.flatten().tolist(),
			"expectedCacheFirstValues": produced_cache.flatten()[:8].tolist(),
			"expectedCacheLastValues": produced_cache.flatten()[-8:].tolist(),
			"fileBytes": model_path.stat().st_size if model_path.exists() else None,
		}
		(arguments.output / f"qwen3_0_6b_{output_name}.reference.json").write_text(json.dumps(description))
		decoder_shards.append(description)
		megabytes = description["fileBytes"] / 1e6 if description["fileBytes"] else 0
		print(f"{output_name}: layers {first_layer}-{last_layer}, cache {cache_shape}, {megabytes:.1f} MB")

		hidden = produced_hidden

	final_hidden = hidden

	head_chunks = []
	chunk_size = (vocabulary_size + arguments.head_chunks - 1) // arguments.head_chunks
	for chunk_index in range(arguments.head_chunks):
		first_token = chunk_index * chunk_size
		last_token = min(first_token + chunk_size - 1, vocabulary_size - 1)
		name = f"head_{chunk_index}"
		output_name = f"{name}{arguments.name_suffix}"

		chunk = Qwen3HeadChunk(model, first_token, last_token).eval()
		with torch.no_grad():
			produced_logits = chunk(final_hidden)

		model_path = arguments.output / f"qwen3_0_6b_{output_name}.tflite"
		if arguments.skip_conversion is False and (arguments.only is None or name in arguments.only):
			converted = litert_torch.convert(chunk, (final_hidden,))
			converted.export(str(model_path))

		description = {
			"kind": "head",
			"name": output_name,
			"referenceName": name,
			"chunkIndex": chunk_index,
			"firstToken": first_token,
			"lastToken": last_token,
			"inputShape": list(final_hidden.shape),
			"outputShape": list(produced_logits.shape),
			"sampleInput": final_hidden.flatten().tolist(),
			"expectedOutput": produced_logits.flatten().tolist(),
			"fileBytes": model_path.stat().st_size if model_path.exists() else None,
		}
		(arguments.output / f"qwen3_0_6b_{output_name}.reference.json").write_text(json.dumps(description))
		head_chunks.append(description)
		megabytes = description["fileBytes"] / 1e6 if description["fileBytes"] else 0
		print(f"{output_name}: vocabulary {first_token}-{last_token}, {megabytes:.1f} MB")

	# The reference the whole chain is checked against is PyTorch running this same decomposition under the
	# same conditions — position 3 with an all-zero cache — and not the real model on a fresh sequence. Those
	# two are different computations: at position 3 the attention also attends to three all-zero cache
	# positions, which a real model at position 0 never does. Comparing against the real model here would be
	# comparing two different questions and calling the difference an error.
	#
	# That the decomposition itself reproduces the real model is established separately, in eager PyTorch over
	# a real multi-token sequence: maximum absolute difference 1.25e-4, same predicted token. See this
	# folder's CONTEXT.md.
	chained_logits = torch.cat(
		[torch.tensor(description["expectedOutput"]) for description in head_chunks], dim=-1
	)

	index_path = arguments.output / f"index{arguments.name_suffix}.json"
	index_path.write_text(
		json.dumps(
			{
				"model": arguments.model,
				"attentionLayout": arguments.attention_layout,
				"sampleToken": sample_token,
				"samplePosition": sample_position,
				"cachePositions": cache_positions,
				"hiddenSize": hidden_size,
				"headDimension": head_dimension,
				"ropeTheta": rope_theta,
				"vocabularySize": vocabulary_size,
				"embeddingFile": "qwen3_0_6b_embedding.bin",
				"embeddingRow": embedding_row,
				"decoderShards": [description["name"] for description in decoder_shards],
				"headChunks": [description["name"] for description in head_chunks],
				"referenceArgmaxToken": int(chained_logits.flatten().argmax()),
				"referenceLogitsFirstValues": chained_logits.flatten()[:8].tolist(),
			}
		)
	)

	largest = max(
		description["fileBytes"] or 0 for description in [*decoder_shards, *head_chunks]
	)
	print(f"\nWrote {index_path}")
	print(f"{len(decoder_shards)} decoder shards, {len(head_chunks)} head chunks")
	print(f"largest generated .tflite: {largest / 1e6:.1f} MB")


if __name__ == "__main__":
	main()
