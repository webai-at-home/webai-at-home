import { Tensor, loadAndCompile, loadLiteRt, type Accelerator, type CompiledModel } from '@litertjs/core';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LiteRtJsMultipleOutputDiagnosis — what WebGPU gets wrong, one property at a time
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One diagnosis graph, and the first value PyTorch produced for each of its outputs.
 */
type ReferenceCase = {
	/** The graph's name, which is also its file name. */
	name: string;
	/** The shape of the hidden state. */
	hiddenShape: number[];
	/** The shape of the key/value cache. */
	cacheShape: number[];
	/** How many elements the cache holds. */
	cacheElementCount: number;
	/** The hidden state PyTorch was given. */
	hiddenState: number[];
	/** The first value of each output PyTorch produced. */
	expectedFirstValues: number[];
	/** How many outputs the graph has. */
	outputCount: number;
};

/**
 * How far a produced value may sit from the value PyTorch produced before the answer counts as wrong.
 */
const TOLERANCE = 1e-4;

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
 * Runs one graph on one accelerator and compares every output against PyTorch.
 *
 * @param referenceCase The graph and its reference values.
 * @param accelerator The accelerator to compile for.
 * @returns Nothing.
 */
async function checkOneGraph(referenceCase: ReferenceCase, accelerator: Accelerator): Promise<void> {
	const modelBytes = new Uint8Array(await (await fetch(`./models/${referenceCase.name}.tflite`)).arrayBuffer());

	let model: CompiledModel;
	try {
		model = await loadAndCompile(modelBytes, {
			accelerator,
		});
	} catch (error) {
		report(`  ${referenceCase.name} on ${accelerator}: loadAndCompile FAILED: ${error}`);
		return;
	}

	const hiddenTensor = new Tensor(new Float32Array(referenceCase.hiddenState), referenceCase.hiddenShape);
	const cacheTensor = new Tensor(new Float32Array(referenceCase.cacheElementCount), referenceCase.cacheShape);

	try {
		const outputs = (await model.run([hiddenTensor, cacheTensor])) as Tensor[];
		const produced: number[] = [];
		for (const output of outputs) {
			produced.push((await output.data())[0]);
			output.delete();
		}
		const isCorrect = produced.every(
			(value, index) => Math.abs(value - referenceCase.expectedFirstValues[index]) < TOLERANCE,
		);
		report(
			`  ${referenceCase.name} on ${accelerator}: correct=${isCorrect} ` +
				`isFullyAccelerated=${model.isFullyAccelerated}`,
		);
		report(`      produced=[${produced.map((value) => value.toFixed(8)).join(', ')}]`);
		report(`      expected=[${referenceCase.expectedFirstValues.map((value) => value.toFixed(8)).join(', ')}]`);
	} catch (error) {
		report(`  ${referenceCase.name} on ${accelerator}: run FAILED: ${error}`);
	} finally {
		hiddenTensor.delete();
		cacheTensor.delete();
		model.delete();
	}
}

/**
 * Runs the whole diagnosis.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	outputElement.textContent = '';
	report(`userAgent: ${navigator.userAgent}`);

	const adapter = await navigator.gpu?.requestAdapter();
	if (adapter !== undefined && adapter !== null) {
		const { vendor, architecture } = adapter.info;
		report(`WebGPU adapter info: vendor=${vendor} architecture=${architecture}`);
	}

	const wasmChoice = new URLSearchParams(location.search).get('wasm') ?? 'jspi';
	const wasmPath =
		{
			default: '/wasm/',
			jspi: '/wasm/litert_wasm_jspi_internal.js',
			threaded: '/wasm/litert_wasm_threaded_internal.js',
			compat: '/wasm/litert_wasm_compat_internal.js',
		}[wasmChoice] ?? '/wasm/';
	await loadLiteRt(wasmPath);
	report(`loadLiteRt('${wasmPath}')\n`);

	const { names } = (await (await fetch('./models/index.json')).json()) as { names: string[] };
	for (const name of names) {
		const referenceCase = (await (await fetch(`./models/${name}.reference.json`)).json()) as ReferenceCase;
		for (const accelerator of ['webgpu', 'wasm'] as const) {
			await checkOneGraph(referenceCase, accelerator);
		}
		report('');
	}

	report('Done.');
}

(document.querySelector('#run') as HTMLButtonElement).addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
	});
});
