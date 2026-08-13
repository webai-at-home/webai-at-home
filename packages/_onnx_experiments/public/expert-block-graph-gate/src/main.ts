import * as OnnxRuntimeWeb from 'onnxruntime-web';
import type { BlockPart, ExpertBlockReference } from './fixture_types.ts';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — the third de-risking gate of milestone 5 of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Two things have been proved separately and never together.
 *
 * Milestone 0 proved that ONNX Runtime Web executes `MatMulNBits` against a WebGPU buffer this project owns, and that
 * overwriting that buffer changes the answer without a new session. It did so with weights it invented, at single
 * precision, with the fixed zero point of 8.
 *
 * Milestone 3 then chose a different scheme, because it measured that scheme against real published weights: one zero
 * point fitted to every block, and the scales stored at **half precision**, which saved 1.69 gigabytes across
 * Qwen3-30B-A3B. It wrote 15.61 gigabytes to disk that way, and published them.
 *
 * `MatMulNBits` requires the activation and the scales to have the same element type, so half precision scales force
 * the whole projection to half precision. Nothing has yet run a real converted block through a real graph, so nothing
 * knows whether milestone 3's bytes and milestone 0's finding fit together. Milestone 5 assembles a whole model on
 * top of that assumption, which is exactly the kind of assumption to kill before building on it.
 *
 * The answer to compare against is computed outside this browser, by
 * `packages/_onnx_experiments/tools/weight_conversion/make_expert_block_graph_fixture.mjs`, from the block's **own bytes** rather than
 * from the original model. That keeps the question about how the bytes are read, and not about how well 4 bits
 * approximate a weight, which milestone 3 already measured.
 */

// The runtime's WebAssembly files are served from the site root by the Vite plugin in `vite.config.js`. Without this,
// the runtime resolves them next to this page and receives the index page instead, which surfaces as a WebAssembly
// magic word of `3c 21 64 6f`, which is the text `<!do`.
OnnxRuntimeWeb.env.wasm.wasmPaths = '/';

/** Where the three generated fixture files live. */
const FIXTURE_DIRECTORY = '/expert-block-graph-gate/fixture';
/** The names of the three projections one expert is made of, in the order a block holds them. */
const PROJECTION_NAMES = ['gate_proj', 'up_proj', 'down_proj'] as const;
/** How many parts one projection contributes to a block: the quantized matrix, its scales, and its zero points. */
const PARTS_FOR_EACH_PROJECTION = 3;
/**
 * How much closer to the single precision answer the graph must be than a fully half precision computation is.
 *
 * There is no tolerance written down here on purpose. A number chosen by hand is exactly how a gate ends up passing
 * something it should not: pick 5e-3 and this gate reads red for a reason that is only rounding, pick 5e-2 and it
 * reads green whatever happens. So the fixture carries the same expert computed twice, once in single precision and
 * once entirely in half precision, and the graph is required to sit inside that bracket with room to spare. Both
 * edges are measured rather than assumed, and they move with the model instead of staying put while it changes.
 */
const REQUIRED_MARGIN = 2;
/** The stored value `MatMulNBits` assumes when it is given no zero point tensor, used as the negative control. */
const FIXED_ZERO_POINT = 8;

/** What one phase of the gate concluded. */
type PhaseOutcome = {
	/** Whether the phase passed. */
	passed: boolean;
	/** One line saying what was measured. */
	summary: string;
	/** Any further lines worth printing. */
	details?: string[];
};

/** The nine WebGPU buffers holding one expert, one for each part of its block. */
type ExpertBuffers = {
	/** The buffers, in the order the block holds their parts. */
	parts: GPUBuffer[];
};

/** Runs the gate and prints what it found. */
class Main {
	/** The loaded fixture, once phase 1 has read it. */
	static reference: ExpertBlockReference | undefined = undefined;
	/** The raw bytes of one converted expert block, once phase 1 has read them. */
	static blockBytes: Uint8Array | undefined = undefined;
	/** The serialized expert graph, once phase 1 has read it. */
	static graphBytes: Uint8Array | undefined = undefined;
	/** The session running the expert graph, once phase 2 has created it. */
	static session: OnnxRuntimeWeb.InferenceSession | undefined = undefined;
	/** The device ONNX Runtime Web runs on, borrowed rather than offered, once phase 2 has read it back. */
	static device: GPUDevice | undefined = undefined;
	/** Where the page prints. */
	static output: HTMLPreElement | undefined = undefined;

	/**
	 * Wires the button up.
	 *
	 * @returns Nothing.
	 */
	static start(): void {
		Main.output = document.getElementById('output') as HTMLPreElement;
		const button = document.getElementById('run-button') as HTMLButtonElement;
		button.disabled = false;
		button.textContent = 'Run the gate';
		button.addEventListener('click', () => {
			button.disabled = true;
			button.textContent = 'Running…';
			Main.run().finally(() => {
				button.disabled = false;
				button.textContent = 'Run the gate again';
			});
		});
	}

	/**
	 * Runs every phase in order and prints a verdict.
	 *
	 * @returns Resolves once the verdict has been printed.
	 */
	static async run(): Promise<void> {
		Main.output!.textContent = '';
		Main._print('gate: does ONNX Runtime Web compute the right expert from the bytes milestone 3 wrote?\n');

		const phases: { title: string; run: () => Promise<PhaseOutcome> }[] = [
			{
				title: '1 · the fixture: one real converted block, and an answer computed outside the browser',
				run: Main.phaseReadFixture,
			},
			{
				title: '2 · a weightless expert graph loads, and offers all nine weight tensors as runtime inputs',
				run: Main.phaseCreateSession,
			},
			{
				title: '3 · the right answer, with the nine tensors supplied from the processor side',
				run: Main.phaseRunFromProcessor,
			},
			{
				title: '4 · the right answer, with all nine read from WebGPU buffers this page owns',
				run: Main.phaseRunFromOwnedBuffers,
			},
			{
				title: '5 · the same bytes give the same answer bit for bit, whichever way they reach the graph',
				run: Main.phaseRepeatability,
			},
			{
				title: '6 · a negative control: the same run with the stored zero points replaced by the fixed 8',
				run: Main.phaseNegativeControl,
			},
		];

		let passedCount = 0;
		for (const phase of phases) {
			Main._print(`\n<span class="phase">${phase.title}</span>`);
			try {
				const outcome = await phase.run();
				if (outcome.passed) {
					passedCount++;
				}
				Main._print(`  <span class="${outcome.passed ? 'pass' : 'fail'}">${outcome.summary}</span>`);
				for (const line of outcome.details ?? []) {
					Main._print(`  ${line}`);
				}
			} catch (error) {
				Main._print(`  <span class="fail">threw: ${error instanceof Error ? error.message : String(error)}</span>`);
			}
		}

		Main._print('');
		if (passedCount === phases.length) {
			Main._print('<span class="pass">GATE GREEN — the converted blocks compute correctly through a real graph.</span>');
			Main._print('  Milestone 5 may assemble a whole model on top of these bytes.');
		} else {
			Main._print(`<span class="fail">GATE RED — ${passedCount} of ${phases.length} phases passed.</span>`);
			Main._print('  Nothing should be built on this layout until the difference is explained.');
		}
		await Main._release();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the three generated files, and checks the block is exactly as long as its own manifest says.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseReadFixture(): Promise<PhaseOutcome> {
		Main.reference = await Main._fetchJson<ExpertBlockReference>(`${FIXTURE_DIRECTORY}/reference.json`);
		Main.blockBytes = await Main._fetchBytes(`${FIXTURE_DIRECTORY}/expert_block.bin`);
		Main.graphBytes = await Main._fetchBytes(`${FIXTURE_DIRECTORY}/expert.onnx`);

		const reference = Main.reference;
		if (Main.blockBytes.length !== reference.blockByteLength) {
			return {
				passed: false,
				summary: `the block is ${Main.blockBytes.length} bytes where its manifest says ` +
					`${reference.blockByteLength}`,
			};
		}

		return {
			passed: true,
			summary: `read block ${reference.blockIndex}, ${reference.blockByteLength} bytes in ` +
				`${reference.parts.length} parts, and a ${reference.output.length}-value answer for it`,
			details: [
				`${reference.sourceRepository} at ${reference.sourceRevision.slice(0, 12)}, ` +
					`layer ${reference.layerIndex}, expert ${reference.expertIndex}`,
				`${reference.quantization.bits} bits, blocks of ${reference.quantization.blockSize}, ` +
					`${reference.quantization.scheme}, scales at half precision`,
				`the answer: ${reference.howTheAnswerWasComputed}`,
				`the graph is ${Main.graphBytes.length} bytes, because it holds no weights at all`,
			],
		};
	}

	/**
	 * Creates the session on the WebGPU execution provider, then borrows the device the runtime chose.
	 *
	 * The order is not a preference. Milestone 0 measured that a device offered through `env.webgpu.device` before the
	 * first session exists is accepted without error and then ignored, and that a buffer allocated on the offered
	 * device fails at bind group creation while the run quietly returns zeros. So the session is created first and the
	 * device is read back out of it.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseCreateSession(): Promise<PhaseOutcome> {
		Main.session = await OnnxRuntimeWeb.InferenceSession.create(Main.graphBytes!, {
			executionProviders: ['webgpu'],
		});
		Main.device = await OnnxRuntimeWeb.env.webgpu.device;
		if (Main.device === undefined) {
			return {
				passed: false,
				summary: 'the session was created but no WebGPU device came back out of it',
			};
		}

		const expected = PROJECTION_NAMES.flatMap((name) => [
			`${name}_quantized`,
			`${name}_scales`,
			`${name}_zero_points`,
		]);
		const missing = expected.filter((name) => Main.session!.inputNames.includes(name) === false);
		if (missing.length > 0) {
			return {
				passed: false,
				summary: `the session does not offer ${missing.join(', ')} as a runtime input`,
			};
		}

		return {
			passed: true,
			summary: `the session offers all ${expected.length} weight tensors as runtime inputs`,
			details: [`inputs: ${Main.session.inputNames.join(', ')}`],
		};
	}

	/**
	 * Runs the graph with the nine tensors handed over as ordinary processor-side arrays.
	 *
	 * This phase is here to separate two ways of being wrong. If the answer is wrong here, the layout or the element
	 * types are misunderstood. If it is right here and wrong in phase 4, the mistake is in the WebGPU path.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseRunFromProcessor(): Promise<PhaseOutcome> {
		const reference = Main.reference!;
		const feeds = Main._processorFeeds(Main.blockBytes!);
		const outputs = await Main.session!.run(feeds);
		const answer = outputs.expert_output.data as Float32Array;
		return Main._compare(answer, reference, 'supplied from the processor side');
	}

	/**
	 * Runs the graph with all nine tensors read out of WebGPU buffers this page allocated and filled.
	 *
	 * Every buffer is filled from the block at the part's own offset, which is the operation the residency layer
	 * performs on every cache miss.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseRunFromOwnedBuffers(): Promise<PhaseOutcome> {
		const reference = Main.reference!;
		const buffers = Main._allocateExpertBuffers(reference.parts);
		try {
			Main._uploadBlock(buffers, reference.parts, Main.blockBytes!);
			const outputs = await Main.session!.run(Main._bufferFeeds(buffers));
			const answer = outputs.expert_output.data as Float32Array;
			return Main._compare(answer, reference, 'read from nine WebGPU buffers this page owns');
		} finally {
			Main._releaseExpertBuffers(buffers);
		}
	}

	/**
	 * Requires the same block to give bit-identical answers, run twice, and through either path.
	 *
	 * This is the phase milestone 5 actually rests on. Milestone 5 runs a whole model twice, once with every expert
	 * resident and once through the residency layer, and requires the generated tokens to be identical. Being close
	 * is worth nothing there: one token whose two best candidates are a hair apart turns any difference at all into a
	 * different word and then a different sentence. So what has to hold is not accuracy but that a buffer filled from
	 * disk and a buffer that was already there produce the same bits.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseRepeatability(): Promise<PhaseOutcome> {
		const reference = Main.reference!;
		const buffers = Main._allocateExpertBuffers(reference.parts);
		try {
			Main._uploadBlock(buffers, reference.parts, Main.blockBytes!);
			const first = ((await Main.session!.run(Main._bufferFeeds(buffers))).expert_output.data as Float32Array)
				.slice();
			const second = ((await Main.session!.run(Main._bufferFeeds(buffers))).expert_output.data as Float32Array)
				.slice();

			// The buffers are overwritten with the same bytes again, which is what the residency layer does when an
			// expert is evicted and then wanted back.
			Main._uploadBlock(buffers, reference.parts, Main.blockBytes!);
			const third = ((await Main.session!.run(Main._bufferFeeds(buffers))).expert_output.data as Float32Array)
				.slice();

			const fromProcessor = ((await Main.session!.run(Main._processorFeeds(Main.blockBytes!)))
				.expert_output.data as Float32Array).slice();

			const twiceMatches = Main._identical(first, second);
			const afterRefillMatches = Main._identical(first, third);
			const pathsMatch = Main._identical(first, fromProcessor);
			const passed = twiceMatches && afterRefillMatches;

			return {
				passed: passed,
				summary: passed
					? 'run twice, and again after the buffers were refilled, every one of the ' +
						`${first.length} values came back bit for bit the same`
					: `the answer moved between runs: twice ${twiceMatches ? 'matched' : 'DIFFERED'}, ` +
						`after a refill ${afterRefillMatches ? 'matched' : 'DIFFERED'}`,
				details: [
					`the processor-side path ${pathsMatch ? 'also agrees bit for bit' : 'differs, which is only rounding ' +
						'if it is small, and is worth knowing either way'}`,
				],
			};
		} finally {
			Main._releaseExpertBuffers(buffers);
		}
	}

	/**
	 * Runs the same thing again with every stored zero point replaced by the fixed 8 that `MatMulNBits` assumes when
	 * it is given no zero point tensor at all.
	 *
	 * A phase that merely runs without throwing proves the tensors were accepted, not that the right bytes were read.
	 * This one changes one of the nine parts to something plausible and wrong, and requires the answer to become
	 * wrong. If it does not, the zero points are not reaching the operator and every number above means nothing.
	 *
	 * @returns What the phase concluded.
	 */
	static async phaseNegativeControl(): Promise<PhaseOutcome> {
		const reference = Main.reference!;
		const spoiled = new Uint8Array(Main.blockBytes!);
		const packedFixedZeroPoint = FIXED_ZERO_POINT | (FIXED_ZERO_POINT << 4);
		for (let index = 0; index < PROJECTION_NAMES.length; index++) {
			const part = reference.parts[index * PARTS_FOR_EACH_PROJECTION + 2];
			spoiled.fill(packedFixedZeroPoint, part.offset, part.offset + part.byteLength);
		}

		const outputs = await Main.session!.run(Main._processorFeeds(spoiled));
		const answer = outputs.expert_output.data as Float32Array;
		const relative = Main._relativeDifference(answer, reference.output);
		const bracket = Main._relativeDifference(
			Float32Array.from(reference.outputAtHalfPrecision),
			reference.output,
		);
		const passed = relative > bracket;
		return {
			passed: passed,
			summary: passed
				? `the answer became wrong by ${relative.toExponential(2)} relative, ` +
					`${(relative / bracket).toFixed(0)} times the whole width of the bracket above`
				: `the answer only moved by ${relative.toExponential(2)}, so the zero points may not be read at all`,
			details: ['one of the nine parts was replaced by something plausible and wrong, and the answer had to move'],
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Feeding the graph
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the ten tensors the graph asks for, every weight tensor a view into the block at its own offset.
	 *
	 * @param block - The block's bytes.
	 * @returns The tensors, keyed by input name.
	 */
	static _processorFeeds(block: Uint8Array): Record<string, OnnxRuntimeWeb.Tensor> {
		const reference = Main.reference!;
		const feeds: Record<string, OnnxRuntimeWeb.Tensor> = {
			expert_input: new OnnxRuntimeWeb.Tensor('float32', Float32Array.from(reference.input), [
				1,
				1,
				reference.hiddenSize,
			]),
		};

		for (let index = 0; index < PROJECTION_NAMES.length; index++) {
			const name = PROJECTION_NAMES[index];
			const shape = Main._projectionShape(name);
			const quantizedPart = reference.parts[index * PARTS_FOR_EACH_PROJECTION];
			const scalesPart = reference.parts[index * PARTS_FOR_EACH_PROJECTION + 1];
			const zeroPointsPart = reference.parts[index * PARTS_FOR_EACH_PROJECTION + 2];

			feeds[`${name}_quantized`] = new OnnxRuntimeWeb.Tensor(
				'uint8',
				block.slice(quantizedPart.offset, quantizedPart.offset + quantizedPart.byteLength),
				[shape.outputSize, shape.blocksForEachRow, shape.blobSize],
			);
			feeds[`${name}_scales`] = new OnnxRuntimeWeb.Tensor(
				'float16',
				new Uint16Array(
					block.slice(scalesPart.offset, scalesPart.offset + scalesPart.byteLength).buffer,
				),
				[shape.outputSize * shape.blocksForEachRow],
			);
			feeds[`${name}_zero_points`] = new OnnxRuntimeWeb.Tensor(
				'uint8',
				block.slice(zeroPointsPart.offset, zeroPointsPart.offset + zeroPointsPart.byteLength),
				[zeroPointsPart.byteLength],
			);
		}
		return feeds;
	}

	/**
	 * Builds the same ten tensors, with the nine weight tensors bound to the owned buffers instead.
	 *
	 * @param buffers - The nine buffers, in the order the block holds their parts.
	 * @returns The tensors, keyed by input name.
	 */
	static _bufferFeeds(buffers: ExpertBuffers): Record<string, OnnxRuntimeWeb.Tensor> {
		const reference = Main.reference!;
		const feeds: Record<string, OnnxRuntimeWeb.Tensor> = {
			expert_input: new OnnxRuntimeWeb.Tensor('float32', Float32Array.from(reference.input), [
				1,
				1,
				reference.hiddenSize,
			]),
		};

		for (let index = 0; index < PROJECTION_NAMES.length; index++) {
			const name = PROJECTION_NAMES[index];
			const shape = Main._projectionShape(name);
			const zeroPointsPart = reference.parts[index * PARTS_FOR_EACH_PROJECTION + 2];

			feeds[`${name}_quantized`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers.parts[index * PARTS_FOR_EACH_PROJECTION],
				{
					dataType: 'uint8',
					dims: [shape.outputSize, shape.blocksForEachRow, shape.blobSize],
				},
			);
			feeds[`${name}_scales`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers.parts[index * PARTS_FOR_EACH_PROJECTION + 1],
				{
					dataType: 'float16',
					dims: [shape.outputSize * shape.blocksForEachRow],
				},
			);
			feeds[`${name}_zero_points`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers.parts[index * PARTS_FOR_EACH_PROJECTION + 2],
				{
					dataType: 'uint8',
					dims: [zeroPointsPart.byteLength],
				},
			);
		}
		return feeds;
	}

	/**
	 * Works out the dimensions of one projection from the model's two sizes.
	 *
	 * @param name - Which projection.
	 * @returns Its dimensions and block geometry.
	 */
	static _projectionShape(name: string): {
		inputSize: number;
		outputSize: number;
		blocksForEachRow: number;
		blobSize: number;
	} {
		const reference = Main.reference!;
		const inputSize = name === 'down_proj' ? reference.expertWidth : reference.hiddenSize;
		const outputSize = name === 'down_proj' ? reference.hiddenSize : reference.expertWidth;
		const blockSize = reference.quantization.blockSize;
		return {
			inputSize: inputSize,
			outputSize: outputSize,
			blocksForEachRow: Math.ceil(inputSize / blockSize),
			blobSize: (blockSize * reference.quantization.bits) / 8,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Owned buffers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Allocates one WebGPU buffer for every part of an expert block.
	 *
	 * Nine buffers rather than one, because milestone 0 measured that `Tensor.fromGpuBuffer` binds a whole buffer and
	 * cannot be given a range inside a larger one. That is the finding the whole on-disk layout was designed around.
	 *
	 * @param parts - Where each part sits inside the block, and how long it is.
	 * @returns The nine buffers.
	 */
	static _allocateExpertBuffers(parts: BlockPart[]): ExpertBuffers {
		const device = Main.device!;
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
		return {
			parts: parts.map((part) => {
				return device.createBuffer({
					size: Math.ceil(part.byteLength / 16) * 16,
					usage: usage,
					label: part.name,
				});
			}),
		};
	}

	/**
	 * Fills every buffer from the block, each part read at its own offset.
	 *
	 * @param buffers - The nine buffers.
	 * @param parts - Where each part sits inside the block.
	 * @param block - The block's bytes.
	 * @returns Nothing.
	 */
	static _uploadBlock(buffers: ExpertBuffers, parts: BlockPart[], block: Uint8Array): void {
		const device = Main.device!;
		for (let index = 0; index < parts.length; index++) {
			device.queue.writeBuffer(
				buffers.parts[index],
				0,
				block,
				parts[index].offset,
				parts[index].byteLength,
			);
		}
	}

	/**
	 * Destroys the nine buffers.
	 *
	 * @param buffers - The buffers to destroy.
	 * @returns Nothing.
	 */
	static _releaseExpertBuffers(buffers: ExpertBuffers): void {
		for (const buffer of buffers.parts) {
			buffer.destroy();
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Compares one answer against the bracket the fixture carries, and turns the comparison into a phase outcome.
	 *
	 * @param answer - What the graph produced.
	 * @param reference - The fixture, holding both edges of the bracket.
	 * @param how - How the weights reached the graph, for the printed line.
	 * @returns What the phase concluded.
	 */
	static _compare(answer: Float32Array, reference: ExpertBlockReference, how: string): PhaseOutcome {
		if (answer.length !== reference.output.length) {
			return {
				passed: false,
				summary: `the graph returned ${answer.length} values where ${reference.output.length} were expected`,
			};
		}
		const relative = Main._relativeDifference(answer, reference.output);
		const bracket = Main._relativeDifference(
			Float32Array.from(reference.outputAtHalfPrecision),
			reference.output,
		);
		const margin = relative === 0 ? Number.POSITIVE_INFINITY : bracket / relative;
		const passed = margin >= REQUIRED_MARGIN;
		return {
			passed: passed,
			summary: passed
				? `${relative.toExponential(2)} from the single precision answer, ${how}, which is ` +
					`${margin.toFixed(1)} times nearer than half precision throughout`
				: `${relative.toExponential(2)} from the single precision answer, ${how}, and half precision ` +
					`throughout is only ${margin.toFixed(1)} times worse`,
			details: [
				`the bracket: 0 in single precision, ${bracket.toExponential(2)} in half precision throughout`,
				`the graph's first three values: ${[...answer.slice(0, 3)].map((v) => v.toFixed(6)).join(', ')}`,
				`the single precision answer:    ${reference.output.slice(0, 3).map((v) => v.toFixed(6)).join(', ')}`,
			],
		};
	}

	/**
	 * Says whether two answers are the same bit for bit.
	 *
	 * @param first - One answer.
	 * @param second - The other.
	 * @returns Whether every value is exactly equal.
	 */
	static _identical(first: Float32Array, second: Float32Array): boolean {
		if (first.length !== second.length) {
			return false;
		}
		for (let index = 0; index < first.length; index++) {
			if (first[index] !== second[index]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Measures how far two answers are apart, as the largest absolute difference over the mean magnitude.
	 *
	 * The mean magnitude is used rather than each value's own magnitude because an expert output holds values near
	 * zero, and dividing by one of those turns a difference of no consequence into a large number.
	 *
	 * @param answer - What the graph produced.
	 * @param expected - What was expected.
	 * @returns The relative difference.
	 */
	static _relativeDifference(answer: Float32Array, expected: number[]): number {
		let largest = 0;
		let total = 0;
		for (let index = 0; index < expected.length; index++) {
			largest = Math.max(largest, Math.abs(answer[index] - expected[index]));
			total += Math.abs(expected[index]);
		}
		const scale = total / expected.length;
		return scale === 0 ? largest : largest / scale;
	}

	/**
	 * Fetches one file as bytes, and says which file failed rather than leaving a bare network error.
	 *
	 * @param url - What to fetch.
	 * @returns The bytes.
	 */
	static async _fetchBytes(url: string): Promise<Uint8Array> {
		const response = await fetch(url);
		if (response.ok === false) {
			throw new Error(
				`${url} returned ${response.status}. The fixture is generated and is not committed — see the tools README.`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * Fetches one file as parsed JSON.
	 *
	 * @param url - What to fetch.
	 * @returns The parsed content.
	 */
	static async _fetchJson<Parsed>(url: string): Promise<Parsed> {
		const response = await fetch(url);
		if (response.ok === false) {
			throw new Error(
				`${url} returned ${response.status}. The fixture is generated and is not committed — see the tools README.`,
			);
		}
		return await response.json() as Parsed;
	}

	/**
	 * Releases the session so that running the gate a second time on the same page starts from nothing.
	 *
	 * @returns Resolves once the session is gone.
	 */
	static async _release(): Promise<void> {
		if (Main.session !== undefined) {
			await Main.session.release();
			Main.session = undefined;
		}
	}

	/**
	 * Prints one line.
	 *
	 * @param line - The line, which may hold the small set of span tags this page styles.
	 * @returns Nothing.
	 */
	static _print(line: string): void {
		Main.output!.innerHTML += `${line}\n`;
	}
}

Main.start();
