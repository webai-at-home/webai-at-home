///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VerifyQwen3Shards — runs the three exported Qwen3-0.6B shards end to end
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs three token-generation steps through the three exported Qwen3-0.6B shards, in order, passing each shard's
 * key-value cache and layer-boundary activations to the next. If a path to a monolithic reference model is given as
 * the first command-line argument, the first step is also run through that model and the logits are compared.
 */

// onnxruntime-node versions that expose a native Float16Array can select a browser-only typed-array path. Qwen3's
// empty float16 cache is represented by Uint16Array, matching the browser implementation.
(globalThis as unknown as { Float16Array: typeof Float16Array | undefined }).Float16Array = undefined;

import * as OnnxRuntimeNode from 'onnxruntime-node';

/** One shard's feeds, keyed by input name. */
type ShardFeeds = Record<string, OnnxRuntimeNode.Tensor>;

/** The layer-boundary activations one shard hands to the next, keyed by output name. */
type Boundary = Record<string, OnnxRuntimeNode.Tensor>;

/** One shard's key-value cache, keyed by its `past_key_values.*` input name. */
type Cache = Record<string, OnnxRuntimeNode.Tensor>;

const shardPaths = [1, 2, 3].map(
	(index) => `packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards/shard-${index}.onnx`,
);

/** Runs the three-shard verification and prints the result. */
class VerifyQwen3Shards {
	/**
	 * Loads the three shards, runs three generation steps through them in sequence, and prints the outcome.
	 *
	 * @returns Resolves once the verification has printed its result.
	 */
	static async main(): Promise<void> {
		const sessions = await Promise.all(shardPaths.map((path) => OnnxRuntimeNode.InferenceSession.create(path)));
		const referenceModelPath = process.argv[2];
		const referenceSession =
			referenceModelPath !== undefined ? await OnnxRuntimeNode.InferenceSession.create(referenceModelPath) : undefined;

		let token = 151644;
		const caches: (Cache | undefined)[] = [undefined, undefined, undefined];
		for (let step = 0; step < 3; step += 1) {
			let boundary: Boundary | undefined;
			let logits: OnnxRuntimeNode.Tensor | undefined;
			for (const [index, session] of sessions.entries()) {
				const outputs = await session.run(VerifyQwen3Shards._makeFeeds(session, token, step, boundary, caches[index]));
				caches[index] = VerifyQwen3Shards._extractCache(outputs);
				if (index < 2) {
					const prefix = index === 0 ? '9' : '19';
					boundary = {
						[`/model/layers.${prefix}/input_layernorm/output_0`]: outputs[`/model/layers.${prefix}/input_layernorm/output_0`],
						[`/model/layers.${prefix}/input_layernorm/output_3`]: outputs[`/model/layers.${prefix}/input_layernorm/output_3`],
					};
				} else {
					logits = outputs.logits;
				}
			}
			if (logits === undefined) {
				throw new Error('the third shard did not produce logits');
			}

			const values = logits.data;
			const vocabularySize = logits.dims.at(-1);
			if (vocabularySize === undefined) {
				throw new Error('the logits tensor has no dimensions');
			}
			if (referenceSession !== undefined && step === 0) {
				const reference = await referenceSession.run(
					VerifyQwen3Shards._makeFeeds(referenceSession, token, step, undefined, undefined),
				);
				const referenceLogits = reference.logits.data;
				let maxDifference = 0;
				for (let index = 0; index < referenceLogits.length; index += 1) {
					maxDifference = Math.max(maxDifference, Math.abs(Number(values[index]) - Number(referenceLogits[index])));
				}
				console.log(`reference comparison: max logit difference ${maxDifference}`);
				if (maxDifference > 0.01) {
					throw new Error(`Shard logits differ from the monolithic model by ${maxDifference}.`);
				}
			}

			let best = 0;
			for (let index = 1; index < vocabularySize; index += 1) {
				if (values[index] > values[best]) {
					best = index;
				}
			}
			console.log(
				`step ${step + 1}: shard 1 → shard 2 → shard 3; boundary [1,1,1024]; logits [1,1,${vocabularySize}]; next token ${best}`,
			);
			token = best;
		}

		console.log('Three-shard inference verification passed.');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds an empty key-value cache tensor for one attention layer.
	 *
	 * @returns A cache tensor holding zero tokens of history.
	 */
	private static _emptyCache(): OnnxRuntimeNode.Tensor {
		return new OnnxRuntimeNode.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
	}

	/**
	 * Builds the feeds for one shard's run: the current token, the attention mask, the position, the boundary
	 * activations handed down from the previous shard, and the shard's own key-value cache.
	 *
	 * @param session The shard to build feeds for.
	 * @param token The current input token.
	 * @param position The token's position in the sequence.
	 * @param boundary The layer-boundary activations from the previous shard, if this is not the first shard.
	 * @param cache The shard's key-value cache from the previous step, if this is not the first step.
	 * @returns The feeds to pass to `session.run`.
	 */
	private static _makeFeeds(
		session: OnnxRuntimeNode.InferenceSession,
		token: number,
		position: number,
		boundary: Boundary | undefined,
		cache: Cache | undefined,
	): ShardFeeds {
		const feeds: ShardFeeds = {
			input_ids: new OnnxRuntimeNode.Tensor('int64', BigInt64Array.from([BigInt(token)]), [1, 1]),
			attention_mask: new OnnxRuntimeNode.Tensor(
				'int64',
				BigInt64Array.from({ length: position + 1 }, () => 1n),
				[1, position + 1],
			),
			position_ids: new OnnxRuntimeNode.Tensor('int64', BigInt64Array.from([BigInt(position)]), [1, 1]),
		};
		if (boundary !== undefined) {
			Object.assign(feeds, boundary);
		}
		for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
			feeds[name] = cache?.[name] ?? VerifyQwen3Shards._emptyCache();
		}
		return feeds;
	}

	/**
	 * Pulls the `present.*` outputs of a shard's run back out as the `past_key_values.*` cache for its next run.
	 *
	 * @param outputs The shard's run outputs.
	 * @returns The cache to feed into the same shard's next step.
	 */
	private static _extractCache(outputs: OnnxRuntimeNode.InferenceSession.ReturnType): Cache {
		const cache: Cache = {};
		for (const [name, value] of Object.entries(outputs)) {
			if (name.startsWith('present.') && value !== null) {
				cache[name.replace('present', 'past_key_values')] = value;
			}
		}
		return cache;
	}
}

await VerifyQwen3Shards.main();
