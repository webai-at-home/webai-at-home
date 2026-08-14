import * as OnnxRuntimeWeb from 'onnxruntime-web';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OnnxSide — decodes the three Qwen3-0.6B ONNX shards with ONNX Runtime Web
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The named tensors passed to and returned from one shard.
 */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;

/**
 * What one block of decoding cost.
 */
export type OnnxBlockResult = {
	/** How many single-token positions were decoded. */
	positions: number;
	/** How long those positions took from end to end, prompt reading excluded. */
	wallClockMilliseconds: number;
	/** How long each shard spent inside `run()` across those positions. */
	shardMilliseconds: number[];
	/** The tokens generated, prompt reading included. */
	tokens: number[];
};

/**
 * Where the three ONNX shards are served from.
 */
const SHARD_PREFIX = '/onnxruntime-comparison/shards';

/**
 * The three shard files, in the order they run.
 */
const SHARD_FILE_NAMES = ['shard-1.onnx', 'shard-2.onnx', 'shard-3.onnx'] as const;

/**
 * Which decoder layers each shard owns. Shard 2 is the only one that is nothing but decoder layers: shard 1
 * also carries the token embedding and shard 3 the final normalization and the language-model head, so shard
 * 2 is the one whose cost divides cleanly by a layer count.
 */
export const ONNX_SHARD_LAYER_COUNTS = [9, 10, 9];

/**
 * The two tensors each shard hands to the next. ONNX Runtime Web cuts the residual stream where the next
 * layer normalizes it, so the boundary carries the normalized hidden state and the residual one.
 */
const SHARD_BOUNDARIES: ReadonlyArray<{ normalized: string; residual: string } | undefined> = [
	undefined,
	{
		normalized: '/model/layers.9/input_layernorm/output_0',
		residual: '/model/layers.9/input_layernorm/output_3',
	},
	{
		normalized: '/model/layers.19/input_layernorm/output_0',
		residual: '/model/layers.19/input_layernorm/output_3',
	},
];

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
OnnxRuntimeWeb.env.logLevel = 'fatal';

/**
 * Holds the three ONNX shard sessions and decodes blocks of positions through them.
 */
export class OnnxSide {
	/** The three sessions, in the order they run. */
	private sessions: OnnxRuntimeWeb.InferenceSession[] = [];
	/** How large each shard file is, in bytes. */
	private shardBytes: number[] = [];

	/**
	 * Downloads the three shards and creates their sessions.
	 *
	 * @returns How long fetching and creating took, and how large the shards are.
	 */
	async load(): Promise<{ fetchMilliseconds: number; createMilliseconds: number; bytes: number[] }> {
		let fetchMilliseconds = 0;
		let createMilliseconds = 0;
		this.sessions = [];
		this.shardBytes = [];

		for (const fileName of SHARD_FILE_NAMES) {
			const fetchStart = performance.now();
			const response = await fetch(`${SHARD_PREFIX}/${fileName}`);
			if (response.ok === false) {
				throw new Error(`${fileName} could not be read (${response.status}).`);
			}
			const bytes = await response.arrayBuffer();
			fetchMilliseconds += performance.now() - fetchStart;

			const createStart = performance.now();
			this.sessions.push(
				await OnnxRuntimeWeb.InferenceSession.create(bytes, {
					executionProviders: ['webgpu'],
					graphOptimizationLevel: 'all',
				}),
			);
			createMilliseconds += performance.now() - createStart;
			this.shardBytes.push(bytes.byteLength);
		}

		return {
			fetchMilliseconds: fetchMilliseconds,
			createMilliseconds: createMilliseconds,
			bytes: this.shardBytes,
		};
	}

	/**
	 * Reads the prompt in one call, then generates tokens one at a time, timing only the single-token
	 * positions.
	 *
	 * @param promptTokens The prompt.
	 * @param steps How many tokens to generate.
	 * @returns What the block cost and which tokens it produced.
	 */
	async decodeBlock(promptTokens: number[], steps: number): Promise<OnnxBlockResult> {
		const caches: Array<TensorMap | undefined> = [undefined, undefined, undefined];
		const tokens: number[] = [];
		const shardTotals = [0, 0, 0];
		let position = 0;

		const first = await this._runOnePosition(promptTokens, position, caches);
		tokens.push(first.token);
		position += promptTokens.length;

		const blockStart = performance.now();
		for (let step = 1; step < steps; step += 1) {
			const result = await this._runOnePosition([tokens[tokens.length - 1]], position, caches);
			tokens.push(result.token);
			for (const [index, milliseconds] of result.shardMilliseconds.entries()) {
				shardTotals[index] += milliseconds;
			}
			position += 1;
		}
		const wallClockMilliseconds = performance.now() - blockStart;

		return {
			positions: steps - 1,
			wallClockMilliseconds: wallClockMilliseconds,
			shardMilliseconds: shardTotals,
			tokens: tokens,
		};
	}

	/**
	 * Frees the three sessions. Without this, a page load leaves its graphics-processor buffers behind and
	 * the next load measures a machine that is already paging.
	 *
	 * @returns Nothing.
	 */
	async release(): Promise<void> {
		for (const session of this.sessions) {
			await session.release();
		}
		this.sessions = [];
	}

	/**
	 * Pushes one call through all three shards, keeping each shard's key/value cache and handing the
	 * boundary tensors from one shard to the next.
	 *
	 * @param inputTokens The tokens fed in at this call.
	 * @param position The position of the first of those tokens.
	 * @param caches Each shard's key/value cache, replaced in place.
	 * @returns The token chosen and how long each shard took.
	 */
	private async _runOnePosition(
		inputTokens: number[],
		position: number,
		caches: Array<TensorMap | undefined>,
	): Promise<{ token: number; shardMilliseconds: number[] }> {
		const shardMilliseconds: number[] = [];
		let boundary: TensorMap | undefined;
		let token = 0;

		for (const [index, session] of this.sessions.entries()) {
			const inputs = OnnxSide._buildInputs(session, inputTokens, position, caches[index], boundary);
			const start = performance.now();
			const outputs = (await session.run(inputs)) as TensorMap;
			shardMilliseconds.push(performance.now() - start);

			caches[index] = OnnxSide._takeCache(outputs);

			if (index < this.sessions.length - 1) {
				const names = SHARD_BOUNDARIES[index + 1];
				if (names === undefined) {
					throw new Error(`No boundary is defined after shard ${index + 1}.`);
				}
				boundary = {
					[names.normalized]: outputs[names.normalized],
					[names.residual]: outputs[names.residual],
				};
			} else {
				token = OnnxSide._chooseToken(OnnxSide._findLogits(outputs));
			}
		}

		return {
			token: token,
			shardMilliseconds: shardMilliseconds,
		};
	}

	/**
	 * Builds every input one shard needs for one call.
	 *
	 * @param session The shard's session.
	 * @param inputTokens The tokens fed in at this call.
	 * @param position The position of the first of those tokens.
	 * @param cache The key/value cache the previous call of this shard returned, if there was one.
	 * @param boundary The two tensors the previous shard handed over, if this is not the first shard.
	 * @returns The named input tensors.
	 */
	private static _buildInputs(
		session: OnnxRuntimeWeb.InferenceSession,
		inputTokens: number[],
		position: number,
		cache: TensorMap | undefined,
		boundary: TensorMap | undefined,
	): TensorMap {
		const int64 = (values: number[], dimensions: readonly number[]): OnnxRuntimeWeb.Tensor =>
			new OnnxRuntimeWeb.Tensor('int64', BigInt64Array.from(values, BigInt), dimensions);
		const inputs: TensorMap = {
			input_ids: int64(inputTokens, [1, inputTokens.length]),
			attention_mask: int64(
				Array.from({ length: position + inputTokens.length }, () => 1),
				[1, position + inputTokens.length],
			),
			position_ids: int64(
				Array.from({ length: inputTokens.length }, (_unused, index) => position + index),
				[1, inputTokens.length],
			),
		};
		if (boundary !== undefined) {
			for (const name of Object.keys(boundary)) {
				inputs[name] = boundary[name];
			}
		}
		for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
			inputs[name] = cache?.[name] ?? new OnnxRuntimeWeb.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
		}
		return inputs;
	}

	/**
	 * Takes the key/value cache out of one call's outputs, renaming it to the names the next call reads it by.
	 *
	 * @param outputs Everything the call returned.
	 * @returns The key/value cache, ready to be fed back in.
	 */
	private static _takeCache(outputs: TensorMap): TensorMap {
		const cache: TensorMap = {};
		for (const [name, tensor] of Object.entries(outputs)) {
			if (name.startsWith('present.') === true) {
				cache[name.replace('present', 'past_key_values')] = tensor;
			}
		}
		return cache;
	}

	/**
	 * Finds the logits among the last shard's outputs.
	 *
	 * @param outputs Everything the last shard returned.
	 * @returns The logits tensor.
	 */
	private static _findLogits(outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const name = Object.keys(outputs).find(
			(candidate) => candidate === 'logits' || candidate.endsWith('.logits'),
		);
		if (name === undefined) {
			throw new Error(`The last shard returned no logits. It returned: ${Object.keys(outputs).join(', ')}`);
		}
		return outputs[name];
	}

	/**
	 * Chooses the token with the largest logit at the last position.
	 *
	 * @param logits The logits tensor the last shard returned.
	 * @returns The chosen token.
	 */
	private static _chooseToken(logits: OnnxRuntimeWeb.Tensor): number {
		const values = logits.data as ArrayLike<number>;
		const vocabularySize = logits.dims.at(-1) ?? 0;
		const offset = values.length - vocabularySize;
		let bestToken = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let token = 0; token < vocabularySize; token += 1) {
			if (values[offset + token] > bestValue) {
				bestValue = values[offset + token];
				bestToken = token;
			}
		}
		return bestToken;
	}
}
