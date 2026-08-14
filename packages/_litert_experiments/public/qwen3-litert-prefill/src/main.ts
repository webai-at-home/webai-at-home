import { Tensor, loadAndCompile, loadLiteRt, type CompiledModel } from '@litertjs/core';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Qwen3LiteRtPrefill — the milestone five gate of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one prefill shard produced, reduced to the numbers worth comparing.
 */
type Fingerprint = {
	/** The first eight values. */
	firstValues: number[];
	/** The sum of the absolute values of all of them. */
	absoluteSum: number;
};

/**
 * One prefill graph and what PyTorch produced from it.
 */
type PrefillShardReference = {
	/** The graph's name, which is also its file name. */
	name: string;
	/** The decode shard it holds the same layers as. */
	referenceName: string;
	/** The first decoder layer it owns. */
	firstLayer: number;
	/** The last decoder layer it owns. */
	lastLayer: number;
	/** The shape of the key/value cache it writes. */
	cacheShape: number[];
	/** All of the hidden states it produced. */
	hidden: Fingerprint;
	/** Only the last position's hidden state, which is what chooses the next token. */
	lastRow: Fingerprint;
	/** The cache it wrote. */
	cache: Fingerprint;
	/** The size of the generated `.tflite` file, in bytes. */
	fileBytes: number | null;
};

/**
 * One prompt length, and everything PyTorch produced for it.
 */
type PrefillReference = {
	/** How many tokens the prompt covers. */
	length: number;
	/** The prompt's tokens. */
	tokens: number[];
	/** The embedding rows for those tokens. */
	embeddingRowsFingerprint: Fingerprint;
	/** Each decoder shard's output, in the order they run. */
	shardOutputs: PrefillShardReference[];
	/** The first eight logits. */
	logitsFirstValues: number[];
	/** The token the split model chooses. */
	argmaxToken: number;
	/** The token the unsplit Hugging Face model chooses. */
	unsplitArgmaxToken: number;
	/** The largest generated file for this length. */
	largestFileBytes: number;
	/** The size of one activation of this length, at 32-bit floating point. */
	activationBytes: number;
};

/**
 * What the prefill export wrote.
 */
type PrefillIndex = {
	/** The model that was split. */
	model: string;
	/** How many positions every cache holds. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** The head dimension. */
	headDimension: number;
	/** The rotary base. */
	ropeTheta: number;
	/** How many query heads share one key/value head. */
	repeatCount: number;
	/** How many tokens the vocabulary holds. */
	vocabularySize: number;
	/** The raw token embedding table. */
	embeddingFile: string;
	/** The language-model head chunks, which prefill reuses from decode. */
	headChunks: string[];
	/** One entry per prompt length. */
	prefills: PrefillReference[];
};

/**
 * Where the graphs and the references live. Written by `tools/qwen3_prefill_export/`.
 */
const MODELS_PREFIX = '/qwen3-litert-shards/models';

/**
 * How far a produced value may sit from PyTorch's, as a fraction of PyTorch's own magnitude.
 */
const RELATIVE_TOLERANCE = 1e-3;

/**
 * How many prompts are run and thrown away before anything is measured.
 */
const WARMUP_RUNS = 2;

const outputElement = document.querySelector('#output') as HTMLPreElement;
const runButton = document.querySelector('#run') as HTMLButtonElement;
const searchParameters = new URLSearchParams(location.search);

/**
 * Which accelerator to compile for. Selectable so that a wrong answer on WebGPU can be told apart from a
 * wrong graph, which is what milestone one had to do twice.
 */
const ACCELERATOR = (searchParameters.get('accelerator') ?? 'webgpu') as 'webgpu' | 'wasm';

/**
 * Whether `loadLiteRt()` has already run on this page.
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
 * Compares a produced tensor against the fingerprint PyTorch wrote for it.
 *
 * @param produced The values produced.
 * @param expected The fingerprint.
 * @returns The largest relative difference of the summed values and of the first eight.
 */
function compareFingerprint(produced: Float32Array, expected: Fingerprint): number {
	let absoluteSum = 0;
	for (const value of produced) {
		absoluteSum += Math.abs(value);
	}
	let largest = relativeDifference(absoluteSum, expected.absoluteSum);
	for (let index = 0; index < expected.firstValues.length; index += 1) {
		largest = Math.max(largest, relativeDifference(produced[index], expected.firstValues[index]));
	}
	return largest;
}

/**
 * Builds the rotary cosine and sine for positions 0 to length - 1.
 *
 * @param length How many positions the prompt covers.
 * @param headDimension The head dimension.
 * @param ropeTheta The rotary base.
 * @returns The cosine and the sine, each with length x headDimension values.
 */
function prefillRotaryTables(
	length: number,
	headDimension: number,
	ropeTheta: number,
): [Float32Array, Float32Array] {
	const half = headDimension / 2;
	const cosine = new Float32Array(length * headDimension);
	const sine = new Float32Array(length * headDimension);
	for (let position = 0; position < length; position += 1) {
		for (let index = 0; index < half; index += 1) {
			const angle = position / ropeTheta ** ((2 * index) / headDimension);
			const base = position * headDimension;
			cosine[base + index] = Math.cos(angle);
			cosine[base + index + half] = Math.cos(angle);
			sine[base + index] = Math.sin(angle);
			sine[base + index + half] = Math.sin(angle);
		}
	}
	return [cosine, sine];
}

/**
 * Builds the causal mask, already tiled across the repeat axis the way the graph expects it.
 *
 * @param length How many positions the prompt covers.
 * @param repeatCount How many query heads share one key/value head.
 * @returns The mask, with repeatCount x length x length values.
 */
function prefillAttentionMask(length: number, repeatCount: number): Float32Array {
	const mask = new Float32Array(repeatCount * length * length);
	for (let repeat = 0; repeat < repeatCount; repeat += 1) {
		for (let query = 0; query < length; query += 1) {
			const row = (repeat * length + query) * length;
			for (let key = 0; key < length; key += 1) {
				mask[row + key] = key <= query ? 0 : -Infinity;
			}
		}
	}
	return mask;
}

/**
 * Fetches the embedding rows for a whole prompt, one range request per token.
 *
 * @param embeddingFile The raw embedding file's name.
 * @param tokens The prompt's tokens.
 * @param hiddenSize The hidden size, which is the width of one row.
 * @returns Every row, laid end to end.
 */
async function fetchEmbeddingRows(
	embeddingFile: string,
	tokens: number[],
	hiddenSize: number,
): Promise<Float32Array> {
	const rowBytes = hiddenSize * Float32Array.BYTES_PER_ELEMENT;
	const rows = new Float32Array(tokens.length * hiddenSize);
	for (let index = 0; index < tokens.length; index += 1) {
		const firstByte = tokens[index] * rowBytes;
		const response = await fetch(`${MODELS_PREFIX}/${embeddingFile}`, {
			headers: {
				Range: `bytes=${firstByte}-${firstByte + rowBytes - 1}`,
			},
		});
		if (response.status !== 206) {
			throw new Error(`Expected a 206 Partial Content answer, got ${response.status}.`);
		}
		rows.set(new Float32Array(await response.arrayBuffer()), index * hiddenSize);
	}
	return rows;
}

/**
 * Loads one graph.
 *
 * @param name The graph's file name, without the model prefix.
 * @returns The compiled graph, or undefined when it could not be loaded.
 */
async function loadOne(name: string): Promise<{ model: CompiledModel; bytes: number } | undefined> {
	const response = await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${name}.tflite`);
	if (response.ok === false) {
		report(`    ${name}: not written yet (${response.status})`);
		return undefined;
	}
	const modelBytes = new Uint8Array(await response.arrayBuffer());
	try {
		const model = await loadAndCompile(modelBytes, {
			accelerator: ACCELERATOR,
		});
		return {
			model,
			bytes: modelBytes.byteLength,
		};
	} catch (error) {
		report(`    ${name}: loadAndCompile FAILED: ${error}`);
		return undefined;
	}
}

/**
 * Runs one prompt length through every prefill shard and then the head, and measures it.
 *
 * @param index What the prefill export wrote.
 * @param prefill The prompt length being run.
 * @returns Nothing.
 */
async function runOneLength(index: PrefillIndex, prefill: PrefillReference): Promise<void> {
	report(`\n=== prompt length ${prefill.length} ===`);
	report(
		`  activation ${prefill.activationBytes} bytes (${(prefill.activationBytes / 1024 / 1024).toFixed(2)} mebibytes), ` +
			`largest graph ${((prefill.largestFileBytes || 0) / 1e6).toFixed(1)} MB`,
	);

	const [cosine, sine] = prefillRotaryTables(prefill.length, index.headDimension, index.ropeTheta);
	const attentionMask = prefillAttentionMask(prefill.length, index.repeatCount);
	report(
		`  causal mask ${attentionMask.byteLength} bytes, rotary tables ${cosine.byteLength * 2} bytes, ` +
			`both built in the browser`,
	);

	const embeddingStart = performance.now();
	const embeddingRows = await fetchEmbeddingRows(index.embeddingFile, prefill.tokens, index.hiddenSize);
	const embeddingMilliseconds = performance.now() - embeddingStart;
	report(
		`  fetched ${prefill.tokens.length} embedding rows by range request in ` +
			`${formatMilliseconds(embeddingMilliseconds)} ` +
			`(difference against PyTorch ${compareFingerprint(embeddingRows, prefill.embeddingRowsFingerprint).toExponential(3)})`,
	);

	let hidden = embeddingRows;
	let everyShardCorrect = true;
	let runMilliseconds = 0;
	let readbackMilliseconds = 0;
	let cacheCheckMilliseconds = 0;
	let anyShardMissing = false;

	for (const shard of prefill.shardOutputs) {
		const loaded = await loadOne(shard.name);
		if (loaded === undefined) {
			anyShardMissing = true;
			break;
		}
		const hiddenTensor = new Tensor(hidden, [1, prefill.length, index.hiddenSize]);
		const cosineTensor = new Tensor(cosine, [1, 1, prefill.length, index.headDimension]);
		const sineTensor = new Tensor(sine, [1, 1, prefill.length, index.headDimension]);
		const maskTensor = new Tensor(attentionMask, [
			1,
			index.repeatCount * prefill.length,
			prefill.length,
		]);

		// Two prompts are run and thrown away before the measured one, so that shader compilation and buffer
		// allocation do not land on the figure being reported.
		for (let warmup = 0; warmup < WARMUP_RUNS; warmup += 1) {
			const warmupOutputs = (await loaded.model.run([
				hiddenTensor,
				cosineTensor,
				sineTensor,
				maskTensor,
			])) as Tensor[];
			await warmupOutputs[0].data();
			for (const output of warmupOutputs) {
				output.delete();
			}
		}

		const runStart = performance.now();
		const outputs = (await loaded.model.run([
			hiddenTensor,
			cosineTensor,
			sineTensor,
			maskTensor,
		])) as Tensor[];
		const readbackStart = performance.now();
		const producedHidden = (await outputs[0].data()) as Float32Array;
		const cacheReadbackStart = performance.now();
		// Reading the cache back is checking, not prefilling. A real prefill leaves its cache on the graphics
		// processor for the decode that follows — that is milestone four's whole point — so this is counted
		// apart and kept out of the throughput figure.
		const producedCache = (await outputs[1].data()) as Float32Array;
		const cacheReadbackEnd = performance.now();
		runMilliseconds += readbackStart - runStart;
		readbackMilliseconds += cacheReadbackStart - readbackStart;
		cacheCheckMilliseconds += cacheReadbackEnd - cacheReadbackStart;

		const hiddenDifference = compareFingerprint(producedHidden, shard.hidden);
		const lastRow = producedHidden.subarray((prefill.length - 1) * index.hiddenSize);
		const lastRowDifference = compareFingerprint(lastRow, shard.lastRow);
		const cacheDifference = compareFingerprint(producedCache, shard.cache);
		let producedCacheSum = 0;
		for (const value of producedCache) {
			producedCacheSum += Math.abs(value);
		}
		report(
			`      cache readback: ${producedCache.length} values ` +
				`(PyTorch wrote ${shard.cacheShape.reduce((left, right) => left * right, 1)}), ` +
				`absolute sum ${producedCacheSum.toExponential(4)} against ${shard.cache.absoluteSum.toExponential(4)}, ` +
				`first values [${[...producedCache.subarray(0, 3)].map((value) => value.toFixed(5)).join(', ')}] ` +
				`against [${shard.cache.firstValues.slice(0, 3).map((value) => value.toFixed(5)).join(', ')}]`,
		);
		if (
			hiddenDifference >= RELATIVE_TOLERANCE ||
			lastRowDifference >= RELATIVE_TOLERANCE ||
			cacheDifference >= RELATIVE_TOLERANCE
		) {
			everyShardCorrect = false;
		}
		report(
			`    ${shard.name}: isFullyAccelerated=${loaded.model.isFullyAccelerated}, ` +
				`${(loaded.bytes / 1e6).toFixed(1)} MB, ` +
				`run ${formatMilliseconds(readbackStart - runStart)}, ` +
				`hidden readback ${formatMilliseconds(cacheReadbackStart - readbackStart)}, ` +
				`cache readback ${formatMilliseconds(cacheReadbackEnd - cacheReadbackStart)}, ` +
				`hidden ${hiddenDifference.toExponential(3)}, ` +
				`last row ${lastRowDifference.toExponential(3)}, ` +
				`cache ${cacheDifference.toExponential(3)}` +
				(hiddenDifference >= RELATIVE_TOLERANCE ? '  <-- WRONG' : ''),
		);

		hidden = producedHidden;
		for (const output of outputs) {
			output.delete();
		}
		hiddenTensor.delete();
		cosineTensor.delete();
		sineTensor.delete();
		maskTensor.delete();
		loaded.model.delete();
	}

	if (anyShardMissing) {
		report('  this length is incomplete: not every prefill graph has been written yet.');
		return;
	}

	// Only the last position chooses the next token, so the decode head chunks are reused unchanged.
	const lastRow = hidden.slice((prefill.length - 1) * index.hiddenSize);
	const logits = new Float32Array(index.vocabularySize);
	let headMilliseconds = 0;
	for (let chunkIndex = 0; chunkIndex < index.headChunks.length; chunkIndex += 1) {
		const loaded = await loadOne(index.headChunks[chunkIndex]);
		if (loaded === undefined) {
			report('  the head chunks are missing.');
			return;
		}
		const hiddenTensor = new Tensor(lastRow, [1, 1, index.hiddenSize]);
		const start = performance.now();
		const outputs = (await loaded.model.run([hiddenTensor])) as Tensor[];
		const chunkLogits = (await outputs[0].data()) as Float32Array;
		headMilliseconds += performance.now() - start;
		logits.set(chunkLogits, chunkIndex * Math.ceil(index.vocabularySize / index.headChunks.length));
		outputs[0].delete();
		hiddenTensor.delete();
		loaded.model.delete();
	}

	let argmaxToken = 0;
	let argmaxValue = -Infinity;
	for (let token = 0; token < logits.length; token += 1) {
		if (logits[token] > argmaxValue) {
			argmaxValue = logits[token];
			argmaxToken = token;
		}
	}
	let logitsDifference = 0;
	for (let position = 0; position < prefill.logitsFirstValues.length; position += 1) {
		logitsDifference = Math.max(
			logitsDifference,
			relativeDifference(logits[position], prefill.logitsFirstValues[position]),
		);
	}

	const prefillMilliseconds = runMilliseconds + readbackMilliseconds;
	report(
		`  every prefill shard correct: ${everyShardCorrect}, ` +
			`first logits difference ${logitsDifference.toExponential(3)}`,
	);
	report(
		`  token ${argmaxToken}, PyTorch's split model ${prefill.argmaxToken}, ` +
			`unsplit model ${prefill.unsplitArgmaxToken}, ` +
			`match=${argmaxToken === prefill.argmaxToken && argmaxToken === prefill.unsplitArgmaxToken}`,
	);
	report(
		`  seven shards: run ${formatMilliseconds(runMilliseconds)}, ` +
			`hidden state readback ${formatMilliseconds(readbackMilliseconds)}, ` +
			`head chunks ${formatMilliseconds(headMilliseconds)}`,
	);
	report(
		`  reading all seven caches back to check them: ${formatMilliseconds(cacheCheckMilliseconds)} ` +
			`for ${((prefill.shardOutputs.length * 4 * prefill.shardOutputs[0].cacheShape.reduce((left, right) => left * right, 1)) / 1e6).toFixed(0)} megabytes. ` +
			`A real prefill leaves its caches where they are, so this is not counted below.`,
	);
	report(
		`  PREFILL THROUGHPUT: ${prefill.length} tokens in ${formatMilliseconds(prefillMilliseconds)} = ` +
			`${((prefill.length / prefillMilliseconds) * 1000).toFixed(1)} tokens per second ` +
			`(${formatMilliseconds(prefillMilliseconds / prefill.length)} per token)`,
	);
}

/**
 * Measures what it costs to push activations of different sizes across the relay.
 *
 * This is the other question milestone five asks: whether one long activation beats several short ones. It
 * is a question about transfer, so it is measured on the transfer alone, over the same relay milestone four
 * used, with the same frame format.
 *
 * @param index What the prefill export wrote.
 * @returns Nothing.
 */
async function measureActivationTransfer(index: PrefillIndex): Promise<void> {
	report('\n=== sending one long activation against several short ones ===');

	const sender = new WebSocket(`ws://${location.host}/relay?name=prefill_sender`);
	const receiver = new WebSocket(`ws://${location.host}/relay?name=prefill_receiver`);
	sender.binaryType = 'arraybuffer';
	receiver.binaryType = 'arraybuffer';
	await Promise.all([
		new Promise((resolve) => sender.addEventListener('open', resolve)),
		new Promise((resolve) => receiver.addEventListener('open', resolve)),
	]);

	/**
	 * Sends one activation and waits for it to arrive at the other connection.
	 *
	 * @param values The activation.
	 * @returns How long the round trip took.
	 */
	async function sendOne(values: Float32Array): Promise<number> {
		const header = new TextEncoder().encode(
			JSON.stringify({
				to: 'prefill_receiver',
				from: 'prefill_sender',
				type: 'hidden',
			}),
		);
		const frame = new ArrayBuffer(4 + header.byteLength + values.byteLength);
		new DataView(frame).setUint32(0, header.byteLength, true);
		new Uint8Array(frame, 4, header.byteLength).set(header);
		new Uint8Array(frame, 4 + header.byteLength).set(new Uint8Array(values.buffer));
		const arrived = new Promise<void>((resolve) => {
			receiver.addEventListener('message', () => resolve(), {
				once: true,
			});
		});
		const start = performance.now();
		sender.send(frame);
		await arrived;
		return performance.now() - start;
	}

	const longest = index.prefills[index.prefills.length - 1];
	const chunkLength = index.prefills.length > 1 ? index.prefills[index.prefills.length - 2].length : 0;
	if (chunkLength === 0 || longest.length % chunkLength !== 0) {
		report('  needs two lengths where the longer divides by the shorter; skipping.');
		sender.close();
		receiver.close();
		return;
	}
	const chunkCount = longest.length / chunkLength;

	const wholeActivation = new Float32Array(longest.length * index.hiddenSize);
	const chunkActivation = new Float32Array(chunkLength * index.hiddenSize);

	for (let warmup = 0; warmup < 3; warmup += 1) {
		await sendOne(chunkActivation);
	}

	const repeats = 20;
	let wholeMilliseconds = 0;
	for (let repeat = 0; repeat < repeats; repeat += 1) {
		wholeMilliseconds += await sendOne(wholeActivation);
	}
	let chunkedMilliseconds = 0;
	for (let repeat = 0; repeat < repeats; repeat += 1) {
		for (let chunk = 0; chunk < chunkCount; chunk += 1) {
			chunkedMilliseconds += await sendOne(chunkActivation);
		}
	}

	report(
		`  one activation of ${longest.length} tokens (${wholeActivation.byteLength} bytes): ` +
			`${formatMilliseconds(wholeMilliseconds / repeats)} per send, mean of ${repeats}`,
	);
	report(
		`  ${chunkCount} activations of ${chunkLength} tokens (${chunkActivation.byteLength} bytes each): ` +
			`${formatMilliseconds(chunkedMilliseconds / repeats)} for all ${chunkCount}, mean of ${repeats}`,
	);
	const ratio = chunkedMilliseconds / wholeMilliseconds;
	report(
		`  sending it in ${chunkCount} pieces costs ${ratio.toFixed(2)} times what sending it in one does, ` +
			`so ${ratio < 1 ? `${chunkCount} pieces win` : 'one piece wins'}`,
	);
	report(
		'  (this measures transfer only: prefilling in chunks would also need a graph that writes the cache ' +
			'at an offset, which is not built)',
	);

	sender.close();
	receiver.close();
}

/**
 * Runs the whole gate.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	runButton.disabled = true;
	outputElement.textContent = '';
	report(`userAgent: ${navigator.userAgent}`);

	const adapter = await navigator.gpu?.requestAdapter();
	if (adapter !== undefined && adapter !== null) {
		const { vendor, architecture } = adapter.info;
		report(`WebGPU adapter info: vendor=${vendor} architecture=${architecture}`);
	}

	if (isLiteRtLoaded === false) {
		await loadLiteRt('/wasm/litert_wasm_jspi_internal.js');
		isLiteRtLoaded = true;
		report('loadLiteRt: JSPI build');
	}

	const index = (await (await fetch(`${MODELS_PREFIX}/prefill_index.json`)).json()) as PrefillIndex;
	report(`\n${index.model}, cache ${index.cachePositions} positions`);
	report(`prompt lengths exported: ${index.prefills.map((prefill) => prefill.length).join(', ')}`);

	const wanted = searchParameters.get('lengths');
	const lengths =
		wanted === null ? index.prefills : index.prefills.filter((prefill) => wanted.split(',').includes(String(prefill.length)));
	for (const prefill of lengths) {
		await runOneLength(index, prefill);
	}

	if (searchParameters.get('transfer') !== 'off' && index.prefills.length > 1) {
		await measureActivationTransfer(index);
	}

	report('\nDone.');
	runButton.disabled = false;
}

runButton.addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
		runButton.disabled = false;
	});
});

// `?autorun=1` starts the run as soon as the page loads. It exists so that the whole run can be left alone:
// reading the page while it works is itself a disturbance, because touching a hidden tab lifts the slowdown
// Chrome puts on it, and that disturbance moved this project's decode figures by a factor of two and a half.
if (searchParameters.get('autorun') === '1') {
	runButton.click();
}
