import {
	Tensor,
	isWebGPUSupported,
	loadAndCompile,
	loadLiteRt,
	TensorBufferType,
	type Accelerator,
	type CompiledModel,
} from '@litertjs/core';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Qwen3LiteRtShards — the milestone two gate of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What the export wrote, and how to reach it.
 */
type ShardIndex = {
	/** The model that was split. */
	model: string;
	/** The token the reference was computed for. */
	sampleToken: number;
	/** The position the reference was computed at. */
	samplePosition: number;
	/** How many cache positions every shard was exported with. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** The head dimension. */
	headDimension: number;
	/** The rotary base. */
	ropeTheta: number;
	/** How many tokens the vocabulary holds. */
	vocabularySize: number;
	/** The raw token embedding table, read one row at a time with a range request. */
	embeddingFile: string;
	/** The embedding row for the sample token, as PyTorch read it. */
	embeddingRow: number[];
	/** The decoder shards, in the order they run. */
	decoderShards: string[];
	/** The language-model head chunks, in vocabulary order. */
	headChunks: string[];
	/** The token the real unsplit model predicts for the sample token. */
	referenceArgmaxToken: number;
	/** The first eight logits the real unsplit model produces. */
	referenceLogitsFirstValues: number[];
};

/**
 * One exported graph, and the reference values PyTorch produced for it.
 */
type ShardReference = {
	/** `decoder` or `head`. */
	kind: 'decoder' | 'head';
	/** The graph's name, which is also its file name. */
	name: string;
	/** The first decoder layer this shard owns, for a decoder shard. */
	firstLayer?: number;
	/** The last decoder layer this shard owns, for a decoder shard. */
	lastLayer?: number;
	/** The first vocabulary token this chunk covers, for a head chunk. */
	firstToken?: number;
	/** The last vocabulary token this chunk covers, for a head chunk. */
	lastToken?: number;
	/** The shape of this shard's key/value cache, for a decoder shard. */
	cacheShape?: number[];
	/** How many dimensions the cache has. Milestone one requires 4 or lower. */
	cacheRank?: number;
	/** How many elements the cache holds. */
	cacheElementCount?: number;
	/** How many bytes the cache occupies at 32-bit floating point. */
	cacheBytes?: number;
	/** The shape of the input. */
	inputShape: number[];
	/** The shape of the output. */
	outputShape: number[];
	/** The exact input PyTorch was given. */
	sampleInput: number[];
	/** The exact output PyTorch produced. */
	expectedOutput: number[];
	/** The first eight values of the cache PyTorch produced. */
	expectedCacheFirstValues?: number[];
	/** The last eight values of the cache PyTorch produced. */
	expectedCacheLastValues?: number[];
	/** The size of the generated `.tflite` file, in bytes. */
	fileBytes: number;
};

/**
 * How far a produced value may sit from the value PyTorch produced before the answer counts as wrong.
 *
 * Four decoder layers of real attention and real feed-forward arithmetic run inside each shard, and the
 * chained check accumulates seven of those in a row, so this is looser than the trivial single-layer gates.
 * It is still orders of magnitude below the wrong answers milestone one found, which were wrong by whole
 * factors rather than by rounding.
 */
const TOLERANCE = 5e-3;

/**
 * How far a chained logit may sit from the real unsplit model's logit.
 *
 * The eager PyTorch check of the same decomposition reached 1.25e-4 against the real model, so this allows
 * an order of magnitude on top of that for the runtime's own arithmetic.
 */
const CHAIN_TOLERANCE = 2e-2;

/**
 * The names of the buffer types, so a reported buffer type says something rather than a number.
 */
const BUFFER_TYPE_NAMES = new Map<number, string>(
	Object.entries(TensorBufferType).map(([name, value]) => [value, name]),
);

const outputElement = document.querySelector('#output') as HTMLPreElement;

/**
 * Writes one line to the page and to the browser console.
 *
 * @param line The line to write.
 * @returns Nothing.
 */
function report(line: string): void {
	outputElement.textContent += `${line}\n`;
	console.log(line);
}

/**
 * Formats a duration in milliseconds to three decimal places.
 *
 * @param milliseconds The duration.
 * @returns The duration, written out with its unit.
 */
function formatMilliseconds(milliseconds: number): string {
	return `${milliseconds.toFixed(3)} ms`;
}

/**
 * Names a buffer type.
 *
 * @param bufferType The buffer type.
 * @returns Its name.
 */
function bufferTypeName(bufferType: number): string {
	return BUFFER_TYPE_NAMES.get(bufferType) ?? String(bufferType);
}

/**
 * Builds the rotary cosine and sine table for one position, matching the export script's `rotary_tables`.
 *
 * @param position The token position.
 * @param headDimension The head dimension.
 * @param ropeTheta The rotary base.
 * @returns The cosine and the sine, each with `headDimension` elements.
 */
function rotaryTables(position: number, headDimension: number, ropeTheta: number): [Float32Array, Float32Array] {
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
 * Fetches one row of the token embedding table with an HTTP range request.
 *
 * This is why the 622 megabyte embedding table is not exported into any graph. Decoding one token needs
 * exactly one row of it, and one row is 4096 bytes.
 *
 * @param embeddingFile The raw embedding file's name.
 * @param token The token to look up.
 * @param hiddenSize The hidden size, which is the width of one row.
 * @returns That token's embedding row.
 */
async function fetchEmbeddingRow(
	embeddingFile: string,
	token: number,
	hiddenSize: number,
): Promise<Float32Array> {
	const rowBytes = hiddenSize * Float32Array.BYTES_PER_ELEMENT;
	const firstByte = token * rowBytes;
	const lastByte = firstByte + rowBytes - 1;
	const response = await fetch(`./models/${embeddingFile}`, {
		headers: {
			Range: `bytes=${firstByte}-${lastByte}`,
		},
	});
	if (response.status !== 206) {
		throw new Error(`Expected a 206 Partial Content answer for the embedding row, got ${response.status}.`);
	}
	return new Float32Array(await response.arrayBuffer());
}

/**
 * Compares two arrays and returns the largest absolute difference.
 *
 * @param actual The values LiteRT.js produced.
 * @param expected The values PyTorch produced.
 * @returns The largest absolute difference, and the index it occurred at.
 */
function largestAbsoluteDifference(
	actual: ArrayLike<number>,
	expected: ArrayLike<number>,
): { difference: number; index: number } {
	let largest = 0;
	let largestIndex = -1;
	for (let index = 0; index < expected.length; index += 1) {
		const difference = Math.abs(actual[index] - expected[index]);
		if (difference > largest) {
			largest = difference;
			largestIndex = index;
		}
	}
	return { difference: largest, index: largestIndex };
}

/**
 * Loads one graph and reports what its boundaries look like.
 *
 * @param name The graph's file name.
 * @param accelerator The accelerator to compile for.
 * @returns The compiled graph, or undefined when it could not be loaded.
 */
async function loadOne(name: string, accelerator: Accelerator): Promise<CompiledModel | undefined> {
	const modelBytes = new Uint8Array(await (await fetch(`./models/qwen3_0_6b_${name}.tflite`)).arrayBuffer());
	try {
		const compileStart = performance.now();
		const model = await loadAndCompile(modelBytes, {
			accelerator,
		});
		report(
			`    ${name}: loadAndCompile ${formatMilliseconds(performance.now() - compileStart)}, ` +
				`isFullyAccelerated=${model.isFullyAccelerated}, ${(modelBytes.byteLength / 1e6).toFixed(1)} MB`,
		);
		return model;
	} catch (error) {
		report(`    ${name}: loadAndCompile FAILED: ${error}`);
		return undefined;
	}
}

/**
 * Runs every graph on one accelerator, first one at a time against PyTorch, then chained end to end.
 *
 * @param index What the export wrote.
 * @param references Every graph's reference values, by name.
 * @param accelerator The accelerator to compile for.
 * @returns Nothing.
 */
async function checkOneAccelerator(
	index: ShardIndex,
	references: Map<string, ShardReference>,
	accelerator: Accelerator,
): Promise<void> {
	report(`\n=== accelerator=${accelerator} ===`);

	const [cosine, sine] = rotaryTables(index.samplePosition, index.headDimension, index.ropeTheta);
	const writeMaskValues = new Float32Array(index.cachePositions);
	writeMaskValues[index.samplePosition] = 1;
	const attentionMaskValues = new Float32Array(index.cachePositions).fill(-Infinity);
	for (let position = 0; position <= index.samplePosition; position += 1) {
		attentionMaskValues[position] = 0;
	}

	// Each graph is loaded, checked, and freed before the next one is loaded. Holding all ten at once is not
	// the architecture this project is building — one worker owns one shard — and it does not fit anyway: the
	// fourth simultaneous 251.8 megabyte graph fails to allocate, even though each one loads cleanly on its
	// own. The WebAssembly heap is shared by every loaded graph, and each `loadAndCompile()` needs one
	// contiguous block the size of the whole file.
	report('\n  each graph on its own, against PyTorch (loaded and freed one at a time):');
	let everyGraphCorrect = true;
	for (const name of [...index.decoderShards, ...index.headChunks]) {
		const reference = references.get(name) as ShardReference;
		const model = await loadOne(name, accelerator);
		if (model === undefined) {
			everyGraphCorrect = false;
			continue;
		}
		const inputTensor = new Tensor(new Float32Array(reference.sampleInput), reference.inputShape);
		const extraTensors: Tensor[] = [];
		const inputs: Tensor[] = [inputTensor];

		if (reference.kind === 'decoder') {
			const cacheShape = reference.cacheShape as number[];
			const cacheTensor = new Tensor(
				new Float32Array(reference.cacheElementCount as number),
				cacheShape,
			);
			const cosineTensor = new Tensor(cosine, [1, 1, 1, index.headDimension]);
			const sineTensor = new Tensor(sine, [1, 1, 1, index.headDimension]);
			const writeMaskTensor = new Tensor(writeMaskValues, [1, index.cachePositions, 1]);
			const attentionMaskTensor = new Tensor(attentionMaskValues, [1, 1, 1, index.cachePositions]);
			extraTensors.push(cacheTensor, cosineTensor, sineTensor, writeMaskTensor, attentionMaskTensor);
			inputs.push(cacheTensor, cosineTensor, sineTensor, writeMaskTensor, attentionMaskTensor);
		}

		try {
			const outputs = (await model.run(inputs)) as Tensor[];
			const producedOutput = await outputs[0].data();
			const comparison = largestAbsoluteDifference(producedOutput, reference.expectedOutput);
			let line =
				`    ${name}: output difference ${comparison.difference.toExponential(3)} ` +
				`over ${reference.expectedOutput.length} values, ` +
				`bufferType=${bufferTypeName(outputs[0].getBufferType())}`;

			if (reference.kind === 'decoder') {
				const producedCache = await outputs[1].data();
				const cacheFirst = largestAbsoluteDifference(
					producedCache.subarray(0, 8),
					reference.expectedCacheFirstValues as number[],
				);
				const cacheLast = largestAbsoluteDifference(
					producedCache.subarray(producedCache.length - 8),
					reference.expectedCacheLastValues as number[],
				);
				line +=
					`, cache difference ${Math.max(cacheFirst.difference, cacheLast.difference).toExponential(3)}` +
					`, cache bufferType=${bufferTypeName(outputs[1].getBufferType())}`;
				if (Math.max(cacheFirst.difference, cacheLast.difference) >= TOLERANCE) {
					everyGraphCorrect = false;
				}
			}
			if (comparison.difference >= TOLERANCE) {
				everyGraphCorrect = false;
				line += '  <-- WRONG';
			}
			report(line);
			for (const output of outputs) {
				output.delete();
			}
		} catch (error) {
			report(`    ${name}: run FAILED: ${error}`);
			everyGraphCorrect = false;
		} finally {
			inputTensor.delete();
			for (const tensor of extraTensors) {
				tensor.delete();
			}
			model.delete();
		}
	}
	report(`  every graph correct on its own: ${everyGraphCorrect}`);

	// Now the whole model, chained: one embedding row fetched by range request, seven decoder shards in
	// sequence passing only the hidden state, then three head chunks whose logits concatenate.
	report('\n  the whole model, chained end to end:');
	const embeddingStart = performance.now();
	const embeddingRow = await fetchEmbeddingRow(index.embeddingFile, index.sampleToken, index.hiddenSize);
	report(
		`    embedding row for token ${index.sampleToken}: fetched ${embeddingRow.byteLength} bytes ` +
			`by range request in ${formatMilliseconds(performance.now() - embeddingStart)}`,
	);
	const embeddingComparison = largestAbsoluteDifference(embeddingRow, index.embeddingRow);
	report(`    embedding row difference against PyTorch: ${embeddingComparison.difference.toExponential(3)}`);

	// Each shard is loaded, run, and freed in turn, so that only one is ever resident. That is what one
	// worker per shard looks like, and it is the only way ten graphs of this size fit on one machine at all.
	// The hidden state is read back to JavaScript between shards, exactly as it would have to be if the next
	// shard were on another device.
	let hiddenValues = embeddingRow;
	const chainStart = performance.now();
	// `run()` and reading the output back are counted apart, because milestone zero found that reading a
	// WebGPU tensor back costs more than computing it, and a single figure covering both hides which one
	// a change moved.
	let chainRunMilliseconds = 0;
	let chainReadbackMilliseconds = 0;
	let chainFailed = false;

	for (const name of index.decoderShards) {
		const reference = references.get(name) as ShardReference;
		const model = await loadOne(name, accelerator);
		if (model === undefined) {
			chainFailed = true;
			break;
		}
		const hiddenTensor = new Tensor(hiddenValues, [1, 1, index.hiddenSize]);
		const cacheTensor = new Tensor(
			new Float32Array(reference.cacheElementCount as number),
			reference.cacheShape as number[],
		);
		const cosineTensor = new Tensor(cosine, [1, 1, 1, index.headDimension]);
		const sineTensor = new Tensor(sine, [1, 1, 1, index.headDimension]);
		const writeMaskTensor = new Tensor(writeMaskValues, [1, index.cachePositions, 1]);
		const attentionMaskTensor = new Tensor(attentionMaskValues, [1, 1, 1, index.cachePositions]);

		const runStart = performance.now();
		const outputs = (await model.run([
			hiddenTensor,
			cacheTensor,
			cosineTensor,
			sineTensor,
			writeMaskTensor,
			attentionMaskTensor,
		])) as Tensor[];
		const readbackStart = performance.now();
		hiddenValues = (await outputs[0].data()) as Float32Array;
		chainRunMilliseconds += readbackStart - runStart;
		chainReadbackMilliseconds += performance.now() - readbackStart;

		for (const output of outputs) {
			output.delete();
		}
		hiddenTensor.delete();
		cacheTensor.delete();
		cosineTensor.delete();
		sineTensor.delete();
		writeMaskTensor.delete();
		attentionMaskTensor.delete();
		model.delete();
	}

	const logits = new Float32Array(index.vocabularySize);
	if (chainFailed === false) {
		for (const name of index.headChunks) {
			const reference = references.get(name) as ShardReference;
			const model = await loadOne(name, accelerator);
			if (model === undefined) {
				chainFailed = true;
				break;
			}
			const hiddenTensor = new Tensor(hiddenValues, [1, 1, index.hiddenSize]);
			const runStart = performance.now();
			const outputs = (await model.run([hiddenTensor])) as Tensor[];
			const readbackStart = performance.now();
			const chunkLogits = await outputs[0].data();
			chainRunMilliseconds += readbackStart - runStart;
			chainReadbackMilliseconds += performance.now() - readbackStart;
			logits.set(chunkLogits, reference.firstToken as number);
			outputs[0].delete();
			hiddenTensor.delete();
			model.delete();
		}
	}
	const chainWallClock = performance.now() - chainStart;

	if (chainFailed) {
		report('    the chain could not be completed, because a graph failed to load.');
		return;
	}

	let argmaxToken = 0;
	let argmaxValue = -Infinity;
	for (let token = 0; token < logits.length; token += 1) {
		if (logits[token] > argmaxValue) {
			argmaxValue = logits[token];
			argmaxToken = token;
		}
	}
	const logitsComparison = largestAbsoluteDifference(
		logits.subarray(0, 8),
		index.referenceLogitsFirstValues,
	);

	report(`    chained ${index.decoderShards.length} decoder shards and ${index.headChunks.length} head chunks`);
	// None of these three figures is an inference measurement. The wall clock is dominated by loading and
	// freeing ten graphs in sequence, which milestone six does once per worker instead. They vary by several
	// times between runs on an otherwise busy machine, so read them as an order of magnitude, nothing finer.
	report(
		`    time inside run(): ${formatMilliseconds(chainRunMilliseconds)}, ` +
			`reading the outputs back: ${formatMilliseconds(chainReadbackMilliseconds)}, ` +
			`wall clock ${formatMilliseconds(chainWallClock)}`,
	);
	// The comparison is against PyTorch running this same decomposition under the same conditions, not
	// against the real model on a fresh sequence: at position 3 with an all-zero cache the attention also
	// attends to three all-zero cache positions, which a real model at position 0 never does. That the
	// decomposition reproduces the real model is established separately, in eager PyTorch over a real
	// multi-token sequence — see tools/qwen3_litert_shard_export/CONTEXT.md.
	report(
		`    first logits against PyTorch running the same decomposition: difference ` +
			`${logitsComparison.difference.toExponential(3)}`,
	);
	report(
		`    predicted token: ${argmaxToken}, PyTorch predicts ${index.referenceArgmaxToken}, ` +
			`match=${argmaxToken === index.referenceArgmaxToken}`,
	);
	report(
		`    CHAINED CORRECT=${logitsComparison.difference < CHAIN_TOLERANCE && argmaxToken === index.referenceArgmaxToken}`,
	);
}

/**
 * Runs the whole gate.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	outputElement.textContent = '';
	report(`userAgent: ${navigator.userAgent}`);
	report(`isWebGPUSupported(): ${isWebGPUSupported()}`);

	const adapter = await navigator.gpu?.requestAdapter();
	if (adapter !== undefined && adapter !== null) {
		const { vendor, architecture } = adapter.info;
		report(`WebGPU adapter info: vendor=${vendor} architecture=${architecture}`);
	}

	// The build LiteRT.js picks on its own cannot read a WebGPU tensor back, as found in milestone one.
	await loadLiteRt('/wasm/litert_wasm_jspi_internal.js');
	report('loadLiteRt: JSPI build');

	const index = (await (await fetch('./models/index.json')).json()) as ShardIndex;
	const references = new Map<string, ShardReference>();
	let largestFile = 0;
	for (const name of [...index.decoderShards, ...index.headChunks]) {
		const reference = (await (
			await fetch(`./models/qwen3_0_6b_${name}.reference.json`)
		).json()) as ShardReference;
		references.set(name, reference);
		largestFile = Math.max(largestFile, reference.fileBytes);
	}

	report(
		`\n${index.model}: ${index.decoderShards.length} decoder shards, ` +
			`${index.headChunks.length} head chunks, largest file ${(largestFile / 1e6).toFixed(1)} MB`,
	);
	const cacheRanks = new Set([...references.values()].map((reference) => reference.cacheRank).filter(Boolean));
	report(`cache ranks in use: ${[...cacheRanks].join(', ')} (milestone one requires 4 or lower)`);

	const requested = new URLSearchParams(location.search).get('accelerators') ?? 'webgpu,wasm';
	for (const accelerator of requested.split(',') as Accelerator[]) {
		await checkOneAccelerator(index, references, accelerator);
	}

	report('\nDone.');
}

(document.querySelector('#run') as HTMLButtonElement).addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
	});
});
