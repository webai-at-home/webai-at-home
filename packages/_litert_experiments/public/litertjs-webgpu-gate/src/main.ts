import {
	Tensor,
	getWebGpuDevice,
	isWebGPUSupported,
	loadAndCompile,
	loadLiteRt,
	TensorBufferType,
	type Accelerator,
	type CompiledModel,
	type TensorDetails,
} from '@litertjs/core';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LiteRtJsWebGpuGate — the milestone zero gate of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One trivial shard graph to run, and the reference input and output PyTorch produced for it.
 */
type ReferenceCase = {
	/** The hidden size, which is the width of both the input and the output. */
	hiddenSize: number;
	/** The shape of both the input and the output, as `[1, 1, hiddenSize]`. */
	shape: number[];
	/** The input PyTorch was given. */
	input: number[];
	/** The output PyTorch produced for that input. */
	expectedOutput: number[];
};

/**
 * How many times each measured loop runs.
 */
const RUN_COUNT = 50;

/**
 * The hidden sizes exported by `tools/trivial_shard_export/export_trivial_graph.py`.
 *
 * 1024 is the hidden size of Qwen3-0.6B, so it is the activation one shard boundary of the real target carries
 * during decoding. 4096 is the hidden size the worked example in issue #178 uses. Further sizes can be requested
 * with `?hiddenSizes=8000,12000,16000`, to bracket a file-size failure found elsewhere without touching the default
 * run — see the milestone two comment on issue #179 for why this was needed.
 */
const HIDDEN_SIZES = (new URLSearchParams(location.search).get('hiddenSizes') ?? '1024,4096')
	.split(',')
	.map(Number);

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
 * Describes one input or output tensor of a compiled model.
 *
 * @param details The tensor details reported by LiteRT.js.
 * @returns One line describing that tensor.
 */
function describeTensorDetails(details: TensorDetails): string {
	const bufferTypes = [...details.supportedBufferTypes]
		.map((bufferType) => BUFFER_TYPE_NAMES.get(bufferType) ?? String(bufferType))
		.join(', ');
	return `        name=${details.name} index=${details.index} dtype=${details.dtype} ` +
		`shape=[${[...details.shape].join(', ')}] supportedBufferTypes={${bufferTypes}}`;
}

/**
 * Returns the largest absolute difference between two arrays of the same length.
 *
 * @param actual The values LiteRT.js produced.
 * @param expected The values PyTorch produced.
 * @returns The largest absolute difference.
 */
function largestAbsoluteDifference(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
	let largest = 0;
	for (let index = 0; index < expected.length; index += 1) {
		const difference = Math.abs(actual[index] - expected[index]);
		if (difference > largest) {
			largest = difference;
		}
	}
	return largest;
}

/**
 * Runs one trivial shard graph on one accelerator, and reports every measurement milestone zero asks for.
 *
 * @param referenceCase The graph's hidden size and the reference input and output for it.
 * @param accelerator The accelerator to compile for.
 * @returns Nothing.
 */
async function measureOneGraph(referenceCase: ReferenceCase, accelerator: Accelerator): Promise<void> {
	const modelUrl = `./models/trivial_shard_${referenceCase.hiddenSize}.tflite`;
	report(`\n  accelerator=${accelerator} hiddenSize=${referenceCase.hiddenSize}`);

	const downloadStart = performance.now();
	const modelBytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
	report(`    download: ${formatMilliseconds(performance.now() - downloadStart)} for ${modelBytes.byteLength} bytes`);

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
	report(`    signatures=[${Object.keys(model.signatures).join(', ')}]`);
	report('    inputs:');
	for (const details of model.getInputDetails()) {
		report(describeTensorDetails(details));
	}
	report('    outputs:');
	for (const details of model.getOutputDetails()) {
		report(describeTensorDetails(details));
	}

	const inputTensor = new Tensor(new Float32Array(referenceCase.input), referenceCase.shape);
	report(`    input tensor bufferType=${BUFFER_TYPE_NAMES.get(inputTensor.getBufferType())}`);

	const firstOutputs = await model.run([inputTensor]);
	const firstOutput = firstOutputs[0];
	report(`    output tensor bufferType=${BUFFER_TYPE_NAMES.get(firstOutput.getBufferType())} accelerator=${firstOutput.accelerator}`);
	const firstValues = await firstOutput.data();
	report(
		`    largest absolute difference against PyTorch: ` +
			`${largestAbsoluteDifference(firstValues, referenceCase.expectedOutput).toExponential(3)}`,
	);
	firstOutput.delete();

	// run() and data() are timed apart, because the cost this project cares about is not one number. A shard on one
	// device has to hand its hidden state to a shard on another device, so the read back out of the graphics
	// processor is a cost the distributed design pays and a single-device design does not.
	let runTotal = 0;
	let readbackTotal = 0;
	for (let index = 0; index < RUN_COUNT; index += 1) {
		const runStart = performance.now();
		const outputs = await model.run([inputTensor]);
		const runEnd = performance.now();
		const values = await outputs[0].data();
		const readbackEnd = performance.now();
		runTotal += runEnd - runStart;
		readbackTotal += readbackEnd - runEnd;
		if (values.length !== referenceCase.expectedOutput.length) {
			report(`    UNEXPECTED output length ${values.length}`);
		}
		outputs[0].delete();
	}
	const activationBytes = referenceCase.hiddenSize * Float32Array.BYTES_PER_ELEMENT;
	report(`    over ${RUN_COUNT} runs, mean run(): ${formatMilliseconds(runTotal / RUN_COUNT)}`);
	report(
		`    over ${RUN_COUNT} runs, mean data() readback of ${activationBytes} bytes: ` +
			`${formatMilliseconds(readbackTotal / RUN_COUNT)}`,
	);

	inputTensor.delete();
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
		// The fields are read one by one rather than through JSON.stringify, because GPUAdapterInfo keeps them on its
		// prototype and JSON.stringify therefore reports an empty object for it.
		const { vendor, architecture, device, description } = adapter.info;
		report(
			`WebGPU adapter info: vendor=${vendor} architecture=${architecture} ` +
				`device=${device} description=${description}`,
		);
	}

	const loadStart = performance.now();
	await loadLiteRt('/wasm/');
	report(`loadLiteRt('/wasm/'): ${formatMilliseconds(performance.now() - loadStart)}`);
	report(`getWebGpuDevice(): ${getWebGpuDevice() === null ? 'null' : 'a GPUDevice'}`);

	for (const hiddenSize of HIDDEN_SIZES) {
		const referenceCase = (await (await fetch(`./models/trivial_shard_${hiddenSize}.reference.json`)).json()) as ReferenceCase;
		for (const accelerator of ['webgpu', 'wasm'] as const) {
			await measureOneGraph(referenceCase, accelerator);
		}
	}

	report('\nDone.');
}

(document.querySelector('#run') as HTMLButtonElement).addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
	});
});
