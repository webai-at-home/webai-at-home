import * as OnnxRuntimeWeb from 'onnxruntime-web';
import { GRAPH_TENSOR_NAMES, OnnxGraphBuilder, type MatMulNBitsGraph } from './onnx_graph_builder';
import { QuantizedWeights, type QuantizedMatrix } from './quantized_weights';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — runs the milestone zero de-risking gate of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Answers the single question that milestone zero of https://github.com/webai-at-home/webai-at-home/issues/169 rests
 * on, in a real Chrome, with no model and no disk layer:
 *
 * > Can ONNX Runtime Web execute a 4-bit quantized matrix multiplication, meaning the `MatMulNBits` operator, where
 * > the quantized weight tensor is a runtime input backed by a WebGPU buffer this project owns, and can the contents
 * > of that buffer be overwritten between calls without recreating the session?
 *
 * If the answer is yes, the whole design of https://github.com/webai-at-home/webai-at-home/issues/168 sits on the
 * runtime this project already ships. If the answer is no, the expert path has to be written as WebGPU Shading
 * Language kernels instead, and the rest of the model stays in ONNX Runtime Web.
 */

/** The activation length used by the small phases, kept small enough that a wrong answer can be read by eye. */
const SMALL_HIDDEN_SIZE = 64;
/** The output length used by the small phases. */
const SMALL_OUTPUT_SIZE = 8;
/** The activation length of a real Qwen3-30B-A3B expert projection, used by the timing phase. */
const EXPERT_HIDDEN_SIZE = 2048;
/** The output length of a real Qwen3-30B-A3B expert gate or up projection, used by the timing phase. */
const EXPERT_OUTPUT_SIZE = 768;
/** The number of weight values sharing one scale factor. `MatMulNBits` requires a multiple of 16. */
const BLOCK_SIZE = 32;
/** How many distinct simulated experts the timing phase writes through the same buffer. */
const TIMED_EXPERT_COUNT = 16;
/**
 * The largest relative difference accepted between ONNX Runtime Web's answer and the independently recomputed one.
 * The two do not agree exactly, because the runtime accumulates in a different order and may accumulate at reduced
 * precision, so an exact comparison would fail on a correct result.
 */
const ACCEPTED_RELATIVE_DIFFERENCE = 0.02;

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
OnnxRuntimeWeb.env.logLevel = 'fatal';

/** What one phase reports back to the runner. */
type PhaseOutcome = {
	/** Whether the phase answered its question the way the design needs. */
	passed: boolean;
	/** The one-line result written into the page's summary table. */
	summary: string;
};

/** The WebGPU device this gate owns, together with the limits the adapter granted. */
type OwnedDevice = {
	/** The device, which is also handed to ONNX Runtime Web so both sides allocate from the same one. */
	device: GPUDevice;
	/** The largest single buffer the device will allocate, in bytes. */
	maxBufferSize: number;
	/** The largest storage buffer binding the device will accept, in bytes. */
	maxStorageBufferBindingSize: number;
	/** The adapter description, as reported by the device. */
	adapterDescription: string;
	/**
	 * Whether the device is one this page created and ONNX Runtime Web accepted, or one ONNX Runtime Web created for
	 * itself. Buffers must be allocated on whichever device the runtime actually executes on.
	 */
	origin: 'created by this page' | 'created by ONNX Runtime Web';
};

/** Runs the six phases of the gate and prints every raw number they produce. */
class Main {
	/** The element every phase writes its output into. */
	static outputElement: HTMLPreElement | undefined;
	/** The device this gate allocates its buffers on, once phase one has created it. */
	static ownedDevice: OwnedDevice | undefined;
	/** The stored value that stands for zero, once phase three has measured which one the runtime uses. */
	static measuredZeroPoint = 8;

	/**
	 * Builds the page and connects the run button.
	 *
	 * @returns A promise that resolves once the page is ready to run the gate.
	 */
	static async main(): Promise<void> {
		Main.outputElement = document.querySelector<HTMLPreElement>('#output') ?? undefined;
		const runButton = document.querySelector<HTMLButtonElement>('#run-button');
		if (runButton === null) {
			return;
		}
		runButton.disabled = false;
		runButton.textContent = 'Run the gate';
		runButton.addEventListener('click', async () => {
			runButton.disabled = true;
			runButton.textContent = 'Running…';
			await Main.runGate();
			runButton.disabled = false;
			runButton.textContent = 'Run the gate again';
		});
	}

	/**
	 * Runs every phase in order, stopping at the first phase whose failure makes the later ones meaningless.
	 *
	 * @returns A promise that resolves once every phase that could run has run.
	 */
	static async runGate(): Promise<void> {
		if (Main.outputElement !== undefined) {
			Main.outputElement.textContent = '';
		}

		const outcomes: { title: string; outcome: PhaseOutcome }[] = [];
		const phases: { title: string; run: () => Promise<PhaseOutcome> }[] = [
			{
				title: '1 · a WebGPU device this project owns, shared with ONNX Runtime Web',
				run: Main.phaseOwnDevice,
			},
			{
				title: '2 · a MatMulNBits graph whose weights are inputs, not initializers, loads at all',
				run: Main.phaseGraphLoads,
			},
			{
				title: '3 · it computes the right answer from weights supplied on the processor side',
				run: Main.phaseProcessorSideWeights,
			},
			{
				title: '4 · it computes the right answer from weights in a WebGPU buffer this project owns',
				run: Main.phaseOwnedBufferWeights,
			},
			{
				title: '5 · overwriting that buffer changes the answer, with no new session',
				run: Main.phaseOverwriteBuffer,
			},
			{
				title: '6 · the same, at real Qwen3-30B-A3B expert size, with timings',
				run: Main.phaseExpertSizedTimings,
			},
		];

		for (const phase of phases) {
			Main._write(`\n── phase ${phase.title}`, 'phase');
			let outcome: PhaseOutcome;
			try {
				outcome = await phase.run();
			} catch (error) {
				outcome = {
					passed: false,
					summary: `threw — ${error instanceof Error ? error.message : String(error)}`,
				};
				Main._write(`  threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, 'fail');
			}
			outcomes.push({
				title: phase.title,
				outcome: outcome,
			});
			Main._write(`  ${outcome.passed ? 'PASS' : 'FAIL'} — ${outcome.summary}`, outcome.passed ? 'pass' : 'fail');
			if (outcome.passed === false) {
				Main._write('\n  Later phases depend on this one, so the run stops here.', 'fail');
				break;
			}
		}

		const allPassed = outcomes.length === phases.length && outcomes.every((entry) => entry.outcome.passed);
		Main._write('\n══ verdict', 'phase');
		if (allPassed) {
			Main._write(
				'  GATE GREEN — ONNX Runtime Web runs MatMulNBits against a WebGPU buffer this project owns, and\n' +
					'  rereads that buffer after it is overwritten. Issue #169 continues on ONNX Runtime Web, and the\n' +
					'  residency layer of milestone four can hand it expert weights it swaps itself.',
				'pass',
			);
		} else {
			Main._write(
				'  GATE RED — the expert path cannot be expressed this way. The fallback stated in milestone zero\n' +
					'  applies: write WebGPU Shading Language kernels for the expert projection only, and leave the rest\n' +
					'  of the model in ONNX Runtime Web.',
				'fail',
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Phase one. Establishes which WebGPU device this gate must allocate its buffers on.
	 *
	 * A buffer can only be bound by the device that created it. So the first thing this gate has to settle is whether
	 * ONNX Runtime Web will adopt a device this page creates, or whether it insists on creating its own — because in
	 * the second case every buffer has to be allocated on the runtime's device instead, and handing the runtime a
	 * buffer from anywhere else fails validation rather than returning a wrong answer.
	 *
	 * The order matters. `env.webgpu.device` is assigned before any session exists, because the runtime reads it while
	 * initializing its WebGPU backend, and that initialization happens on the first session creation. The probe session
	 * below exists only to trigger it, so the assignment can then be read back and checked.
	 *
	 * The reported limits are also the answer milestone two of issue #169 wants for this machine.
	 *
	 * @returns Whether a device usable for both allocation and execution was established.
	 */
	static async phaseOwnDevice(): Promise<PhaseOutcome> {
		if (navigator.gpu === undefined) {
			return {
				passed: false,
				summary: 'this browser exposes no WebGPU at all',
			};
		}
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (adapter === null) {
			return {
				passed: false,
				summary: 'no WebGPU adapter was granted',
			};
		}

		let offeredDevice: GPUDevice | undefined;
		try {
			offeredDevice = await adapter.requestDevice({
				requiredLimits: {
					maxBufferSize: adapter.limits.maxBufferSize,
					maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
				},
			});
			OnnxRuntimeWeb.env.webgpu.device = offeredDevice;
			Main._write('  a device was offered to ONNX Runtime Web before any session existed');
		} catch (error) {
			Main._write(
				`  no device could be offered: ${error instanceof Error ? error.message : String(error)}\n` +
					'  This is what a second run on the same page sees. Once the runtime has initialized its WebGPU\n' +
					'  backend, env.webgpu.device stops accepting a value and only gives one back.',
			);
		}

		const probeGraph = OnnxGraphBuilder.buildMatMulNBitsGraph(SMALL_HIDDEN_SIZE, SMALL_OUTPUT_SIZE, BLOCK_SIZE);
		const probeSession = await Main._createSession(probeGraph);
		await probeSession.release();

		const runtimeDevice: GPUDevice | undefined = await OnnxRuntimeWeb.env.webgpu.device;
		if (runtimeDevice === undefined) {
			return {
				passed: false,
				summary: 'ONNX Runtime Web exposed no WebGPU device after creating a session, so no buffer can be shared',
			};
		}

		const offerAccepted = runtimeDevice === offeredDevice;
		if (offerAccepted === false) {
			Main._write(
				'  ONNX Runtime Web is not running on the offered device. It uses one of its own.\n' +
					"  Every buffer below is therefore allocated on the runtime's device, read back out of\n" +
					'  env.webgpu.device after the first session exists. This is a real constraint for milestone four:\n' +
					'  the residency layer does not own the device, it borrows it.',
				'phase',
			);
			if (offeredDevice !== undefined) {
				offeredDevice.destroy();
			}
		}

		const device = runtimeDevice;
		const adapterInfo = device.adapterInfo;
		const adapterDescription = `${adapterInfo.vendor || 'unknown vendor'} · ${adapterInfo.architecture || 'unknown architecture'} · ${adapterInfo.description || 'no description'}`;

		Main.ownedDevice = {
			device: device,
			maxBufferSize: device.limits.maxBufferSize,
			maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
			adapterDescription: adapterDescription,
			origin: offerAccepted ? 'created by this page' : 'created by ONNX Runtime Web',
		};

		Main._write(`  adapter: ${adapterDescription}`);
		Main._write(`  device in use: ${Main.ownedDevice.origin}`);
		Main._write(`  largest single buffer granted: ${Main._megabytes(device.limits.maxBufferSize)}`);
		Main._write(`  largest storage binding granted: ${Main._megabytes(device.limits.maxStorageBufferBindingSize)}`);
		Main._write(
			`  one Qwen3-30B-A3B expert projection needs ${Main._megabytes(
				(EXPERT_OUTPUT_SIZE * Math.ceil(EXPERT_HIDDEN_SIZE / BLOCK_SIZE) * BLOCK_SIZE) / 2,
			)} of quantized weights`,
		);

		return {
			passed: true,
			summary:
				`device shared with ONNX Runtime Web (${Main.ownedDevice.origin}), ` +
				`storage binding limit ${Main._megabytes(device.limits.maxStorageBufferBindingSize)}`,
		};
	}

	/**
	 * Phase two. The cheapest possible kill. Builds the one-node graph whose weight tensors are declared as graph
	 * inputs and asks ONNX Runtime Web to create a session from it on the WebGPU execution provider.
	 *
	 * Every published export declares those tensors as initializers. If the runtime refuses to place `MatMulNBits` on
	 * WebGPU when its weights are not constant, it refuses here, and nothing below can work.
	 *
	 * @returns Whether the session was created.
	 */
	static async phaseGraphLoads(): Promise<PhaseOutcome> {
		const graph = OnnxGraphBuilder.buildMatMulNBitsGraph(SMALL_HIDDEN_SIZE, SMALL_OUTPUT_SIZE, BLOCK_SIZE);
		Main._write(`  built a ${graph.modelBytes.length}-byte ONNX model, with no build step and no committed file`);
		Main._write(
			`  K=${graph.hiddenSize} N=${graph.outputSize} bits=4 block_size=${graph.blockSize} → ` +
				`weights [${graph.outputSize}, ${graph.blocksPerRow}, ${graph.blobSize}] = ${graph.quantizedByteLength} bytes, ` +
				`${graph.scaleCount} scales`,
		);

		const session = await Main._createSession(graph);
		Main._write(`  session inputs: ${session.inputNames.join(', ')}`);
		Main._write(`  session outputs: ${session.outputNames.join(', ')}`);
		await session.release();

		const weightsAreInputs = session.inputNames.includes(GRAPH_TENSOR_NAMES.expertWeightQuantized);
		return {
			passed: weightsAreInputs,
			summary: weightsAreInputs
				? 'the session accepts the quantized weights as a runtime input'
				: 'the session did not expose the quantized weights as an input',
		};
	}

	/**
	 * Phase three. Runs the graph with the weights supplied as an ordinary processor-side tensor and compares the
	 * result against a product recomputed in plain TypeScript.
	 *
	 * This phase also settles a detail that could not be settled by reading: `MatMulNBits` at 4 bits with no zero point
	 * tensor supplied has a default zero point, and this measures whether that default is 8 or 0 rather than assuming
	 * it. Everything below reuses the measured value.
	 *
	 * @returns Whether the runtime's answer matched a recomputed one, at either candidate zero point.
	 */
	static async phaseProcessorSideWeights(): Promise<PhaseOutcome> {
		const graph = OnnxGraphBuilder.buildMatMulNBitsGraph(SMALL_HIDDEN_SIZE, SMALL_OUTPUT_SIZE, BLOCK_SIZE);
		const session = await Main._createSession(graph);
		const hiddenState = QuantizedWeights.makeValues(1, SMALL_HIDDEN_SIZE);
		const matrix = Main._makeExpert(0, graph, 8);

		const outputs = await session.run({
			[GRAPH_TENSOR_NAMES.hiddenState]: new OnnxRuntimeWeb.Tensor('float32', hiddenState, [1, graph.hiddenSize]),
			[GRAPH_TENSOR_NAMES.expertWeightQuantized]: new OnnxRuntimeWeb.Tensor('uint8', matrix.quantized, [
				graph.outputSize,
				graph.blocksPerRow,
				graph.blobSize,
			]),
			[GRAPH_TENSOR_NAMES.expertWeightScales]: new OnnxRuntimeWeb.Tensor('float32', matrix.scales, [graph.scaleCount]),
		});
		const measured = outputs[GRAPH_TENSOR_NAMES.projected].data as Float32Array;
		await session.release();

		const referenceAtEight = QuantizedWeights.referenceProduct(hiddenState, matrix, 8);
		const referenceAtZero = QuantizedWeights.referenceProduct(hiddenState, matrix, 0);
		const differenceAtEight = QuantizedWeights.largestDifference(measured, referenceAtEight);
		const differenceAtZero = QuantizedWeights.largestDifference(measured, referenceAtZero);

		Main._write(`  runtime answer:      ${Main._vector(measured)}`);
		Main._write(`  recomputed, zero point 8: ${Main._vector(referenceAtEight)}`);
		Main._write(`  recomputed, zero point 0: ${Main._vector(referenceAtZero)}`);
		Main._write(
			`  largest difference against zero point 8: ${differenceAtEight.toExponential(3)}, ` +
				`against zero point 0: ${differenceAtZero.toExponential(3)}`,
		);

		const tolerance = QuantizedWeights.largestMagnitude(referenceAtEight) * ACCEPTED_RELATIVE_DIFFERENCE;
		if (differenceAtEight <= tolerance) {
			Main.measuredZeroPoint = 8;
			Main._write('  the default zero point of MatMulNBits at 4 bits is 8, as assumed');
			return {
				passed: true,
				summary: `matched the recomputed product to ${differenceAtEight.toExponential(2)}, default zero point 8`,
			};
		}
		if (differenceAtZero <= QuantizedWeights.largestMagnitude(referenceAtZero) * ACCEPTED_RELATIVE_DIFFERENCE) {
			Main.measuredZeroPoint = 0;
			Main._write('  the default zero point is 0, not 8 — every later phase now uses 0', 'phase');
			return {
				passed: true,
				summary: `matched the recomputed product to ${differenceAtZero.toExponential(2)}, default zero point 0`,
			};
		}
		return {
			passed: false,
			summary:
				'the runtime answer matched neither recomputed product, so this gate has the block layout wrong ' +
				'and no conclusion below it would mean anything',
		};
	}

	/**
	 * Phase four. The same computation as phase three, but with both weight tensors held in WebGPU buffers that this
	 * project allocated, and handed to the runtime through `Tensor.fromGpuBuffer`.
	 *
	 * @returns Whether the runtime read the owned buffers and produced the recomputed answer.
	 */
	static async phaseOwnedBufferWeights(): Promise<PhaseOutcome> {
		const graph = OnnxGraphBuilder.buildMatMulNBitsGraph(SMALL_HIDDEN_SIZE, SMALL_OUTPUT_SIZE, BLOCK_SIZE);
		const session = await Main._createSession(graph);
		const buffers = Main._allocateExpertBuffers(graph);
		const hiddenState = QuantizedWeights.makeValues(1, SMALL_HIDDEN_SIZE);
		const matrix = Main._makeExpert(0, graph, Main.measuredZeroPoint);

		Main._uploadExpert(buffers, matrix);
		const measured = await Main._runWithOwnedBuffers(session, graph, buffers, hiddenState);
		await session.release();
		Main._releaseExpertBuffers(buffers);

		const reference = QuantizedWeights.referenceProduct(hiddenState, matrix, Main.measuredZeroPoint);
		const difference = QuantizedWeights.largestDifference(measured, reference);
		const tolerance = QuantizedWeights.largestMagnitude(reference) * ACCEPTED_RELATIVE_DIFFERENCE;

		Main._write(`  runtime answer: ${Main._vector(measured)}`);
		Main._write(`  recomputed:     ${Main._vector(reference)}`);
		Main._write(`  largest difference: ${difference.toExponential(3)}, accepted up to ${tolerance.toExponential(3)}`);

		return {
			passed: difference <= tolerance,
			summary:
				difference <= tolerance
					? 'the runtime read the weights out of the buffers this project allocated'
					: 'the runtime did not produce the recomputed answer from the owned buffers',
		};
	}

	/**
	 * Phase five. The gate itself.
	 *
	 * Runs one expert through the owned buffers, then overwrites those same buffers with a different expert's weights
	 * and runs again on the **same session**, with no new session, no new buffer, and no new tensor allocation. Both
	 * answers are checked against their own recomputed product.
	 *
	 * A runtime that quietly kept a prepacked copy of the first expert would pass every phase above and fail here, by
	 * returning the first answer twice. That is exactly the failure this milestone exists to rule out.
	 *
	 * @returns Whether the second run followed the overwritten buffer.
	 */
	static async phaseOverwriteBuffer(): Promise<PhaseOutcome> {
		const graph = OnnxGraphBuilder.buildMatMulNBitsGraph(SMALL_HIDDEN_SIZE, SMALL_OUTPUT_SIZE, BLOCK_SIZE);
		const session = await Main._createSession(graph);
		const buffers = Main._allocateExpertBuffers(graph);
		const hiddenState = QuantizedWeights.makeValues(1, SMALL_HIDDEN_SIZE);

		const firstExpert = Main._makeExpert(0, graph, Main.measuredZeroPoint);
		Main._uploadExpert(buffers, firstExpert);
		const firstMeasured = await Main._runWithOwnedBuffers(session, graph, buffers, hiddenState);

		const secondExpert = Main._makeExpert(1, graph, Main.measuredZeroPoint);
		Main._uploadExpert(buffers, secondExpert);
		const secondMeasured = await Main._runWithOwnedBuffers(session, graph, buffers, hiddenState);

		await session.release();
		Main._releaseExpertBuffers(buffers);

		const firstReference = QuantizedWeights.referenceProduct(hiddenState, firstExpert, Main.measuredZeroPoint);
		const secondReference = QuantizedWeights.referenceProduct(hiddenState, secondExpert, Main.measuredZeroPoint);
		const firstDifference = QuantizedWeights.largestDifference(firstMeasured, firstReference);
		const secondDifference = QuantizedWeights.largestDifference(secondMeasured, secondReference);
		const staleDifference = QuantizedWeights.largestDifference(secondMeasured, firstMeasured);
		const tolerance = QuantizedWeights.largestMagnitude(secondReference) * ACCEPTED_RELATIVE_DIFFERENCE;

		Main._write(`  expert 0, runtime:  ${Main._vector(firstMeasured)}`);
		Main._write(`  expert 0, recomputed: ${Main._vector(firstReference)}`);
		Main._write(`  expert 1, runtime:  ${Main._vector(secondMeasured)}`);
		Main._write(`  expert 1, recomputed: ${Main._vector(secondReference)}`);
		Main._write(
			`  expert 0 difference ${firstDifference.toExponential(3)}, ` +
				`expert 1 difference ${secondDifference.toExponential(3)}, accepted up to ${tolerance.toExponential(3)}`,
		);
		Main._write(`  the two runtime answers differ by ${staleDifference.toExponential(3)} — a stale result would be 0`);

		const followedTheOverwrite = firstDifference <= tolerance && secondDifference <= tolerance && staleDifference > 0;
		return {
			passed: followedTheOverwrite,
			summary: followedTheOverwrite
				? 'the same session followed the overwritten buffer, with no session or buffer recreated'
				: 'the second run did not follow the overwritten buffer',
		};
	}

	/**
	 * Phase six. Repeats the gate at the real dimensions of a Qwen3-30B-A3B expert projection, and reports how long
	 * one expert swap and one projection take.
	 *
	 * These are the first real numbers for the residency layer of milestone four. The reported time covers writing both
	 * weight tensors into the owned buffers, running the projection, and reading the result back, because that whole
	 * span is what one expert costs in the token loop.
	 *
	 * @returns Whether every swapped expert produced its own recomputed answer at real size.
	 */
	static async phaseExpertSizedTimings(): Promise<PhaseOutcome> {
		const graph = OnnxGraphBuilder.buildMatMulNBitsGraph(EXPERT_HIDDEN_SIZE, EXPERT_OUTPUT_SIZE, BLOCK_SIZE);
		const uploadedBytes = graph.quantizedByteLength + graph.scaleCount * 4;
		Main._write(
			`  one expert projection: ${graph.outputSize} by ${graph.hiddenSize}, ` +
				`${Main._megabytes(graph.quantizedByteLength)} of weights plus ` +
				`${Main._megabytes(graph.scaleCount * 4)} of scales = ${Main._megabytes(uploadedBytes)} per swap`,
		);

		const session = await Main._createSession(graph);
		const buffers = Main._allocateExpertBuffers(graph);
		const hiddenState = QuantizedWeights.makeValues(1, EXPERT_HIDDEN_SIZE);

		let failedExpert = -1;
		const durations: number[] = [];
		for (let expertIndex = 0; expertIndex < TIMED_EXPERT_COUNT; expertIndex++) {
			const matrix = Main._makeExpert(expertIndex, graph, Main.measuredZeroPoint);
			const startedAt = performance.now();
			Main._uploadExpert(buffers, matrix);
			const measured = await Main._runWithOwnedBuffers(session, graph, buffers, hiddenState);
			durations.push(performance.now() - startedAt);

			if (expertIndex < 2 || expertIndex === TIMED_EXPERT_COUNT - 1) {
				const reference = QuantizedWeights.referenceProduct(hiddenState, matrix, Main.measuredZeroPoint);
				const difference = QuantizedWeights.largestDifference(measured, reference);
				const tolerance = QuantizedWeights.largestMagnitude(reference) * ACCEPTED_RELATIVE_DIFFERENCE;
				Main._write(
					`  expert ${expertIndex}: difference ${difference.toExponential(3)} against a recomputed product, ` +
						`accepted up to ${tolerance.toExponential(3)}`,
				);
				if (difference > tolerance && failedExpert === -1) {
					failedExpert = expertIndex;
				}
			}
		}

		await session.release();
		Main._releaseExpertBuffers(buffers);

		const warmDurations = durations.slice(1);
		const fastest = Math.min(...warmDurations);
		const slowest = Math.max(...warmDurations);
		const average = warmDurations.reduce((total, duration) => total + duration, 0) / warmDurations.length;

		Main._write(`  first swap, including shader compilation: ${durations[0].toFixed(2)} milliseconds`);
		Main._write(
			`  ${warmDurations.length} warm swaps: fastest ${fastest.toFixed(2)}, average ${average.toFixed(2)}, ` +
				`slowest ${slowest.toFixed(2)} milliseconds`,
		);
		Main._write(
			`  that is ${(uploadedBytes / 1024 / 1024 / (average / 1000)).toFixed(0)} megabytes per second through the ` +
				'upload and projection together',
		);
		Main._write(
			`  a Qwen3-30B-A3B token selects 8 experts across 48 layers, each with 3 such projections, so at this rate ` +
				`an entirely uncached token costs ${((average * 8 * 48 * 3) / 1000).toFixed(1)} seconds`,
		);

		return {
			passed: failedExpert === -1,
			summary:
				failedExpert === -1
					? `${TIMED_EXPERT_COUNT} experts swapped through one buffer, ${average.toFixed(2)} milliseconds each`
					: `expert ${failedExpert} did not match its recomputed product at real size`,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Creates one inference session on the WebGPU execution provider from an already-built graph.
	 *
	 * @param graph - The graph to create the session from.
	 * @returns The created session.
	 */
	static async _createSession(graph: MatMulNBitsGraph): Promise<OnnxRuntimeWeb.InferenceSession> {
		return await OnnxRuntimeWeb.InferenceSession.create(graph.modelBytes, {
			executionProviders: ['webgpu'],
		});
	}

	/**
	 * Builds and quantizes one simulated expert's weight matrix.
	 *
	 * @param expertIndex - Which simulated expert to build. Distinct values give distinct weights.
	 * @param graph - The graph whose dimensions the matrix must match.
	 * @param zeroPoint - The stored value that stands for zero.
	 * @returns The quantized matrix.
	 */
	static _makeExpert(expertIndex: number, graph: MatMulNBitsGraph, zeroPoint: number): QuantizedMatrix {
		const weights = QuantizedWeights.makeValues(expertIndex + 101, graph.outputSize * graph.hiddenSize);
		return QuantizedWeights.quantize(weights, graph.outputSize, graph.hiddenSize, graph.blockSize, zeroPoint);
	}

	/**
	 * Allocates the two WebGPU buffers that hold one resident expert.
	 *
	 * `Tensor.fromGpuBuffer` binds a whole buffer rather than a range inside one, so the quantized weights and the
	 * scales need one buffer each even though they will arrive from disk as a single contiguous block.
	 *
	 * @param graph - The graph whose dimensions the buffers must match.
	 * @returns The two buffers.
	 */
	static _allocateExpertBuffers(graph: MatMulNBitsGraph): { quantized: GPUBuffer; scales: GPUBuffer } {
		const device = Main._requireDevice();
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
		return {
			quantized: device.createBuffer({
				size: Math.ceil(graph.quantizedByteLength / 16) * 16,
				usage: usage,
				label: 'resident expert weights',
			}),
			scales: device.createBuffer({
				size: Math.ceil((graph.scaleCount * 4) / 16) * 16,
				usage: usage,
				label: 'resident expert scales',
			}),
		};
	}

	/**
	 * Overwrites the resident buffers with one expert's weights. This is the operation the residency layer of milestone
	 * four performs for every expert miss.
	 *
	 * @param buffers - The buffers to overwrite.
	 * @param matrix - The expert whose weights to write.
	 * @returns Nothing.
	 */
	static _uploadExpert(buffers: { quantized: GPUBuffer; scales: GPUBuffer }, matrix: QuantizedMatrix): void {
		const device = Main._requireDevice();
		device.queue.writeBuffer(buffers.quantized, 0, matrix.quantized);
		device.queue.writeBuffer(buffers.scales, 0, matrix.scales);
	}

	/**
	 * Destroys the resident buffers.
	 *
	 * @param buffers - The buffers to destroy.
	 * @returns Nothing.
	 */
	static _releaseExpertBuffers(buffers: { quantized: GPUBuffer; scales: GPUBuffer }): void {
		buffers.quantized.destroy();
		buffers.scales.destroy();
	}

	/**
	 * Runs one projection with both weight tensors read straight out of the owned buffers.
	 *
	 * @param session - The session to run.
	 * @param graph - The graph the session was created from.
	 * @param buffers - The owned buffers holding the resident expert.
	 * @param hiddenState - The activation vector entering the projection.
	 * @returns The projected activation vector, read back to the processor side.
	 */
	static async _runWithOwnedBuffers(
		session: OnnxRuntimeWeb.InferenceSession,
		graph: MatMulNBitsGraph,
		buffers: { quantized: GPUBuffer; scales: GPUBuffer },
		hiddenState: Float32Array,
	): Promise<Float32Array> {
		const quantizedTensor = OnnxRuntimeWeb.Tensor.fromGpuBuffer(buffers.quantized, {
			dataType: 'uint8',
			dims: [graph.outputSize, graph.blocksPerRow, graph.blobSize],
		});
		const scalesTensor = OnnxRuntimeWeb.Tensor.fromGpuBuffer(buffers.scales, {
			dataType: 'float32',
			dims: [graph.scaleCount],
		});

		const outputs = await session.run({
			[GRAPH_TENSOR_NAMES.hiddenState]: new OnnxRuntimeWeb.Tensor('float32', hiddenState, [1, graph.hiddenSize]),
			[GRAPH_TENSOR_NAMES.expertWeightQuantized]: quantizedTensor,
			[GRAPH_TENSOR_NAMES.expertWeightScales]: scalesTensor,
		});
		return outputs[GRAPH_TENSOR_NAMES.projected].data as Float32Array;
	}

	/**
	 * Returns the device created in phase one, or throws when phase one has not run.
	 *
	 * @returns The owned device.
	 */
	static _requireDevice(): GPUDevice {
		if (Main.ownedDevice === undefined) {
			throw new Error('phase 1 did not create a WebGPU device, so no buffer can be allocated');
		}
		return Main.ownedDevice.device;
	}

	/**
	 * Formats a byte count as megabytes.
	 *
	 * @param bytes - The byte count.
	 * @returns The formatted text.
	 */
	static _megabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024).toFixed(2)} megabytes`;
	}

	/**
	 * Formats the leading values of a vector for the page's output.
	 *
	 * @param values - The vector to format.
	 * @returns The formatted text.
	 */
	static _vector(values: ArrayLike<number>): string {
		const shown: string[] = [];
		for (let index = 0; index < Math.min(values.length, 6); index++) {
			shown.push(values[index].toFixed(5));
		}
		return `[${shown.join(', ')}${values.length > 6 ? `, … ${values.length} values` : ''}]`;
	}

	/**
	 * Appends one line to the page's output.
	 *
	 * @param text - The line to append.
	 * @param className - An optional class name that colours the line.
	 * @returns Nothing.
	 */
	static _write(text: string, className?: string): void {
		if (Main.outputElement === undefined) {
			return;
		}
		const line = document.createElement('span');
		if (className !== undefined) {
			line.className = className;
		}
		line.textContent = `${text}\n`;
		Main.outputElement.append(line);
	}
}

Main.main().catch((error: unknown) => {
	console.error('the gate page failed to start', error);
});
