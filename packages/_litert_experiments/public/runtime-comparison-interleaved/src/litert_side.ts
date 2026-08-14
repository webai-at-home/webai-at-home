import { Tensor, loadAndCompile, loadLiteRt, type CompiledModel } from '@litertjs/core';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LiteRtSide — decodes one Qwen3-0.6B decoder shard with LiteRT.js, on demand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one shard produced at one position, as PyTorch recorded it.
 */
type ShardOutput = {
	/** The graph's name. */
	name: string;
	/** The first eight values of its hidden state. */
	firstValues: number[];
	/** The sum of the absolute values of its hidden state. */
	absoluteSum: number;
};

/**
 * One decoded position of the PyTorch reference.
 */
type DecodeStep = {
	/** The position, counting from zero. */
	position: number;
	/** What each decoder shard produced there. */
	shardOutputs: ShardOutput[];
};

/**
 * The whole PyTorch decode, as `tools/qwen3_decode_reference/` wrote it.
 */
type DecodeReference = {
	/** The model that was split. */
	model: string;
	/** Every token fed in, one per position. */
	inputTokens: number[];
	/** How many positions every key/value cache holds. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** The head dimension. */
	headDimension: number;
	/** The rotary base. */
	ropeTheta: number;
	/** The raw token embedding table's file name. */
	embeddingFile: string;
	/** Every decoded position, in order. */
	steps: DecodeStep[];
};

/**
 * What one block of decoding cost, and how far it strayed from PyTorch.
 */
export type LiteRtBlockResult = {
	/** How many positions were decoded. */
	positions: number;
	/** How long the block took from end to end. */
	wallClockMilliseconds: number;
	/** How much of that was inside `run()`. */
	runMilliseconds: number;
	/** How much of that was spent reading the hidden state back. */
	readbackMilliseconds: number;
	/** The largest relative difference from PyTorch seen anywhere in the block. */
	largestDifference: number;
};

/**
 * Where the graphs and the references live.
 */
const MODELS_PREFIX = '/qwen3-litert-shards/models';

/**
 * Whether `loadLiteRt()` has already run on this page. It refuses a second call.
 */
let isLiteRtLoaded = false;

/**
 * Holds one compiled decoder shard and decodes blocks of positions through it, keeping the shard's
 * key/value cache on the graphics processor between calls the way milestone four does.
 */
export class LiteRtSide {
	/** Which shard this is, which is also part of its file name. */
	readonly shardName: string;
	/** How many decoder layers that shard owns. */
	readonly layerCount: number;
	/** The compiled graph, once it has loaded. */
	private model: CompiledModel | undefined;
	/** The whole PyTorch decode, once it has been fetched. */
	private reference: DecodeReference | undefined;
	/** One embedding row per position, fetched once. */
	private embeddingRows: Float32Array[] = [];
	/** The shape of this shard's key/value cache. */
	private cacheShape: number[] = [];
	/** Which shard of the reference this one is compared against. */
	private referenceName = '';
	/** The size of the graph file, in bytes. */
	private fileBytes = 0;

	/**
	 * @param shardName Which decoder shard to run, such as `decoder_00-03`.
	 * @param layerCount How many decoder layers it owns.
	 */
	constructor(shardName: string, layerCount: number) {
		this.shardName = shardName;
		this.layerCount = layerCount;
	}

	/**
	 * Loads LiteRT.js, the graph, the reference, and every embedding row the decode will need.
	 *
	 * @returns How long loading and compiling the graph took, and how large it is.
	 */
	async load(): Promise<{ compileMilliseconds: number; fetchMilliseconds: number; bytes: number }> {
		// The build LiteRT.js picks on its own cannot read a WebGPU tensor back, as milestone one found.
		if (isLiteRtLoaded === false) {
			await loadLiteRt('/wasm/litert_wasm_jspi_internal.js');
			isLiteRtLoaded = true;
		}

		const graphPath = `${MODELS_PREFIX}/qwen3_0_6b_${this.shardName}.tflite`;
		this.reference = (await (await fetch(`${MODELS_PREFIX}/decode_reference.json`)).json()) as DecodeReference;
		const shardReference = (await (
			await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${this.shardName}.reference.json`)
		).json()) as { cacheShape: number[]; referenceName?: string };
		this.cacheShape = shardReference.cacheShape;
		this.referenceName = shardReference.referenceName ?? this.shardName;

		const fetchStart = performance.now();
		this.embeddingRows = [];
		for (const token of this.reference.inputTokens) {
			this.embeddingRows.push(await LiteRtSide._fetchEmbeddingRow(
				this.reference.embeddingFile,
				token,
				this.reference.hiddenSize,
			));
		}
		const headResponse = await fetch(graphPath, {
			method: 'HEAD',
		});
		this.fileBytes = Number(headResponse.headers.get('content-length') ?? 0);
		const fetchMilliseconds = performance.now() - fetchStart;

		const compileStart = performance.now();
		this.model = await loadAndCompile(graphPath, {
			accelerator: 'webgpu',
		});
		const compileMilliseconds = performance.now() - compileStart;

		return {
			compileMilliseconds: compileMilliseconds,
			fetchMilliseconds: fetchMilliseconds,
			bytes: this.fileBytes,
		};
	}

	/**
	 * Says whether the compiled graph runs wholly on the graphics processor.
	 *
	 * @returns True when every operation was accepted.
	 */
	isFullyAccelerated(): boolean {
		return this.model?.isFullyAccelerated ?? false;
	}

	/**
	 * Decodes every position of the reference through the shard, keeping the key/value cache resident, and
	 * compares each position against PyTorch.
	 *
	 * @returns What the block cost and how far it strayed.
	 */
	async decodeBlock(): Promise<LiteRtBlockResult> {
		const model = this.model;
		const reference = this.reference;
		if (model === undefined || reference === undefined) {
			throw new Error('The LiteRT.js side has not been loaded.');
		}

		let cacheElementCount = 1;
		for (const dimension of this.cacheShape) {
			cacheElementCount *= dimension;
		}
		let cacheTensor = new Tensor(new Float32Array(cacheElementCount), this.cacheShape);

		let runMilliseconds = 0;
		let readbackMilliseconds = 0;
		let largestDifference = 0;
		const blockStart = performance.now();

		for (const step of reference.steps) {
			const [cosine, sine] = LiteRtSide._rotaryTables(
				step.position,
				reference.headDimension,
				reference.ropeTheta,
			);
			const [writeMask, attentionMask] = LiteRtSide._decodeMasks(step.position, reference.cachePositions);

			const runStart = performance.now();
			const outputs = (await model.run([
				new Tensor(this.embeddingRows[step.position], [1, 1, reference.hiddenSize]),
				cacheTensor,
				new Tensor(cosine, [1, 1, 1, reference.headDimension]),
				new Tensor(sine, [1, 1, 1, reference.headDimension]),
				new Tensor(writeMask, [1, reference.cachePositions, 1]),
				new Tensor(attentionMask, [1, 1, 1, reference.cachePositions]),
			])) as Tensor[];
			const runEnd = performance.now();
			runMilliseconds += runEnd - runStart;

			// The hidden state is read back because in the real architecture it crosses the network to the
			// next worker on every step anyway. The cache is what stays put.
			const producedHidden = await outputs[0].data();
			readbackMilliseconds += performance.now() - runEnd;

			const expected = step.shardOutputs.find((candidate) => candidate.name === this.referenceName);
			if (expected !== undefined) {
				let absoluteSum = 0;
				for (const value of producedHidden as Float32Array) {
					absoluteSum += Math.abs(value);
				}
				largestDifference = Math.max(
					largestDifference,
					LiteRtSide._relativeDifference(absoluteSum, expected.absoluteSum),
				);
				for (let index = 0; index < expected.firstValues.length; index += 1) {
					largestDifference = Math.max(
						largestDifference,
						LiteRtSide._relativeDifference(
							(producedHidden as Float32Array)[index],
							expected.firstValues[index],
						),
					);
				}
			}

			// The cache the graph just wrote becomes the cache the next call reads, without ever being read
			// into JavaScript. The tensor it replaces is freed.
			cacheTensor.delete();
			cacheTensor = outputs[1];
			outputs[0].delete();
		}

		const wallClockMilliseconds = performance.now() - blockStart;
		cacheTensor.delete();

		return {
			positions: reference.steps.length,
			wallClockMilliseconds: wallClockMilliseconds,
			runMilliseconds: runMilliseconds,
			readbackMilliseconds: readbackMilliseconds,
			largestDifference: largestDifference,
		};
	}

	/**
	 * Frees the compiled graph.
	 *
	 * @returns Nothing.
	 */
	release(): void {
		this.model?.delete();
		this.model = undefined;
	}

	/**
	 * Builds the rotary cosine and sine table for one position, matching the export script's `rotary_tables`.
	 *
	 * @param position The token position.
	 * @param headDimension The head dimension.
	 * @param ropeTheta The rotary base.
	 * @returns The cosine and the sine, each with `headDimension` elements.
	 */
	private static _rotaryTables(
		position: number,
		headDimension: number,
		ropeTheta: number,
	): [Float32Array, Float32Array] {
		const half = headDimension / 2;
		const cosine = new Float32Array(headDimension);
		const sine = new Float32Array(headDimension);
		for (let index = 0; index < half; index += 1) {
			const angle = position / ropeTheta ** ((2 * index) / headDimension);
			cosine[index] = Math.cos(angle);
			cosine[index + half] = Math.cos(angle);
			sine[index] = Math.sin(angle);
			sine[index + half] = Math.sin(angle);
		}
		return [cosine, sine];
	}

	/**
	 * Builds the cache write mask and the attention mask for one position.
	 *
	 * @param position The token position being decoded.
	 * @param cachePositions How many positions the cache holds.
	 * @returns The one-hot write mask, and the attention mask that admits positions up to this one.
	 */
	private static _decodeMasks(position: number, cachePositions: number): [Float32Array, Float32Array] {
		const writeMask = new Float32Array(cachePositions);
		writeMask[position] = 1;
		const attentionMask = new Float32Array(cachePositions).fill(Number.NEGATIVE_INFINITY);
		for (let admitted = 0; admitted <= position; admitted += 1) {
			attentionMask[admitted] = 0;
		}
		return [writeMask, attentionMask];
	}

	/**
	 * Fetches one row of the token embedding table with an HTTP range request.
	 *
	 * @param embeddingFile The raw embedding file's name.
	 * @param token The token to look up.
	 * @param hiddenSize The hidden size, which is the width of one row.
	 * @returns That token's embedding row.
	 */
	private static async _fetchEmbeddingRow(
		embeddingFile: string,
		token: number,
		hiddenSize: number,
	): Promise<Float32Array> {
		const rowBytes = hiddenSize * Float32Array.BYTES_PER_ELEMENT;
		const firstByte = token * rowBytes;
		const response = await fetch(`${MODELS_PREFIX}/${embeddingFile}`, {
			headers: {
				Range: `bytes=${firstByte}-${firstByte + rowBytes - 1}`,
			},
		});
		if (response.status !== 206) {
			throw new Error(`Expected 206 Partial Content for the embedding row, got ${response.status}.`);
		}
		return new Float32Array(await response.arrayBuffer());
	}

	/**
	 * Measures how far one value sits from another, as a fraction of the second one's magnitude.
	 *
	 * @param actual The value produced.
	 * @param expected The value PyTorch produced.
	 * @returns The relative difference.
	 */
	private static _relativeDifference(actual: number, expected: number): number {
		return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-6);
	}
}
