import { Gemma4Mobile } from '../vendor/gemma-4-e2b.js';
import type { Gemma4MobileProgressEvent } from '../vendor/gemma-4-e2b.js';
import { MeasurementStatistics, type GenerationRun } from './measurement_statistics.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExperimentPage — drives the three steps of the Gemma 4 E2B WebGPU compute kernel experiment
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One question whose answer is checked before anything is measured. WebGPU returns wrong numbers silently,
 * so a generation that runs to the end proves nothing on its own.
 */
export type CorrectnessCheck = {
	/** The question to ask.  */
	prompt: string;
	/** Text the answer has to hold for the check to pass, compared without regard to letter case. */
	requiredSubstring: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The Hugging Face model to load, or `null` to take the one the vendored bundle names itself. */
const MODEL_ID: string | null = null;

/** How many tokens any single answer on this page may hold at most. */
const MAX_NEW_TOKENS = 256;

/**
 * The questions whose answers are checked before anything is measured. Their answers are short, they are the
 * same in every runtime, and no wrong-numbers answer reaches them by chance. The bundle always takes the
 * highest scoring token, so the same question always gives the same answer.
 */
const CORRECTNESS_CHECKS: CorrectnessCheck[] = [
	{
		prompt: 'What is the capital city of France? Answer with the name of the city only.',
		requiredSubstring: 'Paris',
	},
	{
		prompt: 'What is 17 plus 25? Answer with the number only.',
		requiredSubstring: '42',
	},
];

/**
 * The question every measured run asks. It is the question the Transformers.js Gemma 4 E2B page in
 * `packages/_onnx_experiments/public/gemma4-e2b-it/` asks, so that the two pages are compared on one question.
 */
const MEASUREMENT_PROMPT = 'Explain in two short sentences why running a language model in the browser can be useful.';

/**
 * The answer the Transformers.js Gemma 4 E2B page in `packages/_onnx_experiments/public/gemma4-e2b-it/` gave to
 * `MEASUREMENT_PROMPT`. It is shown beside this page's answer so that a person can see the two side by side.
 * The two answers are not word for word the same and are not meant to be: the two pages load two different
 * quantizations of Gemma 4 E2B. What is compared is whether both answers say the same thing.
 * It was recorded on 2026-08-18 by running that page and asking `MEASUREMENT_PROMPT`.
 */
const TRANSFORMERS_JS_REFERENCE_ANSWER =
	'Running a language model in the browser offers instant, private, and low-latency interactions without ' +
	'needing a powerful server. This enables seamless, on-device applications for features like real-time ' +
	'translation or content summarization.';

/** How many runs are thrown away before any run is measured, on top of the bundle's own warm-up. */
const WARMUP_RUN_COUNT = 2;

/** How many runs are measured. No timing on this page comes from a single run. */
const MEASURED_RUN_COUNT = 5;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExperimentPage
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Holds the loaded model and the state of the three steps, and writes every result into the page.
 */
export class ExperimentPage {
	/** The loaded model, or `undefined` until the load step has finished. */
	#model: Gemma4Mobile | undefined = undefined;

	/** Whether every correctness check passed, which the measurement step waits for. */
	#isCorrectnessChecked = false;

	/** Whether the page was out of sight at any moment while a run was going. */
	#wasEverHidden = false;

	/** How many bytes of weights were downloaded, as the load reported them. */
	#downloadedByteCount = 0;

	/** Whether the weights came from the browser cache instead of from the network. */
	#isFromCache = false;

	/**
	 * Wires every button to its step and starts watching whether the page stays in sight.
	 *
	 * @returns Nothing.
	 */
	start(): void {
		if (navigator.gpu === undefined) {
			this._setStatus('This browser has no WebGPU. Nothing on this page can run without it.');
			this._element<HTMLButtonElement>('#load-button').disabled = true;
			return;
		}

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				this.#wasEverHidden = true;
			}
		});

		this._element<HTMLButtonElement>('#load-button').addEventListener('click', () => {
			void this._runLoadStep();
		});
		this._element<HTMLButtonElement>('#check-button').addEventListener('click', () => {
			void this._runCorrectnessCheckStep();
		});
		this._element<HTMLButtonElement>('#measure-button').addEventListener('click', () => {
			void this._runMeasurementStep();
		});

		this._element<HTMLElement>('#measurement-prompt').textContent = MEASUREMENT_PROMPT;
		this._setStatus('Ready. The first load downloads about 2.5 gigabytes of weights.');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The three steps
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Downloads the weights, writes them to a WebGPU device, and warms the compute kernels up.
	 *
	 * @returns Nothing, once the model is loaded or the load has failed.
	 */
	async _runLoadStep(): Promise<void> {
		const loadButton = this._element<HTMLButtonElement>('#load-button');
		loadButton.disabled = true;
		this.#wasEverHidden = false;
		const startedAt = performance.now();

		try {
			this._setStatus('Requesting a WebGPU device…');
			this.#model = await Gemma4Mobile.load(MODEL_ID, {
				onProgress: (event) => {
					this._reportLoadProgress(event);
				},
			});
			this._setStatus('Compiling the WebGPU compute kernels…');
			await this.#model.warmup();

			const loadSeconds = (performance.now() - startedAt) / 1000;
			this._element<HTMLElement>('#load-time').textContent = `${loadSeconds.toFixed(1)} s`;
			this._element<HTMLElement>('#downloaded-bytes').textContent =
				this.#downloadedByteCount === 0
					? 'not reported'
					: `${MeasurementStatistics.formatBytes(this.#downloadedByteCount)}${this.#isFromCache ? ' (from the browser cache)' : ''}`;
			this._element<HTMLElement>('#shader-count').textContent = String(this._countCompiledShaders());
			this._element<HTMLButtonElement>('#check-button').disabled = false;
			this._setStatus('The model is loaded. Run the correctness check before measuring anything.');
		} catch (error: unknown) {
			console.error(error);
			loadButton.disabled = false;
			this._setStatus(`The model could not be loaded: ${this._describeError(error)}`);
		}
	}

	/**
	 * Asks every question of `CORRECTNESS_CHECKS` and compares each answer against what it has to hold, then
	 * asks the measurement question once and shows its answer beside the Transformers.js answer.
	 *
	 * @returns Nothing, once every check has run.
	 */
	async _runCorrectnessCheckStep(): Promise<void> {
		const model = this.#model;
		if (model === undefined) {
			return;
		}
		const checkButton = this._element<HTMLButtonElement>('#check-button');
		checkButton.disabled = true;
		const resultList = this._element<HTMLElement>('#check-results');
		resultList.replaceChildren();

		let isEveryCheckPassed = true;
		try {
			for (const check of CORRECTNESS_CHECKS) {
				this._setStatus(`Checking: ${check.prompt}`);
				const run = await this._generateOnce(model, check.prompt, 0);
				const isPassed = run.text.toLowerCase().includes(check.requiredSubstring.toLowerCase());
				if (isPassed === false) {
					isEveryCheckPassed = false;
				}
				const item = document.createElement('li');
				item.className = isPassed ? 'check passed' : 'check failed';
				item.textContent =
					`${isPassed ? 'PASSED' : 'FAILED'} — asked “${check.prompt}”, ` +
					`wanted “${check.requiredSubstring}”, got “${run.text.trim()}”`;
				resultList.appendChild(item);
			}

			this._setStatus('Asking the measurement question once, to compare it against the Transformers.js answer…');
			const comparisonRun = await this._generateOnce(model, MEASUREMENT_PROMPT, 0);
			this._element<HTMLElement>('#webgpu-kernels-answer').textContent = comparisonRun.text.trim();
			this._element<HTMLElement>('#transformers-js-answer').textContent =
				TRANSFORMERS_JS_REFERENCE_ANSWER === ''
					? 'Not recorded yet. Run packages/_onnx_experiments/public/gemma4-e2b-it/ with the same question and write its answer into TRANSFORMERS_JS_REFERENCE_ANSWER.'
					: TRANSFORMERS_JS_REFERENCE_ANSWER;

			this.#isCorrectnessChecked = isEveryCheckPassed;
			this._element<HTMLButtonElement>('#measure-button').disabled = isEveryCheckPassed === false;
			checkButton.disabled = false;
			this._setStatus(
				isEveryCheckPassed
					? 'Every correctness check passed. The measurement can run.'
					: 'A correctness check failed. Do not measure this: WebGPU is returning wrong numbers silently.',
			);
		} catch (error: unknown) {
			console.error(error);
			checkButton.disabled = false;
			this._setStatus(`The correctness check could not finish: ${this._describeError(error)}`);
		}
	}

	/**
	 * Throws away `WARMUP_RUN_COUNT` runs, measures `MEASURED_RUN_COUNT` runs of the same question, and writes
	 * the smallest, middle, and largest figure of each measured quantity into the page.
	 *
	 * @returns Nothing, once every run has finished.
	 */
	async _runMeasurementStep(): Promise<void> {
		const model = this.#model;
		if (model === undefined || this.#isCorrectnessChecked === false) {
			return;
		}
		const measureButton = this._element<HTMLButtonElement>('#measure-button');
		measureButton.disabled = true;
		this.#wasEverHidden = document.hidden;

		try {
			for (let index = 1; index <= WARMUP_RUN_COUNT; index += 1) {
				this._setStatus(`Warm-up run ${index} of ${WARMUP_RUN_COUNT}, which is thrown away…`);
				await this._generateOnce(model, MEASUREMENT_PROMPT, 0);
			}

			const runs: GenerationRun[] = [];
			for (let index = 1; index <= MEASURED_RUN_COUNT; index += 1) {
				this._setStatus(`Measured run ${index} of ${MEASURED_RUN_COUNT}. Keep this page in sight.`);
				runs.push(await this._generateOnce(model, MEASUREMENT_PROMPT, index));
			}

			const timeToFirstToken = MeasurementStatistics.summarise(runs.map((run) => run.timeToFirstTokenMs));
			const tokensPerSecond = MeasurementStatistics.summarise(runs.map((run) => run.tokensPerSecond));
			const tokenCount = MeasurementStatistics.summarise(runs.map((run) => run.tokenCount));

			this._element<HTMLElement>('#time-to-first-token').textContent = MeasurementStatistics.format(timeToFirstToken, 'ms', 0);
			this._element<HTMLElement>('#tokens-per-second').textContent = MeasurementStatistics.format(tokensPerSecond, 'tok/s', 1);
			this._element<HTMLElement>('#token-count').textContent = MeasurementStatistics.format(tokenCount, 'tokens', 0);
			this._element<HTMLElement>('#run-count').textContent =
				`${MEASURED_RUN_COUNT} measured, ${WARMUP_RUN_COUNT} warm-up runs thrown away`;
			this._element<HTMLElement>('#page-visibility').textContent = this.#wasEverHidden
				? 'The page was out of sight during the measurement. Throw these figures away and run it again.'
				: 'The page stayed in sight for every run.';

			measureButton.disabled = false;
			this._setStatus(
				this.#wasEverHidden
					? 'The measurement finished, but the page was out of sight. The figures cannot be trusted.'
					: 'The measurement finished.',
			);
		} catch (error: unknown) {
			console.error(error);
			measureButton.disabled = false;
			this._setStatus(`The measurement could not finish: ${this._describeError(error)}`);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Empties the key/value cache and generates one answer, timing the first token apart from the rest.
	 *
	 * @param model The loaded model.
	 * @param prompt The question to ask.
	 * @param index Which measured run this is, or 0 when this run is not measured.
	 * @returns What the run generated and how long each part of it took.
	 */
	async _generateOnce(model: Gemma4Mobile, prompt: string, index: number): Promise<GenerationRun> {
		model.reset();
		const streamElement = this._element<HTMLElement>('#stream');
		streamElement.textContent = '';

		const startedAt = performance.now();
		let firstTokenAt = 0;
		let tokenCount = 0;
		let text = '';

		for await (const generated of model.generate([{ role: 'user', content: prompt }], { maxNewTokens: MAX_NEW_TOKENS })) {
			if (firstTokenAt === 0) {
				firstTokenAt = performance.now();
			}
			tokenCount += 1;
			text = generated.text;
			streamElement.textContent = text;
		}

		const endedAt = performance.now();
		if (firstTokenAt === 0) {
			throw new Error('The model generated no token at all.');
		}
		// The first token is left out of the rate: it carries the whole prompt, and counting it inside the rate
		// would mix the cost of reading the question into the cost of writing the answer.
		const decodeMs = endedAt - firstTokenAt;
		const tokensPerSecond = tokenCount > 1 ? ((tokenCount - 1) / decodeMs) * 1000 : 0;
		return {
			index,
			timeToFirstTokenMs: firstTokenAt - startedAt,
			tokenCount,
			decodeMs,
			tokensPerSecond,
			text,
		};
	}

	/**
	 * Writes one step of the load into the page.
	 *
	 * @param event The step the bundle reported.
	 * @returns Nothing.
	 */
	_reportLoadProgress(event: Gemma4MobileProgressEvent): void {
		if (event.status === 'weights' && event.kind !== 'tensors') {
			if (event.total !== undefined) {
				this.#downloadedByteCount = event.total;
			}
			if (event.fromCache === true) {
				this.#isFromCache = true;
			}
			const loaded = event.loaded === undefined ? '' : MeasurementStatistics.formatBytes(event.loaded);
			const total = event.total === undefined ? '' : MeasurementStatistics.formatBytes(event.total);
			this._setStatus(`Downloading the weights: ${loaded} of ${total}`);
			return;
		}
		if (event.status === 'weights') {
			this._setStatus(`Writing the weights to the graphics processor: ${event.loaded ?? 0} of ${event.total ?? 0} tensors`);
			return;
		}
		this._setStatus(`Loading: ${event.status}`);
	}

	/**
	 * Counts the WebGPU compute shaders the bundle has compiled on this machine's graphics processor.
	 *
	 * @returns How many compute shaders were compiled, which is 0 before the first generation has run.
	 */
	_countCompiledShaders(): number {
		return this.#model?.runtime.getRenderedShaders?.().length ?? 0;
	}

	/**
	 * Writes one line of text into the status line of the page.
	 *
	 * @param message What to write.
	 * @returns Nothing.
	 */
	_setStatus(message: string): void {
		this._element<HTMLElement>('#status').textContent = message;
	}

	/**
	 * Finds one element of the page.
	 *
	 * @param selector Which element to find.
	 * @returns The element.
	 * @throws When the page does not hold the element, because every step depends on all of them.
	 */
	_element<ElementType extends HTMLElement>(selector: string): ElementType {
		const element = document.querySelector<ElementType>(selector);
		if (element === null) {
			throw new Error(`The page must hold ${selector}.`);
		}
		return element;
	}

	/**
	 * Writes what went wrong as one line of text.
	 *
	 * @param error What was thrown.
	 * @returns The message of the error, or a stand-in when it carries none.
	 */
	_describeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
