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
//	Qwen3LiteRtResidentDecode — the de-risking gate of milestone four of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one decoder shard produced at one position, reduced to the few numbers worth comparing.
 */
type ShardOutputReference = {
	/** The shard's name. */
	name: string;
	/** The first eight values of the hidden state it produced. */
	firstValues: number[];
	/** The sum of the absolute values of all 1024 values of that hidden state. */
	absoluteSum: number;
};

/**
 * One decode step, as PyTorch ran it.
 */
type StepReference = {
	/** The token position. */
	position: number;
	/** The token fed in at this position. */
	inputToken: number;
	/** Whether this position belongs to the prompt rather than to the generated text. */
	isPrompt: boolean;
	/** What each decoder shard produced, in the order the shards run. */
	shardOutputs: ShardOutputReference[];
	/** The first eight logits. */
	logitsFirstValues: number[];
	/** The token the logits chose. */
	sampledToken: number;
};

/**
 * The whole autoregressive run, as PyTorch ran it.
 */
type DecodeReference = {
	/** The model that was run. */
	model: string;
	/** The prompt it was given. */
	prompt: string;
	/** The prompt's tokens. */
	promptTokens: number[];
	/** How many positions every cache holds. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** The head dimension. */
	headDimension: number;
	/** The rotary base. */
	ropeTheta: number;
	/** The raw token embedding table, read one row at a time with a range request. */
	embeddingFile: string;
	/** The decoder shards, in the order they run. */
	decoderShards: string[];
	/** The token fed in at each position, prompt tokens first and then generated ones. */
	inputTokens: number[];
	/** The tokens the decomposition generated. */
	generatedTokens: number[];
	/** Those tokens as text. */
	generatedText: string;
	/** The tokens the unsplit Hugging Face model generated from the same prompt. */
	unsplitTokens: number[];
	/** The index of the first generated token the two disagree on, or null when they agree throughout. */
	firstDivergence: number | null;
	/** Every step. */
	steps: StepReference[];
};

/**
 * What one decode loop produced and cost.
 */
type LoopResult = {
	/** Whether every step matched PyTorch. */
	isCorrect: boolean;
	/** The largest relative difference of any step's absolute sum. */
	largestSumDifference: number;
	/** The largest relative difference of any of the first eight values of any step. */
	largestValueDifference: number;
	/** The first step that exceeded the tolerance, or -1 when none did. */
	firstWrongStep: number;
	/** Milliseconds spent inside `model.run()`, summed. */
	runMilliseconds: number;
	/** Milliseconds spent reading the hidden state back, summed. */
	hiddenReadbackMilliseconds: number;
	/** Milliseconds spent reading the cache back and uploading it again, summed. */
	cacheRoundTripMilliseconds: number;
	/** Wall-clock milliseconds for the whole loop. */
	totalMilliseconds: number;
	/** The buffer type the cache tensor had on the last step. */
	finalCacheBufferType: number;
	/** Wall-clock milliseconds of each block of steps, to show whether the loop drifts. */
	blockMilliseconds: number[];
};

/**
 * Where the shards, the embedding table, and the reference live.
 *
 * They are generated artifacts of about 2.4 gigabytes written for `qwen3-litert-shards`, and this gate reads
 * the same copy rather than a second one. This is a path, not an import: no code is shared between the two
 * experiments.
 */
const MODELS_PREFIX = '/qwen3-litert-shards/models';

/**
 * The two loops, differing only in whether the key/value cache ever leaves the graphics processor.
 */
const VARIANTS = ['resident', 'cache-round-trip'] as const;

/**
 * One of the two loops.
 */
type Variant = (typeof VARIANTS)[number];

/**
 * How far a produced value may sit from PyTorch's, as a fraction of PyTorch's own magnitude.
 *
 * A relative tolerance is used rather than an absolute one because the values being compared span four orders
 * of magnitude: the summed hidden state runs from about 250 to about 10900 across the sequence. The wrong
 * answers milestone one found were wrong by whole factors, so this is far tighter than it needs to be to
 * catch them.
 */
const RELATIVE_TOLERANCE = 1e-3;

/**
 * How many steps are run and thrown away before either loop is measured.
 *
 * Four is enough: the wall clock of each block of six steps settles by the second block in every run seen so
 * far, and the first block is the only one that carries the shader compilation.
 */
const WARMUP_STEPS = 4;

/**
 * The names of the buffer types, so a reported buffer type says something rather than a number.
 */
const BUFFER_TYPE_NAMES = new Map<number, string>(
	Object.entries(TensorBufferType).map(([name, value]) => [value, name]),
);

const searchParameters = new URLSearchParams(location.search);

/**
 * Which decoder shard to run. Only the first one can run on its own, because only its input at every position
 * is known in advance: the embedding row of that position's token.
 *
 * A shard exported with a different attention layout carries a suffix, such as `decoder_00-03_grouped`. Its
 * own reference file names which shard of the reference it is to be compared against, so the same PyTorch
 * values check every layout.
 */
const SHARD_NAME = searchParameters.get('shard') ?? 'decoder_00-03';

const outputElement = document.querySelector('#output') as HTMLPreElement;

/**
 * Whether `loadLiteRt()` has already run on this page.
 *
 * It refuses a second call with "LiteRT is already loading / loaded", and this gate is meant to be run
 * several times in a row: no timing is reported from a single run.
 */
let isLiteRtLoaded = false;

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
 * Reads the JavaScript heap size, when the browser reports one.
 *
 * @returns The heap size in bytes, or undefined when the browser does not report it.
 */
function javaScriptHeapBytes(): number | undefined {
	const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
	return memory?.usedJSHeapSize;
}

/**
 * Measures how far one value sits from another, as a fraction of the second one's magnitude.
 *
 * @param actual The value produced.
 * @param expected The value PyTorch produced.
 * @returns The relative difference.
 */
function relativeDifference(actual: number, expected: number): number {
	return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-6);
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
 * Builds the cache write mask and the attention mask for one position.
 *
 * @param position The token position being decoded.
 * @param cachePositions How many positions the cache holds.
 * @returns The one-hot write mask, and the attention mask that admits positions up to this one.
 */
function decodeMasks(position: number, cachePositions: number): [Float32Array, Float32Array] {
	const writeMask = new Float32Array(cachePositions);
	writeMask[position] = 1;
	const attentionMask = new Float32Array(cachePositions).fill(-Infinity);
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
async function fetchEmbeddingRow(
	embeddingFile: string,
	token: number,
	hiddenSize: number,
): Promise<Float32Array> {
	const rowBytes = hiddenSize * Float32Array.BYTES_PER_ELEMENT;
	const firstByte = token * rowBytes;
	const lastByte = firstByte + rowBytes - 1;
	const response = await fetch(`${MODELS_PREFIX}/${embeddingFile}`, {
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
 * Runs the whole sequence through one shard, and compares every step against PyTorch.
 *
 * @param model The compiled decoder shard.
 * @param reference The whole autoregressive run, as PyTorch ran it.
 * @param embeddingRows One embedding row per position, already fetched.
 * @param cacheShape The shape of this shard's key/value cache.
 * @param referenceShardName Which shard of the reference this shard is compared against.
 * @param variant Whether the cache stays on the graphics processor or round trips through JavaScript.
 * @param isReported Whether to write the per-position lines. The warm-up loop is silent.
 * @returns What the loop produced and cost.
 */
async function runDecodeLoop(
	model: CompiledModel,
	reference: DecodeReference,
	embeddingRows: Float32Array[],
	cacheShape: number[],
	referenceShardName: string,
	variant: Variant,
	isReported: boolean,
): Promise<LoopResult> {
	let cacheElementCount = 1;
	for (const dimension of cacheShape) {
		cacheElementCount *= dimension;
	}
	let cacheTensor = new Tensor(new Float32Array(cacheElementCount), cacheShape);

	let runMilliseconds = 0;
	let hiddenReadbackMilliseconds = 0;
	let cacheRoundTripMilliseconds = 0;
	let largestSumDifference = 0;
	let largestValueDifference = 0;
	let firstWrongStep = -1;
	const blockMilliseconds: number[] = [];
	const blockSize = Math.max(1, Math.floor(reference.steps.length / 6));

	const loopStart = performance.now();
	let blockStart = loopStart;

	for (const step of reference.steps) {
		const [cosine, sine] = rotaryTables(step.position, reference.headDimension, reference.ropeTheta);
		const [writeMask, attentionMask] = decodeMasks(step.position, reference.cachePositions);

		const hiddenTensor = new Tensor(embeddingRows[step.position], [1, 1, reference.hiddenSize]);
		const cosineTensor = new Tensor(cosine, [1, 1, 1, reference.headDimension]);
		const sineTensor = new Tensor(sine, [1, 1, 1, reference.headDimension]);
		const writeMaskTensor = new Tensor(writeMask, [1, reference.cachePositions, 1]);
		const attentionMaskTensor = new Tensor(attentionMask, [1, 1, 1, reference.cachePositions]);

		const runStart = performance.now();
		const outputs = (await model.run([
			hiddenTensor,
			cacheTensor,
			cosineTensor,
			sineTensor,
			writeMaskTensor,
			attentionMaskTensor,
		])) as Tensor[];
		const runEnd = performance.now();
		runMilliseconds += runEnd - runStart;

		// The hidden state is read back in both variants. In the real architecture it crosses the network to
		// the next worker on every step anyway, so reading it back is not what residency is about; the cache
		// is.
		const producedHidden = await outputs[0].data();
		hiddenReadbackMilliseconds += performance.now() - runEnd;

		const expected = step.shardOutputs.find((shardOutput) => shardOutput.name === referenceShardName);
		if (expected === undefined) {
			throw new Error(`The reference has no output for ${referenceShardName} at position ${step.position}.`);
		}
		let absoluteSum = 0;
		for (const value of producedHidden) {
			absoluteSum += Math.abs(value);
		}
		const sumDifference = relativeDifference(absoluteSum, expected.absoluteSum);
		let valueDifference = 0;
		for (let index = 0; index < expected.firstValues.length; index += 1) {
			valueDifference = Math.max(
				valueDifference,
				relativeDifference(producedHidden[index], expected.firstValues[index]),
			);
		}
		largestSumDifference = Math.max(largestSumDifference, sumDifference);
		largestValueDifference = Math.max(largestValueDifference, valueDifference);
		if (
			firstWrongStep === -1 &&
			(sumDifference >= RELATIVE_TOLERANCE || valueDifference >= RELATIVE_TOLERANCE)
		) {
			firstWrongStep = step.position;
			if (isReported) {
				report(
					`      position ${step.position} is the first to exceed the tolerance: ` +
						`sum ${absoluteSum.toFixed(4)} against ${expected.absoluteSum.toFixed(4)}, ` +
						`relative ${sumDifference.toExponential(3)}`,
				);
			}
		}
		if (isReported && (step.position === 0 || step.position === reference.steps.length - 1)) {
			report(
				`      position ${step.position}: absolute sum ${absoluteSum.toFixed(4)} ` +
					`against ${expected.absoluteSum.toFixed(4)} ` +
					`(relative ${sumDifference.toExponential(3)}), ` +
					`largest relative difference of the first eight values ${valueDifference.toExponential(3)}`,
			);
		}

		outputs[0].delete();
		cacheTensor.delete();
		if (variant === 'cache-round-trip') {
			const roundTripStart = performance.now();
			const cacheValues = await outputs[1].data();
			outputs[1].delete();
			cacheTensor = new Tensor(cacheValues, cacheShape);
			cacheRoundTripMilliseconds += performance.now() - roundTripStart;
		} else {
			cacheTensor = outputs[1];
		}

		hiddenTensor.delete();
		cosineTensor.delete();
		sineTensor.delete();
		writeMaskTensor.delete();
		attentionMaskTensor.delete();

		if ((step.position + 1) % blockSize === 0) {
			const blockEnd = performance.now();
			blockMilliseconds.push(blockEnd - blockStart);
			blockStart = blockEnd;
		}
	}

	const finalCacheBufferType = cacheTensor.getBufferType();
	const totalMilliseconds = performance.now() - loopStart;
	cacheTensor.delete();

	return {
		isCorrect: firstWrongStep === -1,
		largestSumDifference,
		largestValueDifference,
		firstWrongStep,
		runMilliseconds,
		hiddenReadbackMilliseconds,
		cacheRoundTripMilliseconds,
		totalMilliseconds,
		finalCacheBufferType,
		blockMilliseconds,
	};
}

/**
 * Runs both loops on one accelerator.
 *
 * @param reference The whole autoregressive run, as PyTorch ran it.
 * @param embeddingRows One embedding row per position, already fetched.
 * @param cacheShape The shape of this shard's key/value cache.
 * @param referenceShardName Which shard of the reference this shard is compared against.
 * @param accelerator The accelerator to compile for.
 * @returns Whether the resident loop was correct.
 */
async function checkOneAccelerator(
	reference: DecodeReference,
	embeddingRows: Float32Array[],
	cacheShape: number[],
	referenceShardName: string,
	accelerator: Accelerator,
): Promise<boolean> {
	report(`\n=== accelerator=${accelerator} ===`);

	const modelBytes = new Uint8Array(
		await (await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${SHARD_NAME}.tflite`)).arrayBuffer(),
	);
	let model: CompiledModel;
	const compileStart = performance.now();
	try {
		model = await loadAndCompile(modelBytes, {
			accelerator,
		});
	} catch (error) {
		report(`  loadAndCompile FAILED: ${error}`);
		return false;
	}
	report(
		`  ${SHARD_NAME}: loadAndCompile ${formatMilliseconds(performance.now() - compileStart)}, ` +
			`isFullyAccelerated=${model.isFullyAccelerated}, ${(modelBytes.byteLength / 1e6).toFixed(1)} MB`,
	);

	// A few steps are run and thrown away before anything is measured. Compiling the shaders, allocating the
	// buffers, and warming the delegate cost hundreds of milliseconds per step on the first steps only, and
	// without this they land entirely on whichever loop runs first — which made the resident loop look five
	// times slower than the round-trip loop when the two are in fact within one percent of each other.
	const warmupStart = performance.now();
	await runDecodeLoop(
		model,
		{
			...reference,
			steps: reference.steps.slice(0, WARMUP_STEPS),
		},
		embeddingRows,
		cacheShape,
		referenceShardName,
		'resident',
		false,
	);
	report(`  warm-up of ${WARMUP_STEPS} steps, not measured: ${formatMilliseconds(performance.now() - warmupStart)}`);

	let isResidentCorrect = false;
	const results = new Map<Variant, LoopResult>();
	for (const variant of VARIANTS) {
		report(`\n  ${variant}, ${reference.steps.length} decode steps`);
		const heapBefore = javaScriptHeapBytes();
		let result: LoopResult;
		try {
			result = await runDecodeLoop(
				model,
				reference,
				embeddingRows,
				cacheShape,
				referenceShardName,
				variant,
				true,
			);
		} catch (error) {
			report(`      FAILED: ${error}`);
			continue;
		}
		const heapAfter = javaScriptHeapBytes();
		results.set(variant, result);
		if (variant === 'resident') {
			isResidentCorrect = result.isCorrect;
		}

		report(
			`      correct=${result.isCorrect} over every step, ` +
				`final cache bufferType=${bufferTypeName(result.finalCacheBufferType)}`,
		);
		report(
			`      largest relative difference: absolute sum ${result.largestSumDifference.toExponential(3)}, ` +
				`first eight values ${result.largestValueDifference.toExponential(3)}`,
		);
		report(
			`      per step, run(): ${formatMilliseconds(result.runMilliseconds / reference.steps.length)}, ` +
				`hidden state readback: ` +
				`${formatMilliseconds(result.hiddenReadbackMilliseconds / reference.steps.length)}`,
		);
		if (result.cacheRoundTripMilliseconds > 0) {
			let cacheElementCount = 1;
			for (const dimension of cacheShape) {
				cacheElementCount *= dimension;
			}
			const perStep = result.cacheRoundTripMilliseconds / reference.steps.length;
			const gigabytesPerSecond = (cacheElementCount * 4) / (perStep / 1000) / 1e9;
			report(
				`      per step, cache round trip of ${cacheElementCount * 4} bytes: ` +
					`${formatMilliseconds(perStep)} (${gigabytesPerSecond.toFixed(2)} gigabytes per second)`,
			);
		}
		report(`      per step, wall clock: ${formatMilliseconds(result.totalMilliseconds / reference.steps.length)}`);
		report(
			`      wall clock of each block of ${Math.max(1, Math.floor(reference.steps.length / 6))} steps: ` +
				`${result.blockMilliseconds.map((milliseconds) => milliseconds.toFixed(0)).join(', ')} ms`,
		);
		if (heapBefore !== undefined && heapAfter !== undefined) {
			report(`      JavaScript heap: ${heapBefore} -> ${heapAfter} bytes (${heapAfter - heapBefore} difference)`);
		} else {
			report('      JavaScript heap: not reported by this browser');
		}
	}

	const resident = results.get('resident');
	const roundTrip = results.get('cache-round-trip');
	if (resident !== undefined && roundTrip !== undefined) {
		const saved = roundTrip.totalMilliseconds - resident.totalMilliseconds;
		report(
			`\n  keeping the cache resident saved ${formatMilliseconds(saved)} over ` +
				`${reference.steps.length} steps, ` +
				`which is ${(roundTrip.totalMilliseconds / resident.totalMilliseconds).toFixed(2)} times the ` +
				`wall clock of the resident loop`,
		);
		report(
			`  both loops agree with PyTorch: resident=${resident.isCorrect} ` +
				`cache-round-trip=${roundTrip.isCorrect}`,
		);
	}

	model.delete();
	return isResidentCorrect;
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
	if (isLiteRtLoaded === false) {
		await loadLiteRt('/wasm/litert_wasm_jspi_internal.js');
		isLiteRtLoaded = true;
		report('loadLiteRt: JSPI build');
	} else {
		report('loadLiteRt: already loaded by an earlier run on this page');
	}

	const reference = (await (await fetch(`${MODELS_PREFIX}/decode_reference.json`)).json()) as DecodeReference;
	const shardReference = (await (
		await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${SHARD_NAME}.reference.json`)
	).json()) as { cacheShape: number[]; referenceName?: string; attentionLayout?: string };
	const referenceShardName = shardReference.referenceName ?? SHARD_NAME;

	report(`\n${reference.model}, prompt ${JSON.stringify(reference.prompt)}`);
	report(`${reference.steps.length} decode steps, ${reference.generatedTokens.length} tokens generated`);
	report(`PyTorch generated: ${JSON.stringify(reference.generatedText)}`);
	report(
		`the decomposition and the unsplit Hugging Face model agree on every generated token: ` +
			`${reference.firstDivergence === null}`,
	);
	report(
		`shard under test: ${SHARD_NAME}, attention layout ${shardReference.attentionLayout ?? 'expand'}, ` +
			`cache [${shardReference.cacheShape.join(', ')}], ` +
			`compared against the reference for ${referenceShardName}`,
	);

	const fetchStart = performance.now();
	const embeddingRows: Float32Array[] = [];
	for (const token of reference.inputTokens) {
		embeddingRows.push(await fetchEmbeddingRow(reference.embeddingFile, token, reference.hiddenSize));
	}
	report(
		`fetched ${embeddingRows.length} embedding rows by range request in ` +
			`${formatMilliseconds(performance.now() - fetchStart)}`,
	);

	const requested = searchParameters.get('accelerators') ?? 'webgpu,wasm';
	const verdicts = new Map<string, boolean>();
	for (const accelerator of requested.split(',') as Accelerator[]) {
		verdicts.set(
			accelerator,
			await checkOneAccelerator(
				reference,
				embeddingRows,
				shardReference.cacheShape,
				referenceShardName,
				accelerator,
			),
		);
	}

	report('\n=== verdict ===');
	for (const [accelerator, isCorrect] of verdicts) {
		report(`  ${accelerator}: the resident cache stayed correct over every step = ${isCorrect}`);
	}
	report('\nDone.');
}

(document.querySelector('#run') as HTMLButtonElement).addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
	});
});

// `?autorun=1` starts the run as soon as the page loads. It exists so that the whole run can be left alone:
// reading the page while it works is itself a disturbance, because touching a hidden tab lifts the slowdown
// Chrome puts on it, and that disturbance moved this project's decode figures by a factor of two and a half.
if (searchParameters.get('autorun') === '1') {
	(document.querySelector('#run') as HTMLButtonElement).click();
}
