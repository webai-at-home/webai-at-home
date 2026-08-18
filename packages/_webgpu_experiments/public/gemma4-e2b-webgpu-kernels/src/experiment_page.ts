import { Gemma4Mobile } from '../vendor/gemma-4-e2b.js';
import type { Gemma4MobileProgressEvent } from '../vendor/gemma-4-e2b.js';
import { MeasurementStatistics, type GenerationRun } from './measurement_statistics.js';
import { PageMarkup } from './page_markup.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ExperimentPage — drives the Gemma 4 E2B WebGPU compute kernel experiment page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One question whose answer is checked before anything is measured. WebGPU returns wrong numbers silently, so a
 * generation that runs to the end proves nothing on its own.
 */
export type CorrectnessCheck = {
	/** The question to ask. */
	prompt: string;
	/** Text the answer has to hold for the check to pass, compared without regard to letter case. */
	requiredSubstring: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The Hugging Face model the vendored bundle loads, shown in the page beside the prompt. */
const MODEL_ID = 'google/gemma-4-E2B-it-qat-mobile-transformers';

/** How many tokens any single answer on this page may hold at most. */
const MAX_NEW_TOKENS = 256;

/**
 * The question the prompt box holds when the page opens. It is the question the Transformers.js Gemma 4 E2B page
 * in `packages/_onnx_experiments/public/gemma4-e2b-it/` asks, so that the two pages are compared on one question.
 */
const DEFAULT_PROMPT = 'Explain in two short sentences why running a language model in the browser can be useful.';

/**
 * The questions whose answers are checked before anything is measured. Their answers are short, they are the same
 * in every runtime, and no wrong-numbers answer reaches them by chance. The bundle always takes the highest
 * scoring token, so the same question always gives the same answer.
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
 * The answer the Transformers.js Gemma 4 E2B page in `packages/_onnx_experiments/public/gemma4-e2b-it/` gave to
 * `DEFAULT_PROMPT`. It is shown beside this page's answer so that a person can see the two side by side. The two
 * answers are not word for word the same and are not meant to be: the two pages load two different quantizations
 * of Gemma 4 E2B. What is compared is whether both answers say the same thing. Recorded on 2026-08-18.
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
 * Builds the page, starts the model downloading as soon as the page opens, and drives the single run, the
 * correctness check, and the measurement.
 */
export class ExperimentPage {
	/** The loaded model, or `undefined` until the load has finished. */
	#model: Gemma4Mobile | undefined = undefined;

	/** The load, kept so that a second caller waits for the first one instead of starting a second load. */
	#loadPromise: Promise<Gemma4Mobile> | undefined = undefined;

	/** Whether the page was out of sight at any moment while the measurement was going. */
	#wasEverHidden = false;

	/** Whether a generation is going, so that no second one is started on top of it. */
	#isGenerating = false;

	/**
	 * Writes the page, wires every button, and starts the model downloading straight away.
	 *
	 * @returns Nothing.
	 */
	start(): void {
		const app = document.querySelector<HTMLElement>('#app');
		if (app === null) {
			throw new Error('The page must hold #app.');
		}
		app.innerHTML = PageMarkup.build(MODEL_ID, DEFAULT_PROMPT, WARMUP_RUN_COUNT, MEASURED_RUN_COUNT);

		const isWebgpuPresent = navigator.gpu !== undefined;
		this._element<HTMLElement>('#runtime-label').textContent = isWebgpuPresent ? 'WebGPU available' : 'WebGPU absent';
		this._element<HTMLElement>('#backend').textContent = isWebgpuPresent ? 'WebGPU' : 'none';
		if (isWebgpuPresent === false) {
			this._element<HTMLElement>('#runtime-pill').classList.add('absent');
			this._setRunButton('WebGPU is absent', false, true);
			this._setStatus('This browser has no WebGPU. Nothing on this page can run without it.');
			return;
		}

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				this.#wasEverHidden = true;
			}
		});

		this._element<HTMLButtonElement>('#run-button').addEventListener('click', () => {
			void this._runInference();
		});
		this._element<HTMLButtonElement>('#check-button').addEventListener('click', () => {
			void this._runCorrectnessCheck();
		});
		this._element<HTMLButtonElement>('#measure-button').addEventListener('click', () => {
			void this._runMeasurement();
		});

		// The weights start downloading as soon as the page opens, the same way the Transformers.js experiment
		// does it. The first load moves about 2.5 gigabytes, so waiting for a button press wastes that time.
		void this._loadModel().catch((error: unknown) => {
			console.error(error);
			this._setStatus(`Unable to load Gemma 4 E2B: ${this._describeError(error)}`);
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Loading
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Downloads the weights, writes them to a WebGPU device, and compiles the compute kernels. A second caller
	 * waits for the first load instead of starting another one.
	 *
	 * @returns The loaded model.
	 */
	async _loadModel(): Promise<Gemma4Mobile> {
		if (this.#model !== undefined) {
			return this.#model;
		}
		if (this.#loadPromise !== undefined) {
			return this.#loadPromise;
		}

		this._setStatus('Requesting a WebGPU device…');
		const startedAt = performance.now();
		this.#loadPromise = (async () => {
			const model = await Gemma4Mobile.load(null, {
				onProgress: (event) => {
					this._reportLoadProgress(event);
				},
			});
			this._setStatus('Compiling the WebGPU compute kernels…');
			await model.warmup();
			return model;
		})();

		try {
			const model = await this.#loadPromise;
			this.#model = model;
			const loadSeconds = (performance.now() - startedAt) / 1000;
			this._element<HTMLElement>('#load-time').textContent = `${loadSeconds.toFixed(1)} s`;
			this._setRunButton('Run inference', true, false);
			this._element<HTMLButtonElement>('#check-button').disabled = false;
			this._setStatus(
				`Model ready in ${loadSeconds.toFixed(1)} s, with ${this._countCompiledShaders()} compute shaders ` +
					'compiled. Run the correctness check before trusting any figure.',
			);
			return model;
		} catch (error: unknown) {
			this.#loadPromise = undefined;
			this._setRunButton('Load the model', true, false);
			throw error;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The three things the page does
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Answers the question in the prompt box once, streaming the answer into the page, and reports how long that
	 * one run took. One run is a demonstration, not a measurement: the figures that count come from the
	 * measurement panel, which runs the same question several times.
	 *
	 * @returns Nothing, once the run has finished or has failed.
	 */
	async _runInference(): Promise<void> {
		if (this.#isGenerating) {
			return;
		}
		this._setRunButton('Working…', false, true);
		const output = this._element<HTMLElement>('#output');
		output.classList.remove('placeholder');
		output.textContent = '';

		try {
			const model = await this._loadModel();
			this._setStatus('Running one generation…');
			const prompt = this._element<HTMLTextAreaElement>('#prompt').value;
			const run = await this._generateOnce(model, prompt, output);

			this._element<HTMLElement>('#generation-time').textContent = `${((run.timeToFirstTokenMs + run.decodeMs) / 1000).toFixed(2)} s`;
			this._element<HTMLElement>('#speed').textContent = `${run.tokensPerSecond.toFixed(1)} tok/s`;
			this._setStatus(
				`One run: ${run.tokenCount} tokens, first token after ${run.timeToFirstTokenMs.toFixed(0)} ms. ` +
					'One run is a demonstration, not a measurement — use the measurement panel below.',
			);
		} catch (error: unknown) {
			console.error(error);
			output.textContent = 'The run could not finish. Look in the browser console for what went wrong.';
			this._setStatus(`Error: ${this._describeError(error)}`);
		} finally {
			this._setRunButton('Run inference again', true, false);
		}
	}

	/**
	 * Asks every question of `CORRECTNESS_CHECKS` and compares each answer against what it has to hold, then asks
	 * the default question once and shows its answer beside the Transformers.js answer to the same question.
	 *
	 * @returns Nothing, once every check has run.
	 */
	async _runCorrectnessCheck(): Promise<void> {
		if (this.#isGenerating) {
			return;
		}
		const checkButton = this._element<HTMLButtonElement>('#check-button');
		checkButton.disabled = true;
		const resultList = this._element<HTMLElement>('#check-results');
		resultList.replaceChildren();

		try {
			const model = await this._loadModel();
			let isEveryCheckPassed = true;
			for (const check of CORRECTNESS_CHECKS) {
				this._setStatus(`Checking: ${check.prompt}`);
				const run = await this._generateOnce(model, check.prompt, undefined);
				const isPassed = run.text.toLowerCase().includes(check.requiredSubstring.toLowerCase());
				if (isPassed === false) {
					isEveryCheckPassed = false;
				}
				resultList.appendChild(this._buildCheckResult(check, run.text.trim(), isPassed));
			}

			this._setStatus('Asking the default question once, to put its answer beside the Transformers.js answer…');
			const comparisonRun = await this._generateOnce(model, DEFAULT_PROMPT, undefined);
			const ourAnswer = this._element<HTMLElement>('#webgpu-kernels-answer');
			const referenceAnswer = this._element<HTMLElement>('#transformers-js-answer');
			ourAnswer.classList.remove('placeholder');
			referenceAnswer.classList.remove('placeholder');
			ourAnswer.textContent = comparisonRun.text.trim();
			referenceAnswer.textContent = TRANSFORMERS_JS_REFERENCE_ANSWER;

			this._element<HTMLButtonElement>('#measure-button').disabled = isEveryCheckPassed === false;
			this._setStatus(
				isEveryCheckPassed
					? 'Every correctness check passed. The measurement can run.'
					: 'A correctness check failed. Do not measure this: WebGPU is returning wrong numbers silently.',
			);
		} catch (error: unknown) {
			console.error(error);
			this._setStatus(`The correctness check could not finish: ${this._describeError(error)}`);
		} finally {
			checkButton.disabled = false;
		}
	}

	/**
	 * Throws `WARMUP_RUN_COUNT` runs away, measures `MEASURED_RUN_COUNT` runs of the question in the prompt box,
	 * and writes the middle figure of each measured quantity with the range beside it.
	 *
	 * @returns Nothing, once every run has finished.
	 */
	async _runMeasurement(): Promise<void> {
		if (this.#isGenerating) {
			return;
		}
		const measureButton = this._element<HTMLButtonElement>('#measure-button');
		measureButton.disabled = true;
		this.#wasEverHidden = document.hidden;
		const prompt = this._element<HTMLTextAreaElement>('#prompt').value;
		const output = this._element<HTMLElement>('#output');
		output.classList.remove('placeholder');

		try {
			const model = await this._loadModel();
			for (let index = 1; index <= WARMUP_RUN_COUNT; index += 1) {
				this._setStatus(`Warm-up run ${index} of ${WARMUP_RUN_COUNT}, which is thrown away…`);
				await this._generateOnce(model, prompt, output);
			}

			const runs: GenerationRun[] = [];
			for (let index = 1; index <= MEASURED_RUN_COUNT; index += 1) {
				this._setStatus(`Measured run ${index} of ${MEASURED_RUN_COUNT}. Keep this page in sight.`);
				runs.push(await this._generateOnce(model, prompt, output, index));
			}

			const timeToFirstToken = MeasurementStatistics.summarise(runs.map((run) => run.timeToFirstTokenMs));
			const tokensPerSecond = MeasurementStatistics.summarise(runs.map((run) => run.tokensPerSecond));
			const tokenCount = MeasurementStatistics.summarise(runs.map((run) => run.tokenCount));
			this._element<HTMLElement>('#time-to-first-token').textContent = MeasurementStatistics.format(timeToFirstToken, 'ms', 0);
			this._element<HTMLElement>('#tokens-per-second').textContent = MeasurementStatistics.format(tokensPerSecond, 'tok/s', 1);
			this._element<HTMLElement>('#token-count').textContent = MeasurementStatistics.format(tokenCount, 'tokens', 0);
			this._element<HTMLElement>('#run-count').textContent = `${MEASURED_RUN_COUNT} measured, ${WARMUP_RUN_COUNT} thrown away`;
			this._reportMeasurementTrust(prompt);
			this._setStatus(this.#wasEverHidden ? 'The measurement finished, but the page was out of sight.' : 'The measurement finished.');
		} catch (error: unknown) {
			console.error(error);
			this._setStatus(`The measurement could not finish: ${this._describeError(error)}`);
		} finally {
			measureButton.disabled = false;
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
	 * @param streamInto Where to stream the answer as it arrives, or `undefined` to stream it nowhere.
	 * @param index Which measured run this is, or 0 when this run is not measured.
	 * @returns What the run generated and how long each part of it took.
	 */
	async _generateOnce(
		model: Gemma4Mobile,
		prompt: string,
		streamInto: HTMLElement | undefined,
		index = 0,
	): Promise<GenerationRun> {
		this.#isGenerating = true;
		try {
			model.reset();
			if (streamInto !== undefined) {
				streamInto.textContent = '';
			}

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
				if (streamInto !== undefined) {
					streamInto.textContent = text;
				}
			}

			const endedAt = performance.now();
			if (firstTokenAt === 0) {
				throw new Error('The model generated no token at all.');
			}
			// The first token is left out of the rate: it carries the whole question, and counting it inside the
			// rate would mix the cost of reading the question into the cost of writing the answer.
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
		} finally {
			this.#isGenerating = false;
		}
	}

	/**
	 * Builds one line of the correctness check list.
	 *
	 * @param check The question that was asked and what its answer had to hold.
	 * @param answer What the model answered.
	 * @param isPassed Whether the answer held what it had to hold.
	 * @returns The list item, ready to be added to the list.
	 */
	_buildCheckResult(check: CorrectnessCheck, answer: string, isPassed: boolean): HTMLLIElement {
		const item = document.createElement('li');
		item.className = isPassed ? 'check passed' : 'check failed';
		const label = document.createElement('b');
		label.textContent = isPassed ? 'Passed' : 'Failed';
		item.appendChild(label);
		item.appendChild(
			document.createTextNode(`Asked “${check.prompt}” · wanted “${check.requiredSubstring}” · got “${answer}”`),
		);
		return item;
	}

	/**
	 * Says whether the figures just measured can be trusted, and why not when they cannot.
	 *
	 * @param prompt The question the measured runs asked.
	 * @returns Nothing.
	 */
	_reportMeasurementTrust(prompt: string): void {
		const visibility = this._element<HTMLElement>('#page-visibility');
		const reasons: string[] = [];
		if (this.#wasEverHidden) {
			reasons.push(
				'The page was out of sight during the measurement. Reading a hidden page lifts the slowdown Google ' +
					'Chrome puts on it, which has moved figures by a factor of five. Throw these figures away and run ' +
					'the measurement again with this page in sight.',
			);
		}
		if (prompt !== DEFAULT_PROMPT) {
			reasons.push(
				'The question was changed, so these figures cannot be put beside the recorded figures of the other ' +
					'runtimes, which all asked the default question.',
			);
		}
		visibility.className = reasons.length === 0 ? 'warning clear' : 'warning';
		visibility.textContent =
			reasons.length === 0
				? 'The page stayed in sight for every run, and the default question was asked. These figures count.'
				: reasons.join(' ');
	}

	/**
	 * Writes one step of the load into the status line.
	 *
	 * @param event The step the bundle reported.
	 * @returns Nothing.
	 */
	_reportLoadProgress(event: Gemma4MobileProgressEvent): void {
		if (event.status === 'weights' && event.kind !== 'tensors') {
			const loaded = event.loaded === undefined ? '' : MeasurementStatistics.formatBytes(event.loaded);
			const total = event.total === undefined ? '' : MeasurementStatistics.formatBytes(event.total);
			const source = event.fromCache === true ? 'from the browser cache' : 'from Hugging Face';
			this._setStatus(`Downloading the weights ${source}: ${loaded} of ${total}`);
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
	 * @returns How many compute shaders were compiled.
	 */
	_countCompiledShaders(): number {
		return this.#model?.runtime.getRenderedShaders?.().length ?? 0;
	}

	/**
	 * Writes the label of the run button, and says whether it can be pressed.
	 *
	 * @param label What the button says.
	 * @param isEnabled Whether the button can be pressed.
	 * @param isSpinning Whether a spinner is drawn beside the label.
	 * @returns Nothing.
	 */
	_setRunButton(label: string, isEnabled: boolean, isSpinning: boolean): void {
		const button = this._element<HTMLButtonElement>('#run-button');
		button.disabled = isEnabled === false;
		button.replaceChildren(document.createTextNode(`${label} `));
		const marker = document.createElement('span');
		marker.className = isSpinning ? 'spinner' : '';
		marker.textContent = isSpinning ? '' : '↗';
		button.appendChild(marker);
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
