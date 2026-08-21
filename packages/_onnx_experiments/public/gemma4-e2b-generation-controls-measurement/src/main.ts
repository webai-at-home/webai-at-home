import { pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { ControlledGeneration, type GenerationRecord, type GenerationRequest } from './controlled_generation';
import { IndexedDbModelCache } from './indexed_db_model_cache';
import { MeasurementPrompts } from './measurement_prompts';
import { WebgpuRequirement } from './webgpu_requirement';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generation controls measurement for issue #222, milestone 0, Gemma 4 E2B
//
//	`task_type_llm_gemma_4_e2b_full` honours no generation control. Its row in
//	`packages/protocol/src/task/generation_control_support.ts` is `[]`, and it is empty on purpose: that
//	table holds what a live run observed and nothing else, and nothing about this model has been
//	measured. This page is that measurement, and only that measurement.
//
//	The one assumption that would make issue #222 impossible is that this model, in a real browser tab
//	on WebGPU, acts differently when a control is asked for — and does so through
//	`pipeline('text-generation', …)` of `@huggingface/transformers` 4.2.0, which is what
//	`stage_helper_llm_gemma_4_e2b_full.ts` drives. Each of the five controls gets a phase, and each
//	phase generates rather than reads documentation.
//
//	The neighbouring rows of that table are not evidence about this model. Issue #196 found that
//	`@huggingface/transformers` ignores `top_p` and offers no seed, on Qwen3.5-0.8B and Llama 3.2 1B.
//	If that holds here, this measurement enters three controls and not five — but it has to be
//	measured, because the warning written beside the empty row says that copying a neighbouring row
//	"would be a claim about the library standing in for a claim about the model".
//
//	Every phase prints its raw input and its raw output, character for character, before it says what
//	the run means.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts,
// so this measurement is of the model configuration the real stage runs, not of a stand-in.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const MODEL_DTYPE = 'q4f16';

/**
 * The token limit the sampling phases run under.
 *
 * `stage_helper_llm_gemma_4_e2b_full.ts` uses 1024. This page uses far less, because the sampling phases repeat one
 * question six or nine times and the question they repeat has no natural end. Two answers that are going to differ
 * differ in their first few tokens, so a longer limit would buy nothing and cost minutes of a volunteer's graphics
 * processor.
 */
const SAMPLING_MAX_NEW_TOKENS = 48;

/**
 * The token limit the phases with a known short answer run under, which are the counting prompt and the settled
 * question.
 */
const SETTLED_MAX_NEW_TOKENS = 32;

/**
 * How many times a sampling phase repeats one setting.
 *
 * Three is what the issue asks for. One run says nothing about sampling, because one sample of a distribution and one
 * greedy answer look exactly alike.
 */
const RUNS_PER_SETTING = 3;

/**
 * The temperature the sampling phases ask for when they want the model to wander.
 *
 * High enough that a model reading it would visibly write something else, which is what makes "the answers are all
 * the same" a finding rather than an accident of a temperature too close to greedy.
 */
const HIGH_TEMPERATURE = 1.6;

const buttonElement = document.querySelector<HTMLButtonElement>('#run-button');
const outputElement = document.querySelector<HTMLElement>('#output');
if (buttonElement === null || outputElement === null) {
	throw new Error('The page must contain #run-button and #output.');
}
// Re-bound to a definitely-non-null type, for the same reason the response constraint measurement does it: the
// closures below are declared later in this module and TypeScript does not carry the null check into them.
const button: HTMLButtonElement = buttonElement;
const output: HTMLElement = outputElement;

const isIndexedDbCacheInstalled = IndexedDbModelCache.install();

/** Every line written to the page, kept so the whole record of a run can be read back out in one piece. */
const loggedLines: string[] = [];
(globalThis as unknown as { measurementLoggedLines: string[] }).measurementLoggedLines = loggedLines;

/**
 * The whole measurement, phase by phase.
 *
 * One phase per control, plus the phase that decides whether sampling may be turned on for a request that asked for
 * no temperature, plus the phase that adds up what the whole measurement cost. Every phase generates on the same
 * loaded pipeline, so the only thing that changes between two answers is the control under measurement.
 */
export class GenerationControlsMeasurement {
	/** The loaded pipeline, once something has asked for it. */
	private static generatorPromise: Promise<TextGenerationPipeline> | undefined = undefined;

	/** Every record every phase produced, kept so the last phase can add up what the measurement cost. */
	private static readonly everyRecord: GenerationRecord[] = [];

	/**
	 * Runs every phase, in order.
	 *
	 * @returns Nothing. Everything the run found is written to the page.
	 */
	static async run(): Promise<void> {
		GenerationControlsMeasurement.everyRecord.length = 0;
		const generator = await GenerationControlsMeasurement.phase1RunsOnWebgpu();
		const highTemperatureRecords = await GenerationControlsMeasurement.phase2Temperature(generator);
		await GenerationControlsMeasurement.phase3TopP(generator, highTemperatureRecords);
		await GenerationControlsMeasurement.phase4MaximumOutputTokenCount(generator);
		await GenerationControlsMeasurement.phase5StopSequences(generator);
		await GenerationControlsMeasurement.phase6RandomSeed(generator);
		await GenerationControlsMeasurement.phase7SamplingWithoutATemperature(generator);
		GenerationControlsMeasurement.phase8WhatTheMeasurementCost();
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log(
			'Every phase has run. Read the raw text above before believing any verdict.',
			'phase',
		);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Phase 1 — WebGPU or nothing.
	 *
	 * Read before the model is asked for, and confirmed again after it has loaded, because ONNX Runtime Web can
	 * accept `webgpu`, fail to start it, and carry on from WebAssembly with only a console warning.
	 *
	 * @returns The loaded pipeline.
	 */
	private static async phase1RunsOnWebgpu(): Promise<TextGenerationPipeline> {
		GenerationControlsMeasurement.log('Phase 1 — is this really running on WebGPU?', 'phase');
		WebgpuRequirement.watchForADroppedProvider();
		const adapterReport = await WebgpuRequirement.demandWebgpu();
		GenerationControlsMeasurement.log(
			`  adapter: vendor=${JSON.stringify(adapterReport.vendor)}, `
			+ `architecture=${JSON.stringify(adapterReport.architecture)}, `
			+ `description=${JSON.stringify(adapterReport.description)}`,
		);
		GenerationControlsMeasurement.log(
			`  adapter supports shader-f16 = ${adapterReport.isRequiredFeatureSupported}`,
			adapterReport.isRequiredFeatureSupported ? 'pass' : 'fail',
		);
		GenerationControlsMeasurement.log(`  IndexedDB model cache installed = ${isIndexedDbCacheInstalled}`);
		GenerationControlsMeasurement.log(`  model = ${MODEL_ID} at ${MODEL_REVISION}, ${MODEL_DTYPE}`);
		GenerationControlsMeasurement.log('  loading the model…');
		const generator = await GenerationControlsMeasurement.loadedGenerator();
		GenerationControlsMeasurement.log(`  model loaded. tokenizer = ${generator.tokenizer.constructor.name}`);
		const backendVerdict = await WebgpuRequirement.verdictAfterLoading();
		GenerationControlsMeasurement.log(`  ${backendVerdict.explanation}`, backendVerdict.isWebgpu ? 'pass' : 'fail');
		for (const warning of backendVerdict.droppedProviderWarnings) {
			GenerationControlsMeasurement.log(`  dropped provider warning: ${warning}`, 'fail');
		}
		return generator;
	}

	/**
	 * Phase 2 — does this model act on `temperature`?
	 *
	 * The same prompt three times at `temperature: 0` and three times at a high temperature, with `do_sample: true`
	 * both times. Three identical answers against three different ones is what honouring looks like. Three identical
	 * answers in both is not, and neither is three different answers in both.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns The three records generated at the high temperature, so the phase measuring `top_p` compares against
	 * runs it did not have to generate again.
	 */
	private static async phase2Temperature(generator: TextGenerationPipeline): Promise<GenerationRecord[]> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 2 — does this model act on temperature?', 'phase');
		GenerationControlsMeasurement.log(`  prompt: ${JSON.stringify(MeasurementPrompts.OPEN_ENDED)}`);

		const coldRecords = await GenerationControlsMeasurement.runSet(generator, 'temperature 0', {
			...ControlledGeneration.greedyRequest(MeasurementPrompts.OPEN_ENDED, SAMPLING_MAX_NEW_TOKENS),
			isSamplingEnabled: true,
			temperature: 0,
		});
		const hotRecords = await GenerationControlsMeasurement.runSet(generator, `temperature ${HIGH_TEMPERATURE}`, {
			...ControlledGeneration.greedyRequest(MeasurementPrompts.OPEN_ENDED, SAMPLING_MAX_NEW_TOKENS),
			isSamplingEnabled: true,
			temperature: HIGH_TEMPERATURE,
		});

		const coldDistinct = GenerationControlsMeasurement.distinctAnswerCountOf(coldRecords);
		const hotDistinct = GenerationControlsMeasurement.distinctAnswerCountOf(hotRecords);
		GenerationControlsMeasurement.log(`  distinct answers at temperature 0: ${coldDistinct} of ${coldRecords.length}`);
		GenerationControlsMeasurement.log(
			`  distinct answers at temperature ${HIGH_TEMPERATURE}: ${hotDistinct} of ${hotRecords.length}`,
		);
		const isActedOn = coldDistinct === 1 && hotDistinct > 1;
		GenerationControlsMeasurement.log(
			`  temperature acted on = ${isActedOn}`,
			isActedOn ? 'pass' : 'fail',
		);
		return hotRecords;
	}

	/**
	 * Phase 3 — does this model act on `top_p`?
	 *
	 * Three settings at the same high temperature: the temperature alone, `top_p: 0.01` beside it, and `top_p: 0.01`
	 * with `top_k: 0` beside it. The third setting is the one that matters, because `@huggingface/transformers`
	 * filters to the 50 highest scoring tokens of its own accord, and a `top_p` measured through that filter is
	 * measured through something else's narrowing. `top_p: 0.01` is narrow enough that its answers should read as
	 * greedy ones if it is read at all.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param highTemperatureRecords The runs phase 2 already generated at the same temperature with no `top_p`.
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static async phase3TopP(
		generator: TextGenerationPipeline,
		highTemperatureRecords: readonly GenerationRecord[],
	): Promise<void> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 3 — does this model act on top_p?', 'phase');
		GenerationControlsMeasurement.log(
			`  the ${highTemperatureRecords.length} runs at temperature ${HIGH_TEMPERATURE} with no top_p are `
			+ 'phase 2\'s, generated once and read twice.',
		);

		const withTopP = await GenerationControlsMeasurement.runSet(
			generator,
			`temperature ${HIGH_TEMPERATURE}, top_p 0.01`,
			{
				...ControlledGeneration.greedyRequest(MeasurementPrompts.OPEN_ENDED, SAMPLING_MAX_NEW_TOKENS),
				isSamplingEnabled: true,
				temperature: HIGH_TEMPERATURE,
				topP: 0.01,
			},
		);
		const withTopPAndTopK = await GenerationControlsMeasurement.runSet(
			generator,
			`temperature ${HIGH_TEMPERATURE}, top_p 0.01, top_k 0`,
			{
				...ControlledGeneration.greedyRequest(MeasurementPrompts.OPEN_ENDED, SAMPLING_MAX_NEW_TOKENS),
				isSamplingEnabled: true,
				temperature: HIGH_TEMPERATURE,
				topP: 0.01,
				topK: 0,
			},
		);

		const withoutDistinct = GenerationControlsMeasurement.distinctAnswerCountOf(highTemperatureRecords);
		const withDistinct = GenerationControlsMeasurement.distinctAnswerCountOf(withTopP);
		const withBothDistinct = GenerationControlsMeasurement.distinctAnswerCountOf(withTopPAndTopK);
		GenerationControlsMeasurement.log(`  distinct answers with no top_p: ${withoutDistinct}`);
		GenerationControlsMeasurement.log(`  distinct answers with top_p 0.01: ${withDistinct}`);
		GenerationControlsMeasurement.log(`  distinct answers with top_p 0.01 and top_k 0: ${withBothDistinct}`);
		const isActedOn = withBothDistinct < withoutDistinct;
		GenerationControlsMeasurement.log(
			`  top_p narrowed the answers = ${isActedOn}`,
			isActedOn ? 'pass' : 'fail',
		);
		GenerationControlsMeasurement.log(
			'  A top_p of 0.01 that narrows nothing while top_k 0 turns the answers to noise is the library ignoring '
			+ 'top_p, which is what issue #196 found on two other models.',
		);
	}

	/**
	 * Phase 4 — does this model act on a maximum output token count?
	 *
	 * Two runs of the counting prompt at two limits. The answer's length is the measurement, and the stop reason a
	 * consumer would be told is read off whether the run reached its limit.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static async phase4MaximumOutputTokenCount(generator: TextGenerationPipeline): Promise<void> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 4 — does this model act on a maximum output token count?', 'phase');
		GenerationControlsMeasurement.log(`  prompt: ${JSON.stringify(MeasurementPrompts.COUNTING)}`);

		const shortRecord = await GenerationControlsMeasurement.runOnce(
			generator,
			'max_new_tokens 8',
			ControlledGeneration.greedyRequest(MeasurementPrompts.COUNTING, 8),
		);
		const longRecord = await GenerationControlsMeasurement.runOnce(
			generator,
			`max_new_tokens ${SETTLED_MAX_NEW_TOKENS}`,
			ControlledGeneration.greedyRequest(MeasurementPrompts.COUNTING, SETTLED_MAX_NEW_TOKENS),
		);

		const isActedOn = shortRecord.generatedTokenCount <= 8
			&& shortRecord.generatedTokenCount < longRecord.generatedTokenCount;
		GenerationControlsMeasurement.log(
			`  8 tokens asked for, ${shortRecord.generatedTokenCount} generated; `
			+ `${SETTLED_MAX_NEW_TOKENS} asked for, ${longRecord.generatedTokenCount} generated`,
		);
		GenerationControlsMeasurement.log(
			`  the token limit acted on = ${isActedOn}`,
			isActedOn ? 'pass' : 'fail',
		);
	}

	/**
	 * Phase 5 — can a stop sequence be kept on this model?
	 *
	 * The pipeline call takes no stop sequence option, so this is a question about `StopSequenceWatcher` applied to
	 * the generated text, exactly as `stage_helper_llm_qwen3_5_0_8b_full.ts` applies it. The counting prompt is
	 * generated twice: once asking for nothing, and once asking to stop at a character the model is certain to
	 * write. The answer a consumer would receive is what is compared, because that is what the control promises.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static async phase5StopSequences(generator: TextGenerationPipeline): Promise<void> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 5 — can a stop sequence be kept on this model?', 'phase');
		GenerationControlsMeasurement.log(`  prompt: ${JSON.stringify(MeasurementPrompts.COUNTING)}`);

		const withoutStop = await GenerationControlsMeasurement.runOnce(
			generator,
			'no stop sequence',
			ControlledGeneration.greedyRequest(MeasurementPrompts.COUNTING, SETTLED_MAX_NEW_TOKENS),
		);
		const withStop = await GenerationControlsMeasurement.runOnce(
			generator,
			'stop sequence "5"',
			{
				...ControlledGeneration.greedyRequest(MeasurementPrompts.COUNTING, SETTLED_MAX_NEW_TOKENS),
				stopSequences: ['5'],
			},
		);

		const isActedOn = withStop.hasStoppedOnStopSequence === true
			&& withStop.forwardedText.includes('5') === false
			&& withoutStop.forwardedText.includes('5') === true;
		GenerationControlsMeasurement.log(
			`  the answer a consumer would receive, with no stop sequence: ${JSON.stringify(withoutStop.forwardedText)}`,
		);
		GenerationControlsMeasurement.log(
			`  the answer a consumer would receive, stopping at "5": ${JSON.stringify(withStop.forwardedText)}`,
		);
		GenerationControlsMeasurement.log(
			`  generation was stopped by the watcher = ${withStop.hasStoppedOnStopSequence}, `
			+ `after ${withStop.generatedTokenCount} tokens against ${withoutStop.generatedTokenCount}`,
		);
		GenerationControlsMeasurement.log(
			`  the stop sequence was kept, and never forwarded = ${isActedOn}`,
			isActedOn ? 'pass' : 'fail',
		);
	}

	/**
	 * Phase 6 — is there any seed to give at all through this pipeline call?
	 *
	 * Asked in two ways, because a library that ignores an option it does not know accepts a seed exactly as a
	 * library that reads one does. First the loaded generation configuration is read for an option whose name
	 * mentions a seed. Then a seed is passed twice at the same high temperature: two identical answers would mean
	 * something read it, and two different ones mean nothing did.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static async phase6RandomSeed(generator: TextGenerationPipeline): Promise<void> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 6 — is there any seed to give at all?', 'phase');

		const generationConfig = (generator.model as unknown as { generation_config?: object }).generation_config;
		const optionNames = generationConfig === undefined ? [] : Object.keys(generationConfig);
		const seedNames = optionNames.filter((optionName) => optionName.toLowerCase().includes('seed'));
		GenerationControlsMeasurement.log(`  the loaded generation configuration carries ${optionNames.length} options`);
		GenerationControlsMeasurement.log(
			`  options whose name mentions a seed: ${seedNames.length === 0 ? 'none' : JSON.stringify(seedNames)}`,
			seedNames.length === 0 ? 'fail' : 'pass',
		);

		const seededRecords = await GenerationControlsMeasurement.runSet(
			generator,
			`temperature ${HIGH_TEMPERATURE}, seed 42`,
			{
				...ControlledGeneration.greedyRequest(MeasurementPrompts.OPEN_ENDED, SAMPLING_MAX_NEW_TOKENS),
				isSamplingEnabled: true,
				temperature: HIGH_TEMPERATURE,
				probedOptions: { seed: 42 },
			},
			2,
		);
		const distinct = GenerationControlsMeasurement.distinctAnswerCountOf(seededRecords);
		const isActedOn = distinct === 1;
		GenerationControlsMeasurement.log(`  distinct answers under the same seed: ${distinct} of ${seededRecords.length}`);
		GenerationControlsMeasurement.log(
			`  a seed acted on = ${isActedOn}`,
			isActedOn ? 'pass' : 'fail',
		);
	}

	/**
	 * Phase 7 — does turning `do_sample` on change an answer that asked for no temperature?
	 *
	 * This decides how milestone 1 is allowed to write the call. `stage_helper_llm_qwen3_5_0_8b_full.ts` turns
	 * sampling on only for a request that asked for a temperature, and the reason is here: a request that asked for
	 * nothing must generate byte for byte the answer it generates today. The settled question is generated greedily
	 * twice first, because two greedy runs that already differ would make the third run unreadable.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static async phase7SamplingWithoutATemperature(generator: TextGenerationPipeline): Promise<void> {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log(
			'Phase 7 — does turning do_sample on change an answer that asked for no temperature?',
			'phase',
		);
		GenerationControlsMeasurement.log(`  prompt: ${JSON.stringify(MeasurementPrompts.SETTLED)}`);

		const greedyRecords = await GenerationControlsMeasurement.runSet(
			generator,
			'do_sample false, the call this stage makes today',
			ControlledGeneration.greedyRequest(MeasurementPrompts.SETTLED, SETTLED_MAX_NEW_TOKENS),
			2,
		);
		const sampledRecords = await GenerationControlsMeasurement.runSet(
			generator,
			'do_sample true, no temperature',
			{
				...ControlledGeneration.greedyRequest(MeasurementPrompts.SETTLED, SETTLED_MAX_NEW_TOKENS),
				isSamplingEnabled: true,
			},
			2,
		);

		const isGreedyRepeatable = GenerationControlsMeasurement.distinctAnswerCountOf(greedyRecords) === 1;
		const isUnchangedBySampling = greedyRecords[0].strippedText === sampledRecords[0].strippedText
			&& GenerationControlsMeasurement.distinctAnswerCountOf(sampledRecords) === 1;
		GenerationControlsMeasurement.log(
			`  the greedy call answers the same way twice = ${isGreedyRepeatable}`,
			isGreedyRepeatable ? 'pass' : 'fail',
		);
		GenerationControlsMeasurement.log(
			`  turning do_sample on left the answer unchanged = ${isUnchangedBySampling}`,
			isUnchangedBySampling ? 'pass' : 'fail',
		);
		GenerationControlsMeasurement.log(
			'  An answer changed by do_sample alone is why milestone 1 turns sampling on only for a request that asked '
			+ 'for a temperature. An answer unchanged by it leaves that free either way.',
		);
	}

	/**
	 * Phase 8 — what this measurement cost.
	 *
	 * The issue asks for the cost of each measurement in tokens and milliseconds, because a control honoured at a
	 * price a volunteer's browser tab cannot pay is not honoured. Read off the records every phase already produced,
	 * so nothing is generated for this phase.
	 *
	 * @returns Nothing. Everything the phase found is written to the page.
	 */
	private static phase8WhatTheMeasurementCost(): void {
		GenerationControlsMeasurement.log('');
		GenerationControlsMeasurement.log('Phase 8 — what this measurement cost', 'phase');
		const records = GenerationControlsMeasurement.everyRecord;
		const totalTokens = records.reduce((sum, record) => sum + record.generatedTokenCount, 0);
		const totalMs = records.reduce((sum, record) => sum + record.wallMs, 0);
		const failedCount = records.filter((record) => record.error !== undefined).length;
		GenerationControlsMeasurement.log(`  runs: ${records.length}, of which ${failedCount} threw`);
		GenerationControlsMeasurement.log(`  tokens generated: ${totalTokens}`);
		GenerationControlsMeasurement.log(`  generation wall time: ${(totalMs / 1000).toFixed(1)} s`);
		if (totalMs > 0) {
			GenerationControlsMeasurement.log(
				`  average generation speed: ${(totalTokens / (totalMs / 1000)).toFixed(1)} tokens per second`,
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one request several times, printing every answer as it arrives.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param settingName What this set of runs asked for, printed above them.
	 * @param request The request to repeat.
	 * @param runCount How many times to repeat it, defaulting to {@link RUNS_PER_SETTING}.
	 * @returns Every record, in the order the runs happened.
	 */
	private static async runSet(
		generator: TextGenerationPipeline,
		settingName: string,
		request: GenerationRequest,
		runCount: number = RUNS_PER_SETTING,
	): Promise<GenerationRecord[]> {
		GenerationControlsMeasurement.log(`  ${settingName} — ${ControlledGeneration.describe(request)}`);
		const records: GenerationRecord[] = [];
		for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
			const record = await ControlledGeneration.run(generator, request);
			GenerationControlsMeasurement.everyRecord.push(record);
			GenerationControlsMeasurement.reportRecord(`run ${runIndex + 1}`, record);
			records.push(record);
		}
		return records;
	}

	/**
	 * Runs one request once, printing the answer.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param settingName What this run asked for, printed above it.
	 * @param request The request to run.
	 * @returns The record of the run.
	 */
	private static async runOnce(
		generator: TextGenerationPipeline,
		settingName: string,
		request: GenerationRequest,
	): Promise<GenerationRecord> {
		GenerationControlsMeasurement.log(`  ${settingName} — ${ControlledGeneration.describe(request)}`);
		const record = await ControlledGeneration.run(generator, request);
		GenerationControlsMeasurement.everyRecord.push(record);
		GenerationControlsMeasurement.reportRecord('run 1', record);
		return record;
	}

	/**
	 * Prints everything one generation produced.
	 *
	 * The answer is printed with `JSON.stringify`, so every space and every line break the model wrote is visible on
	 * the page rather than swallowed by the markup.
	 *
	 * @param runName What to call this run in the printed line.
	 * @param record The record of the run.
	 * @returns Nothing.
	 */
	private static reportRecord(runName: string, record: GenerationRecord): void {
		if (record.error !== undefined) {
			GenerationControlsMeasurement.log(`    ${runName} threw: ${record.error}`, 'fail');
		}
		GenerationControlsMeasurement.log(
			`    ${runName}: ${record.generatedTokenCount} tokens in ${record.wallMs.toFixed(0)} ms`
			+ `${record.isCutOffByTheTokenLimit === true ? ', cut off by the token limit' : ''}`
			+ `${record.hasStoppedOnStopSequence === true ? ', stopped by the stop sequence' : ''}`,
		);
		GenerationControlsMeasurement.log(`    ${runName} text: ${JSON.stringify(record.strippedText)}`);
	}

	/**
	 * How many different answers a set of runs produced.
	 *
	 * Compared on the text a consumer would see, character for character. One means every run answered the same way.
	 *
	 * @param records The records to compare.
	 * @returns The number of distinct answers.
	 */
	private static distinctAnswerCountOf(records: readonly GenerationRecord[]): number {
		return new Set(records.map((record) => record.strippedText)).size;
	}

	/**
	 * The loaded pipeline, loading it on the first call.
	 *
	 * @returns The pipeline.
	 */
	private static loadedGenerator(): Promise<TextGenerationPipeline> {
		if (GenerationControlsMeasurement.generatorPromise !== undefined) {
			return GenerationControlsMeasurement.generatorPromise;
		}
		// `device: 'webgpu'` unconditionally, never a fallback. A WebAssembly answer would look like a working
		// measurement and would prove nothing about the path a worker browser tab takes, which is what issue #211
		// settled for this model.
		GenerationControlsMeasurement.generatorPromise = pipeline('text-generation', MODEL_ID, {
			revision: MODEL_REVISION,
			device: 'webgpu',
			dtype: MODEL_DTYPE,
			progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
				if (progress.status === 'progress' && progress.file !== undefined) {
					const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress ?? 0)}%` : '';
					button.textContent = `Downloading ${progress.file}${percent}…`;
				}
			},
		});
		// Kept on the global object so a person reading this page can ask the loaded pipeline questions from the
		// browser console without loading about 3111 megabytes a second time.
		void GenerationControlsMeasurement.generatorPromise.then((generator) => {
			(globalThis as unknown as { measurementGenerator: TextGenerationPipeline }).measurementGenerator = generator;
		});
		return GenerationControlsMeasurement.generatorPromise;
	}

	/**
	 * Writes one line to the page, to the console, and to the record kept of the whole run.
	 *
	 * @param message The line to write.
	 * @param className The style to write it in, one of `phase`, `pass`, or `fail`, or nothing for an ordinary line.
	 * @returns Nothing.
	 */
	private static log(message: string, className?: string): void {
		loggedLines.push(message);
		const line = document.createElement('div');
		if (className !== undefined) {
			line.className = className;
		}
		line.textContent = message;
		output.appendChild(line);
		console.log(message);
	}
}

button.addEventListener('click', () => {
	button.disabled = true;
	output.textContent = '';
	loggedLines.length = 0;
	GenerationControlsMeasurement.run()
		.catch((error: unknown) => {
			const line = document.createElement('div');
			line.className = 'fail';
			line.textContent = `The measurement stopped: ${error instanceof Error ? error.message : String(error)}`;
			output.appendChild(line);
			console.error(error);
		})
		.finally(() => {
			button.disabled = false;
			button.textContent = 'Run the measurement again';
		});
});
button.disabled = false;
button.textContent = 'Run the measurement';
