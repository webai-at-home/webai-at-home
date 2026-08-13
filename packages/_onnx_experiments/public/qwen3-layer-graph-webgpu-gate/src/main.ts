import * as OnnxRuntimeWeb from 'onnxruntime-web';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — runs one decoder layer graph on the processor and on WebGPU and compares them
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The de-risk gate milestone 6 of https://github.com/webai-at-home/webai-at-home/issues/169 should have had before
 * it assembled Qwen3-30B-A3B in a browser.
 *
 * `gate_qwen3_moe_non_expert_graph.py` checked the layer graph against the reference implementation and it matched
 * to 7.875e-06 — on the processor. The browser runs the identical file on WebGPU, and Qwen3-30B-A3B is the first
 * graph in this project with grouped-query attention, where 32 query heads read 4 key and value heads through an
 * `Unsqueeze`, eight `Concat` copies and a `Reshape`. Nothing had ever checked that construction on WebGPU.
 *
 * The two execution providers run the same file at single precision on the same inputs, so they can only differ by
 * rounding — unless one of them computes something else. OLMoE-1B-7B-0924 is the control rather than a number
 * written down by hand: milestone 5 generated correct text from its graphs on WebGPU three separate times, so
 * whatever the two providers disagree by on that graph is what rounding looks like here.
 */

/** Where the development server serves each model's artifacts from. */
const ARTIFACTS_URL = '/moe-artifacts';
/** Which layer graph is tested. Every layer of a model is the same construction with different numbers in it. */
const LAYER_GRAPH = 'layer_00.onnx';
/** The debug copy of it that `expose_graph_intermediates.py` writes, used only when the gate is red. */
const INTERMEDIATES_GRAPH = 'layer_00.intermediates.onnx';
/** How many tokens of history the second case puts in the key and value cache. */
const PAST_TOKEN_COUNT = 5;
/**
 * How many times the control's disagreement Qwen3-30B-A3B is allowed.
 *
 * Generous on purpose. The two graphs are different sizes and normalize differently, so they will not round
 * identically, and the gate is not trying to measure that. It is trying to separate rounding from a different
 * computation, and a graph computing something else does not miss by a factor of ten.
 */
const REQUIRED_MARGIN = 10;
/** How many divergent intermediate values are printed before the list is cut off. */
const REPORTED_DIVERGENCE_COUNT = 8;

/** The five things one layer graph returns. */
const OUTPUT_NAMES = ['residual', 'expert_input', 'router_logits', 'present_key', 'present_value'] as const;

/** What each model contributes to the gate. */
type ModelDescription = {
	/** The directory the development server serves its artifacts from. */
	name: string;
	/** What this model is here to show. */
	role: string;
	/** Whether this is the control that measures the scale, rather than the graph under test. */
	isControl: boolean;
};

/** The two models, the control first so that the scale exists before anything is judged against it. */
const MODEL_DESCRIPTIONS: ModelDescription[] = [
	{
		name: 'OLMoE-1B-7B-0924',
		role: '16 query heads reading 16 key and value heads, so no repeat at all. Milestone 5 generated correct ' +
			'text from these graphs on WebGPU.',
		isControl: true,
	},
	{
		name: 'Qwen3-30B-A3B',
		role: '32 query heads reading 4 key and value heads, repeated eight times inside the graph. Never run on ' +
			'WebGPU before milestone 6.',
		isControl: false,
	},
];

/** The parts of `graphs.json` this gate reads. */
type ModelIndex = {
	/** How wide one token's activation is. */
	hiddenSize: number;
	/** How many query heads the attention has. */
	headCount: number;
	/** How many key and value heads it has, which is what the cache holds. */
	keyValueHeadCount: number;
	/** How wide one head is. */
	headDimension: number;
	/** What the rotary embedding's base is. */
	rotaryTheta: number;
};

/** One comparison of one graph between the two execution providers. */
type Comparison = {
	/** What the case is called. */
	title: string;
	/** The worst relative difference over all five outputs. */
	worst: number;
	/** Which output was worst. */
	worstOutput: string;
};

/** Runs the gate. */
class Main {
	/** Where the page prints. */
	static output: HTMLPreElement | undefined;

	/**
	 * Wires the button up.
	 *
	 * @returns Nothing.
	 */
	static start(): void {
		Main.output = document.getElementById('output') as HTMLPreElement;
		const button = document.getElementById('run-button') as HTMLButtonElement;
		button.addEventListener('click', () => {
			button.disabled = true;
			Main.output!.innerHTML = '';
			Main.run().catch((error: unknown) => {
				Main._print(`<span class="fail">${error instanceof Error ? error.message : String(error)}</span>`);
			}).finally(() => {
				button.disabled = false;
			});
		});
	}

	/**
	 * Measures both models and prints a verdict.
	 *
	 * @returns Resolves once the verdict has been printed.
	 */
	static async run(): Promise<void> {
		const measured = new Map<string, Comparison[]>();
		for (const description of MODEL_DESCRIPTIONS) {
			Main._print(`<span class="phase">${description.name}</span>`);
			Main._print(`  ${description.role}`);
			measured.set(description.name, await Main._measure(description));
			Main._print('');
		}

		const control = MODEL_DESCRIPTIONS.find((description) => description.isControl === true)!;
		const tested = MODEL_DESCRIPTIONS.find((description) => description.isControl === false)!;
		const controlWorst = Math.max(...measured.get(control.name)!.map((comparison) => comparison.worst));
		const testedWorst = Math.max(...measured.get(tested.name)!.map((comparison) => comparison.worst));

		Main._print('<span class="phase">the verdict</span>');
		Main._print(`  ${control.name} disagrees between the two execution providers by ${controlWorst.toExponential(3)}`);
		Main._print(`  ${tested.name} disagrees by ${testedWorst.toExponential(3)}`);
		Main._print(`  which is ${(testedWorst / controlWorst).toFixed(1)} times the control`);
		Main._print('');
		if (testedWorst <= controlWorst * REQUIRED_MARGIN) {
			Main._print(`<span class="pass">GATE GREEN</span> — ${tested.name} is within ${REQUIRED_MARGIN} times the ` +
				'control, so the two execution providers are computing the same thing and the wrong words come from ' +
				'somewhere else.');
			return;
		}
		Main._print(`<span class="fail">GATE RED</span> — ${tested.name} is ` +
			`${(testedWorst / controlWorst).toFixed(0)} times the control. WebGPU is not computing what the processor ` +
			'computes for this graph, which is enough on its own to explain the wrong words.');

		Main._print('');
		Main._print('<span class="phase">which node goes wrong first</span>');
		await Main._findFirstDivergence(tested, controlWorst * REQUIRED_MARGIN);
	}

	/**
	 * Finds the first node of a graph whose two execution providers disagree.
	 *
	 * Every node after the first bad one is only carrying the mistake forward, so the interesting one is the earliest.
	 * This needs the debug copy `expose_graph_intermediates.py` writes, because a graph that returns only its real
	 * outputs cannot say where it went wrong.
	 *
	 * @param description Which model.
	 * @param allowed How large a difference still counts as rounding.
	 * @returns Resolves once the answer has been printed.
	 */
	static async _findFirstDivergence(description: ModelDescription, allowed: number): Promise<void> {
		const graphUrl = `${ARTIFACTS_URL}/${description.name}/graphs/${INTERMEDIATES_GRAPH}`;
		const head = await fetch(graphUrl, {
			method: 'HEAD',
		});
		if (head.ok === false) {
			Main._print(`  ${INTERMEDIATES_GRAPH} is not there. Write it with:`);
			Main._print('    packages/_onnx_experiments/tools/.venv/bin/python \\');
			Main._print('      packages/_onnx_experiments/tools/model_graphs/expose_graph_intermediates.py \\');
			Main._print(`      --graph /tmp/qwen3-30b-a3b-graphs/${LAYER_GRAPH} \\`);
			Main._print(`      --output /tmp/qwen3-30b-a3b-graphs/${INTERMEDIATES_GRAPH}`);
			return;
		}

		const index = await (await fetch(`${ARTIFACTS_URL}/${description.name}/graphs/graphs.json`)).json() as ModelIndex;
		const processorSession = await OnnxRuntimeWeb.InferenceSession.create(graphUrl, {
			executionProviders: ['wasm'],
		});
		const graphicsSession = await OnnxRuntimeWeb.InferenceSession.create(graphUrl, {
			executionProviders: ['webgpu'],
		});
		const feeds = Main._buildFeeds(index, 0);
		const fromProcessor = await processorSession.run(feeds);
		const fromGraphics = await graphicsSession.run(feeds);

		// The graph's own five outputs are skipped. They sit at the front of the output list and the intermediates were
		// appended after them, so walking the list in order would report a final output before the node that spoiled
		// it. Everything after those five is in the order the graph computes it, which is what "first" has to mean.
		const walked = processorSession.outputNames.filter((name) => {
			return (OUTPUT_NAMES as readonly string[]).includes(name) === false;
		});
		Main._print(`  ${walked.length} intermediate values compared, in the order the graph computes them`);
		let found = false;
		let reported = 0;
		for (const name of walked) {
			const left = fromProcessor[name];
			const right = fromGraphics[name];
			const difference = Main._relativeDifference(left.data as Float32Array, right.data as Float32Array);
			const shapesAgree = JSON.stringify(left.dims) === JSON.stringify(right.dims);
			if (difference <= allowed && shapesAgree === true) {
				continue;
			}
			Main._print(`  <span class="fail">${name}</span> ${JSON.stringify(left.dims)} differs by ` +
				`${difference.toExponential(3)}`);
			Main._print(`    processor: ${Main._firstFew(left.data as Float32Array)}`);
			Main._print(`    WebGPU:    ${Main._firstFew(right.data as Float32Array)}`);
			found = true;
			reported++;
			if (reported >= REPORTED_DIVERGENCE_COUNT) {
				Main._print(`  … and everything after that, which is only carrying it forward.`);
				break;
			}
		}
		if (found === false) {
			Main._print('  every intermediate value agrees, which means the divergence is in something the debug copy ' +
				'defeated — a fusion the runtime does only when the value is not returned.');
		}
		await processorSession.release();
		await graphicsSession.release();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Measuring
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one model's layer graph on both execution providers, for both cases.
	 *
	 * @param description Which model.
	 * @returns One comparison for each case.
	 */
	static async _measure(description: ModelDescription): Promise<Comparison[]> {
		const graphsUrl = `${ARTIFACTS_URL}/${description.name}/graphs`;
		const index = await (await fetch(`${graphsUrl}/graphs.json`)).json() as ModelIndex;
		Main._print(`  ${index.headCount} query heads, ${index.keyValueHeadCount} key and value heads of ` +
			`${index.headDimension}, hidden size ${index.hiddenSize}`);

		const graphUrl = `${graphsUrl}/${LAYER_GRAPH}`;
		Main._print(`  loading ${LAYER_GRAPH} twice…`);
		const processorSession = await OnnxRuntimeWeb.InferenceSession.create(graphUrl, {
			executionProviders: ['wasm'],
		});
		const graphicsSession = await OnnxRuntimeWeb.InferenceSession.create(graphUrl, {
			executionProviders: ['webgpu'],
		});

		const comparisons: Comparison[] = [];
		for (const pastTokenCount of [0, PAST_TOKEN_COUNT]) {
			const feeds = Main._buildFeeds(index, pastTokenCount);
			const fromProcessor = await processorSession.run(feeds);
			const fromGraphics = await graphicsSession.run(feeds);

			let worst = 0;
			let worstOutput = OUTPUT_NAMES[0] as string;
			for (const name of OUTPUT_NAMES) {
				const difference = Main._relativeDifference(
					fromProcessor[name].data as Float32Array,
					fromGraphics[name].data as Float32Array,
				);
				if (difference > worst) {
					worst = difference;
					worstOutput = name;
				}
			}
			const title = pastTokenCount === 0 ? 'one token, empty cache' : `one token, ${pastTokenCount} of history`;
			comparisons.push({
				title: title,
				worst: worst,
				worstOutput: worstOutput,
			});
			Main._print(`  ${title.padEnd(30)} worst ${worst.toExponential(3)} on ${worstOutput}`);
		}

		await processorSession.release();
		await graphicsSession.release();
		return comparisons;
	}

	/**
	 * Builds one set of graph inputs, the same every time this page is opened.
	 *
	 * The numbers are made up, and that is the point. Both execution providers are given exactly the same made-up
	 * numbers, so anything they disagree about is theirs.
	 *
	 * @param index What `graphs.json` said.
	 * @param pastTokenCount How many tokens of history to put in the cache.
	 * @returns The six inputs the layer graph declares.
	 */
	static _buildFeeds(index: ModelIndex, pastTokenCount: number): Record<string, OnnxRuntimeWeb.Tensor> {
		const random = Main._normalSource(4 + pastTokenCount);
		const cacheLength = index.keyValueHeadCount * pastTokenCount * index.headDimension;
		const total = pastTokenCount + 1;

		const cosine = new Float32Array(index.headDimension);
		const sine = new Float32Array(index.headDimension);
		const half = index.headDimension / 2;
		for (let position = 0; position < half; position++) {
			const angle = pastTokenCount / Math.pow(index.rotaryTheta, (position * 2) / index.headDimension);
			cosine[position] = Math.cos(angle);
			sine[position] = Math.sin(angle);
			cosine[position + half] = cosine[position];
			sine[position + half] = sine[position];
		}

		return {
			hidden_state: new OnnxRuntimeWeb.Tensor('float32', Main._fill(index.hiddenSize, random), [
				1,
				1,
				index.hiddenSize,
			]),
			past_key: new OnnxRuntimeWeb.Tensor('float32', Main._fill(cacheLength, random), [
				1,
				index.keyValueHeadCount,
				pastTokenCount,
				index.headDimension,
			]),
			past_value: new OnnxRuntimeWeb.Tensor('float32', Main._fill(cacheLength, random), [
				1,
				index.keyValueHeadCount,
				pastTokenCount,
				index.headDimension,
			]),
			cos: new OnnxRuntimeWeb.Tensor('float32', cosine, [1, 1, 1, index.headDimension]),
			sin: new OnnxRuntimeWeb.Tensor('float32', sine, [1, 1, 1, index.headDimension]),
			// One token may attend to the whole history, so the bias is zero everywhere. This is exactly what the
			// generation loop feeds, which is what makes this gate about the case that produced the wrong words.
			attention_bias: new OnnxRuntimeWeb.Tensor('float32', new Float32Array(total), [1, 1, 1, total]),
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Measures how far apart two answers to the same question are.
	 *
	 * The same measure the Python gates use: the largest absolute difference, divided by how large the values are in
	 * the first place, so that a graph whose outputs happen to be big is not flattered by it.
	 *
	 * @param left One answer.
	 * @param right The other.
	 * @returns The relative difference.
	 */
	static _relativeDifference(left: Float32Array, right: Float32Array): number {
		if (left.length !== right.length) {
			throw new Error(`the two execution providers returned ${left.length} and ${right.length} values`);
		}
		let largest = 0;
		let total = 0;
		for (let index = 0; index < left.length; index++) {
			largest = Math.max(largest, Math.abs(left[index] - right[index]));
			total += Math.abs(left[index]);
		}
		const scale = total / left.length;
		if (scale === 0) {
			return largest;
		}
		return largest / scale;
	}

	/**
	 * Makes an array of normally distributed values.
	 *
	 * @param length How many.
	 * @param random Where the values come from.
	 * @returns The array.
	 */
	static _fill(length: number, random: () => number): Float32Array {
		const values = new Float32Array(length);
		for (let index = 0; index < length; index++) {
			values[index] = random();
		}
		return values;
	}

	/**
	 * Builds a repeatable source of normally distributed values.
	 *
	 * Repeatable on purpose. A gate whose inputs change every time it is opened cannot be compared with the last time
	 * it was opened.
	 *
	 * @param seed Which sequence.
	 * @returns A function giving the next value.
	 */
	static _normalSource(seed: number): () => number {
		let state = seed >>> 0;
		const uniform = (): number => {
			// A small linear congruential generator, with the constants Numerical Recipes uses.
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return (state + 1) / 4294967297;
		};
		return () => {
			return Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
		};
	}

	/**
	 * Formats the first few values of a tensor, so that two wrong answers can be told apart by eye.
	 *
	 * @param values The values.
	 * @returns The formatted text.
	 */
	static _firstFew(values: Float32Array): string {
		return [...values.slice(0, 6)].map((value) => value.toFixed(5)).join(' ');
	}

	/**
	 * Prints one line.
	 *
	 * @param line The line, which may hold the small set of span tags this page styles.
	 * @returns Nothing.
	 */
	static _print(line: string): void {
		Main.output!.innerHTML += `${line}\n`;
	}
}

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
Main.start();
