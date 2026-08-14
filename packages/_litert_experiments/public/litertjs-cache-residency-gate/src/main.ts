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
//	LiteRtJsCacheResidencyGate — the milestone one gate of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The shapes of one exported shard-shaped step, and the reference values PyTorch produced for it.
 */
type ReferenceCase = {
	/** The cache shape written out as dimensions joined by `x`, which is also the model's file name. */
	name: string;
	/** How many dimensions the cache has. */
	cacheRank: number;
	/** Whether the cache increment is `derived` from the hidden state or a `constant`. */
	update: string;
	/** The shape of the hidden state, as `[1, 1, hidden size]`. */
	hiddenShape: number[];
	/** The shape of the key/value cache this shard owns. */
	cacheShape: number[];
	/** How many elements the cache holds. */
	cacheElementCount: number;
	/** How many bytes the cache occupies at 32-bit floating point. */
	cacheBytes: number;
	/** The hidden state PyTorch was given. */
	hiddenState: number[];
	/** The hidden state PyTorch produced. */
	expectedHiddenState: number[];
	/** How much every cache element grows in one step, given that same hidden state. */
	expectedCacheIncrementPerStep: number;
};

/**
 * What one step produced, compared against PyTorch.
 */
type SingleStepCheck = {
	/** Whether both the hidden state and the cache matched PyTorch. */
	isCorrect: boolean;
	/** The buffer type the cache output came back in. */
	cacheBufferType: number;
	/** What went wrong, when something did. */
	failure?: string;
};

/**
 * One measured loop.
 */
type LoopResult = {
	/** How many steps ran. */
	stepCount: number;
	/** Wall-clock milliseconds for the whole loop. */
	totalMilliseconds: number;
	/** Milliseconds spent inside `model.run()`, summed. */
	runMilliseconds: number;
	/** Milliseconds spent reading the hidden state back, summed. */
	hiddenReadbackMilliseconds: number;
	/** Milliseconds spent reading the cache back and uploading it again, summed. */
	cacheRoundTripMilliseconds: number;
	/** The buffer type the cache tensor had on the last step. */
	finalCacheBufferType: number;
	/** Whether the cache still held what PyTorch says it should after the whole loop. */
	isCorrect: boolean;
	/** Wall-clock milliseconds of each block of steps, to show whether the loop drifts. */
	blockMilliseconds: number[];
};

/**
 * The three loops, differing only in what leaves the graphics processor on each step.
 */
const VARIANTS = ['resident-with-hidden-readback', 'resident-without-readback', 'cache-round-trip'] as const;

/**
 * One of the three loops.
 */
type Variant = (typeof VARIANTS)[number];

const searchParameters = new URLSearchParams(location.search);

/**
 * How many decoding steps each loop runs.
 */
const STEP_COUNT = Number(searchParameters.get('steps') ?? '300');

/**
 * How many steps make up one reported block, so that drift over the loop is visible.
 */
const BLOCK_SIZE = Math.max(1, Math.floor(STEP_COUNT / 6));

/**
 * How far a produced value may sit from the value PyTorch produced before the answer counts as wrong.
 *
 * The loop accumulates one addition per step, so the tolerance grows with the number of steps. This is generous:
 * the wrong answers seen on WebGPU are wrong by whole factors, not by rounding.
 */
const TOLERANCE = 1e-4;

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
 * Reads the JavaScript heap size, when the browser reports one.
 *
 * @returns The heap size in bytes, or undefined when the browser does not report it.
 */
function javaScriptHeapBytes(): number | undefined {
	const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
	return memory?.usedJSHeapSize;
}

/**
 * Runs one step and compares both outputs against PyTorch.
 *
 * This runs before any loop does. A loop that reports a fast wrong answer is worse than no loop at all, and on
 * WebGPU that is exactly what some of these cache shapes produce.
 *
 * @param model The compiled shard-shaped step.
 * @param referenceCase The shapes and reference values.
 * @returns Whether the step was correct, and what came back.
 */
async function checkOneStep(model: CompiledModel, referenceCase: ReferenceCase): Promise<SingleStepCheck> {
	const hiddenTensor = new Tensor(new Float32Array(referenceCase.hiddenState), referenceCase.hiddenShape);
	const cacheTensor = new Tensor(new Float32Array(referenceCase.cacheElementCount), referenceCase.cacheShape);
	try {
		const outputs = (await model.run([hiddenTensor, cacheTensor])) as Tensor[];
		const cacheBufferType = outputs[1].getBufferType();
		const producedHidden = await outputs[0].data();
		const producedCache = await outputs[1].data();

		const hiddenDifference = Math.abs(producedHidden[0] - referenceCase.expectedHiddenState[0]);
		const cacheDifference = Math.max(
			Math.abs(producedCache[0] - referenceCase.expectedCacheIncrementPerStep),
			Math.abs(producedCache[producedCache.length - 1] - referenceCase.expectedCacheIncrementPerStep),
		);
		report(
			`      hidden state first=${producedHidden[0].toFixed(8)} ` +
				`expected=${referenceCase.expectedHiddenState[0].toFixed(8)} ` +
				`difference=${hiddenDifference.toExponential(3)}`,
		);
		report(
			`      cache first=${producedCache[0].toFixed(8)} ` +
				`last=${producedCache[producedCache.length - 1].toFixed(8)} ` +
				`expected=${referenceCase.expectedCacheIncrementPerStep.toFixed(8)} ` +
				`difference=${cacheDifference.toExponential(3)}`,
		);

		outputs[0].delete();
		outputs[1].delete();
		return {
			isCorrect: hiddenDifference < TOLERANCE && cacheDifference < TOLERANCE,
			cacheBufferType,
		};
	} catch (error) {
		report(`      one step FAILED: ${error}`);
		return {
			isCorrect: false,
			cacheBufferType: -1,
			failure: String(error),
		};
	} finally {
		hiddenTensor.delete();
		cacheTensor.delete();
	}
}

/**
 * Runs one decoding loop and reports what it cost.
 *
 * @param model The compiled shard-shaped step.
 * @param referenceCase The shapes and reference values.
 * @param variant Which of the three loops to run.
 * @returns What the loop cost.
 */
async function runLoop(model: CompiledModel, referenceCase: ReferenceCase, variant: Variant): Promise<LoopResult> {
	const hiddenTensor = new Tensor(new Float32Array(referenceCase.hiddenState), referenceCase.hiddenShape);
	let cacheTensor = new Tensor(new Float32Array(referenceCase.cacheElementCount), referenceCase.cacheShape);

	let runMilliseconds = 0;
	let hiddenReadbackMilliseconds = 0;
	let cacheRoundTripMilliseconds = 0;
	const blockMilliseconds: number[] = [];

	const loopStart = performance.now();
	let blockStart = loopStart;

	for (let step = 0; step < STEP_COUNT; step += 1) {
		const runStart = performance.now();
		const outputs = (await model.run([hiddenTensor, cacheTensor])) as Tensor[];
		const runEnd = performance.now();
		runMilliseconds += runEnd - runStart;

		const newHiddenTensor = outputs[0];
		const newCacheTensor = outputs[1];

		if (variant !== 'resident-without-readback') {
			const readbackStart = performance.now();
			await newHiddenTensor.data();
			hiddenReadbackMilliseconds += performance.now() - readbackStart;
		}
		newHiddenTensor.delete();

		cacheTensor.delete();
		if (variant === 'cache-round-trip') {
			const roundTripStart = performance.now();
			const cacheValues = await newCacheTensor.data();
			newCacheTensor.delete();
			cacheTensor = new Tensor(cacheValues, referenceCase.cacheShape);
			cacheRoundTripMilliseconds += performance.now() - roundTripStart;
		} else {
			cacheTensor = newCacheTensor;
		}

		if ((step + 1) % BLOCK_SIZE === 0) {
			const blockEnd = performance.now();
			blockMilliseconds.push(blockEnd - blockStart);
			blockStart = blockEnd;
		}
	}

	// The loop is only finished once something has actually waited on the graphics processor. Without this read the
	// wall-clock time would report how fast work was queued rather than how fast it was done.
	const finalCacheValues = await cacheTensor.data();
	const totalMilliseconds = performance.now() - loopStart;
	const finalCacheBufferType = cacheTensor.getBufferType();

	const expectedFinalValue = referenceCase.expectedCacheIncrementPerStep * STEP_COUNT;
	const largestDifference = Math.max(
		Math.abs(finalCacheValues[0] - expectedFinalValue),
		Math.abs(finalCacheValues[finalCacheValues.length - 1] - expectedFinalValue),
	);
	report(
		`      cache after ${STEP_COUNT} steps: first=${finalCacheValues[0].toFixed(6)} ` +
			`last=${finalCacheValues[finalCacheValues.length - 1].toFixed(6)} ` +
			`expected=${expectedFinalValue.toFixed(6)} largest difference=${largestDifference.toExponential(3)}`,
	);

	hiddenTensor.delete();
	cacheTensor.delete();

	return {
		stepCount: STEP_COUNT,
		totalMilliseconds,
		runMilliseconds,
		hiddenReadbackMilliseconds,
		cacheRoundTripMilliseconds,
		finalCacheBufferType,
		isCorrect: largestDifference < TOLERANCE * STEP_COUNT,
		blockMilliseconds,
	};
}

/**
 * Reports one loop's measurements.
 *
 * @param result What the loop cost.
 * @param referenceCase The shapes, for turning the cache round trip into a rate.
 * @returns Nothing.
 */
function reportLoop(result: LoopResult, referenceCase: ReferenceCase): void {
	report(`      correct=${result.isCorrect} final cache bufferType=${bufferTypeName(result.finalCacheBufferType)}`);
	report(`      per step, wall clock: ${formatMilliseconds(result.totalMilliseconds / result.stepCount)}`);
	report(`      per step, run(): ${formatMilliseconds(result.runMilliseconds / result.stepCount)}`);
	report(
		`      per step, hidden state readback: ` +
			`${formatMilliseconds(result.hiddenReadbackMilliseconds / result.stepCount)}`,
	);
	if (result.cacheRoundTripMilliseconds > 0) {
		const perStep = result.cacheRoundTripMilliseconds / result.stepCount;
		const gigabytesPerSecond = referenceCase.cacheBytes / (perStep / 1000) / 1e9;
		report(
			`      per step, cache round trip of ${referenceCase.cacheBytes} bytes: ` +
				`${formatMilliseconds(perStep)} (${gigabytesPerSecond.toFixed(2)} gigabytes per second)`,
		);
	}
	report(
		`      wall clock of each block of ${BLOCK_SIZE} steps: ` +
			`${result.blockMilliseconds.map((milliseconds) => milliseconds.toFixed(0)).join(', ')} ms`,
	);
}

/**
 * Runs every loop for one cache shape on one accelerator, after checking that one step is correct.
 *
 * @param referenceCase The shapes and reference values.
 * @param accelerator The accelerator to compile for.
 * @returns Nothing.
 */
async function measureOneCacheShape(referenceCase: ReferenceCase, accelerator: Accelerator): Promise<void> {
	report(
		`\n  cache [${referenceCase.cacheShape.join(', ')}] rank=${referenceCase.cacheRank} ` +
			`${referenceCase.cacheBytes} bytes, update=${referenceCase.update}, accelerator=${accelerator}`,
	);

	const modelBytes = new Uint8Array(
		await (await fetch(`./models/shard_like_step_${referenceCase.name}.tflite`)).arrayBuffer(),
	);

	let model: CompiledModel;
	const compileStart = performance.now();
	try {
		model = await loadAndCompile(modelBytes, {
			accelerator,
		});
	} catch (error) {
		report(`    loadAndCompile FAILED: ${error}`);
		return;
	}
	report(`    loadAndCompile: ${formatMilliseconds(performance.now() - compileStart)}`);
	report(`    isFullyAccelerated=${model.isFullyAccelerated}`);
	for (const details of [...model.getInputDetails(), ...model.getOutputDetails()]) {
		const bufferTypes = [...details.supportedBufferTypes].map(bufferTypeName).join(', ');
		report(`    ${details.name}: shape=[${[...details.shape].join(', ')}] supportedBufferTypes={${bufferTypes}}`);
	}

	report('    one step against PyTorch:');
	const check = await checkOneStep(model, referenceCase);
	report(`      correct=${check.isCorrect} cache output bufferType=${bufferTypeName(check.cacheBufferType)}`);

	if (check.isCorrect === false) {
		report('    loops skipped: one step is already wrong, so no timing from this combination means anything.');
		model.delete();
		return;
	}

	for (const variant of VARIANTS) {
		report(`\n    ${variant}, ${STEP_COUNT} steps`);
		const heapBefore = javaScriptHeapBytes();
		try {
			const result = await runLoop(model, referenceCase, variant);
			reportLoop(result, referenceCase);
		} catch (error) {
			report(`      FAILED: ${error}`);
			continue;
		}
		const heapAfter = javaScriptHeapBytes();
		if (heapBefore !== undefined && heapAfter !== undefined) {
			report(`      JavaScript heap: ${heapBefore} -> ${heapAfter} bytes (${heapAfter - heapBefore} difference)`);
		} else {
			report('      JavaScript heap: not reported by this browser');
		}
	}

	model.delete();
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
	if (adapter === undefined || adapter === null) {
		report('WebGPU adapter info: none');
	} else {
		const { vendor, architecture, device, description } = adapter.info;
		report(
			`WebGPU adapter info: vendor=${vendor} architecture=${architecture} ` +
				`device=${device} description=${description}`,
		);
		report(`WebGPU maxBufferSize: ${adapter.limits.maxBufferSize} bytes`);
		report(`WebGPU maxStorageBufferBindingSize: ${adapter.limits.maxStorageBufferBindingSize} bytes`);
	}

	// Which WebAssembly build is loaded is a question of its own here, not a detail. The build LiteRT.js picks on its
	// own cannot read a WebGPU tensor back in this page: it raises "Asyncify is not defined". The build is therefore
	// selectable from the address bar, as ?wasm=default, ?wasm=jspi, ?wasm=threaded, or ?wasm=compat.
	const wasmChoice = searchParameters.get('wasm') ?? 'jspi';
	const wasmPath =
		{
			default: '/wasm/',
			jspi: '/wasm/litert_wasm_jspi_internal.js',
			threaded: '/wasm/litert_wasm_threaded_internal.js',
			compat: '/wasm/litert_wasm_compat_internal.js',
		}[wasmChoice] ?? '/wasm/';
	const loadStart = performance.now();
	await loadLiteRt(wasmPath);
	report(`loadLiteRt('${wasmPath}'): ${formatMilliseconds(performance.now() - loadStart)}`);
	report(`steps per loop: ${STEP_COUNT}`);

	const { names } = (await (await fetch('./models/index.json')).json()) as { names: string[] };
	for (const name of names) {
		const referenceCase = (await (await fetch(`./models/shard_like_step_${name}.reference.json`)).json()) as ReferenceCase;
		for (const accelerator of ['webgpu', 'wasm'] as const) {
			await measureOneCacheShape(referenceCase, accelerator);
		}
	}

	report('\nDone.');
}

(document.querySelector('#run') as HTMLButtonElement).addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
	});
});
