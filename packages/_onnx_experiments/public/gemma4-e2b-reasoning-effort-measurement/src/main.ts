import { pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { ChatTemplateRender, type RenderedBothWays } from './chat_template_render';
import { IndexedDbModelCache } from './indexed_db_model_cache';
import { MeasurementPrompts } from './measurement_prompts';
import { ThinkingGeneration, type ThinkingRecord } from './thinking_generation';
import { WebgpuRequirement } from './webgpu_requirement';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	reasoningEffort measurement for issue #223, milestone 0 half one, Gemma 4 E2B
//
//	`task_type_llm_gemma_4_e2b_full` does not honour `reasoningEffort`, and its worker browser tab
//	denies thinking unconditionally rather than as a decision a consumer can make:
//	`stage_helper_llm_gemma_4_e2b_full.ts` writes `enable_thinking: false` out as a literal in three
//	places, whatever the consumer asked for.
//
//	The one assumption that would make issue #223 impossible is that Gemma 4 E2B's chat template
//	ignores `enable_thinking`, because a template that ignores it leaves the worker browser tab able
//	to express nothing, and the intersection of the two kinds of worker is then empty however well
//	the native worker forwards the field. Passing an option a template ignores looks exactly like
//	passing one it reads, so this has to be measured rather than inferred from the option being
//	passed today.
//
//	Phase 2 is that measurement and it may end the issue on its own. Phase 3 asks the question that
//	decides whether honouring the control is worth anything: with thinking on, under the token limit
//	the real stage runs, does this model close its thinking and write an answer? On Qwen3.5-0.8B it
//	did not — issue #192 watched it run to a 2048-token limit in 63.8 seconds without ever closing
//	its thinking block, and never begin an answer.
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
 * The token limit every generation on this page runs under.
 *
 * 1024 is the `MAX_NEW_TOKENS` of `stage_helper_llm_gemma_4_e2b_full.ts`, and this page uses that exact number rather
 * than a smaller one on purpose. The question phase 3 asks is whether a thinking answer finishes inside the limit the
 * real stage imposes, and a measurement made under a different limit could not answer it.
 */
const MAX_NEW_TOKENS = 1024;

const buttonElement = document.querySelector<HTMLButtonElement>('#run-button');
const outputElement = document.querySelector<HTMLElement>('#output');
if (buttonElement === null || outputElement === null) {
	throw new Error('The page must contain #run-button and #output.');
}
// Re-bound to a definitely-non-null type, for the same reason the generation controls measurement does it: the
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
 * Phase 2 decides whether the issue can go on at all, and phases 3 and 4 only run when it can. Every phase runs on the
 * same loaded pipeline, so the only thing that changes between two answers is `enable_thinking`.
 */
export class ReasoningEffortMeasurement {
	/** The loaded pipeline, once something has asked for it. */
	private static generatorPromise: Promise<TextGenerationPipeline> | undefined = undefined;

	/**
	 * Runs every phase, in order, stopping after phase 2 when the chat template turns out to ignore `enable_thinking`.
	 *
	 * @returns Nothing. Everything the run found is written to the page.
	 */
	static async run(): Promise<void> {
		const generator = await ReasoningEffortMeasurement.phase1RunsOnWebgpu();
		const isTemplateReadingTheOption = ReasoningEffortMeasurement.phase2ChatTemplateReadsTheOption(generator);
		if (isTemplateReadingTheOption === false) {
			ReasoningEffortMeasurement.log('');
			ReasoningEffortMeasurement.log(
				'This measurement ends here, and the ending is the result. A chat template that ignores '
				+ 'enable_thinking leaves the worker browser tab able to express nothing, so the intersection of the '
				+ 'two kinds of worker is empty and the row of task_type_llm_gemma_4_e2b_full keeps no '
				+ 'reasoningEffort. Nothing below would add anything to that.',
				'phase',
			);
			return;
		}
		const records = await ReasoningEffortMeasurement.phase3DoesTheModelReallyThink(generator);
		ReasoningEffortMeasurement.phase4WhatThinkingCosts(records);
		ReasoningEffortMeasurement.log('');
		ReasoningEffortMeasurement.log(
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
	 * Read before the model is asked for, and confirmed again after it has loaded, because ONNX Runtime Web can accept
	 * `webgpu`, fail to start it, and carry on from WebAssembly with only a console warning.
	 *
	 * @returns The loaded pipeline.
	 */
	private static async phase1RunsOnWebgpu(): Promise<TextGenerationPipeline> {
		ReasoningEffortMeasurement.log('Phase 1 — is this really running on WebGPU?', 'phase');
		WebgpuRequirement.watchForADroppedProvider();
		const adapterReport = await WebgpuRequirement.demandWebgpu();
		ReasoningEffortMeasurement.log(
			`  adapter: vendor=${JSON.stringify(adapterReport.vendor)}, `
			+ `architecture=${JSON.stringify(adapterReport.architecture)}, `
			+ `description=${JSON.stringify(adapterReport.description)}`,
		);
		ReasoningEffortMeasurement.log(
			`  adapter supports shader-f16 = ${adapterReport.isRequiredFeatureSupported}`,
			adapterReport.isRequiredFeatureSupported ? 'pass' : 'fail',
		);
		ReasoningEffortMeasurement.log(`  IndexedDB model cache installed = ${isIndexedDbCacheInstalled}`);
		ReasoningEffortMeasurement.log(`  model = ${MODEL_ID} at ${MODEL_REVISION}, ${MODEL_DTYPE}`);
		ReasoningEffortMeasurement.log('  loading the model…');
		const generator = await ReasoningEffortMeasurement.loadedGenerator();
		ReasoningEffortMeasurement.log(`  model loaded. tokenizer = ${generator.tokenizer.constructor.name}`);
		const backendVerdict = await WebgpuRequirement.verdictAfterLoading();
		ReasoningEffortMeasurement.log(`  ${backendVerdict.explanation}`, backendVerdict.isWebgpu ? 'pass' : 'fail');
		for (const warning of backendVerdict.droppedProviderWarnings) {
			ReasoningEffortMeasurement.log(`  dropped provider warning: ${warning}`, 'fail');
		}
		return generator;
	}

	/**
	 * Phase 2 — does this model's chat template read `enable_thinking` at all?
	 *
	 * The measurement issue #223 rests on, and the one that can end it. The same history is rendered with the option
	 * `false` and again with it `true`, as text and as a token count, and the two renders are printed whole. Two
	 * identical renders means the template ignores the option and the worker browser tab can express nothing.
	 *
	 * Rendered twice over: once for a plain history and once for a history that declared a tool. The stage helper
	 * passes `enable_thinking` on both paths, and this model's template opens its system turn when tools are declared
	 * as well as when thinking is on, so the two settings could interact and each path has to be seen.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns `true` when the template reads the option on at least the plain path, which is what lets the rest of
	 * the measurement mean anything.
	 */
	private static phase2ChatTemplateReadsTheOption(generator: TextGenerationPipeline): boolean {
		ReasoningEffortMeasurement.log('');
		ReasoningEffortMeasurement.log('Phase 2 — does this chat template read enable_thinking?', 'phase');
		const messages = [{ role: 'user', content: MeasurementPrompts.SETTLED }];

		ReasoningEffortMeasurement.log('  a history that declared no tool:');
		const plain = ChatTemplateRender.bothWays(generator, messages, []);
		ReasoningEffortMeasurement.reportRender(plain);

		ReasoningEffortMeasurement.log('  a history that declared one tool:');
		const withTools = ChatTemplateRender.bothWays(generator, messages, [MeasurementPrompts.TOOL_DECLARATION]);
		ReasoningEffortMeasurement.reportRender(withTools);

		const isReadOnThePlainPath = plain.areTheSame === false;
		const isReadOnTheToolsPath = withTools.areTheSame === false;
		ReasoningEffortMeasurement.log(
			`  the template reads enable_thinking on the plain path = ${isReadOnThePlainPath}`,
			isReadOnThePlainPath ? 'pass' : 'fail',
		);
		ReasoningEffortMeasurement.log(
			`  the template reads enable_thinking on the tools path = ${isReadOnTheToolsPath}`,
			isReadOnTheToolsPath ? 'pass' : 'fail',
		);
		return isReadOnThePlainPath;
	}

	/**
	 * Phase 3 — with thinking on, does this model really think, and does it finish?
	 *
	 * Two questions, each generated with thinking off and again with thinking on, under the token limit the real stage
	 * runs. One question has a settled answer and one has a step to work out, because a model that thinks on both is
	 * thinking because the template told it to rather than because the question asked for it.
	 *
	 * What is being looked for is not only whether a thought channel is opened. It is whether the channel is closed
	 * and an answer follows inside the limit: an answer that never leaves its thinking is an answer a consumer never
	 * receives, whatever the contract says about the control being honoured.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Every record generated, so the phase that adds up the cost reads runs it did not have to repeat.
	 */
	private static async phase3DoesTheModelReallyThink(
		generator: TextGenerationPipeline,
	): Promise<ThinkingRecord[]> {
		ReasoningEffortMeasurement.log('');
		ReasoningEffortMeasurement.log(
			'Phase 3 — with thinking on, does this model think, close its thinking, and answer?',
			'phase',
		);
		const records: ThinkingRecord[] = [];
		for (const [questionName, prompt] of [
			['the settled question', MeasurementPrompts.SETTLED],
			['the reasoned question', MeasurementPrompts.REASONED],
		] as const) {
			ReasoningEffortMeasurement.log(`  ${questionName}: ${JSON.stringify(prompt)}`);
			for (const isThinkingEnabled of [false, true]) {
				const record = await ThinkingGeneration.run(generator, {
					prompt: prompt,
					maxNewTokens: MAX_NEW_TOKENS,
					isThinkingEnabled: isThinkingEnabled,
				});
				records.push(record);
				ReasoningEffortMeasurement.reportRecord(
					`    enable_thinking ${isThinkingEnabled} — max_new_tokens=${MAX_NEW_TOKENS}, do_sample=false`,
					record,
				);
			}
		}
		return records;
	}

	/**
	 * Phase 4 — what thinking costs on this model.
	 *
	 * Read off the runs phase 3 already made rather than generated again: tokens and wall-clock, with thinking on
	 * against with it off, on the same question.
	 *
	 * Printed one question at a time rather than as two totals. The first generation a page makes carries the model's
	 * warm-up along with it, so a total that folded that run in with the others would report the run with thinking off
	 * as the slower of the two and hide the reason.
	 *
	 * @param records Every record phase 3 produced, in the order it produced them.
	 * @returns Nothing.
	 */
	private static phase4WhatThinkingCosts(records: readonly ThinkingRecord[]): void {
		ReasoningEffortMeasurement.log('');
		ReasoningEffortMeasurement.log('Phase 4 — what thinking costs on this model', 'phase');
		ReasoningEffortMeasurement.log(
			'  the first run below carries the model warm-up as well as its own generation, so it is the one run whose '
			+ 'wall-clock says nothing about speed.',
		);
		for (const record of records) {
			const tokensPerSecond = record.wallMs === 0 ? 0 : (record.generatedTokenCount / record.wallMs) * 1000;
			ReasoningEffortMeasurement.log(
				`  ${JSON.stringify(record.request.prompt)}`
				+ ` with enable_thinking ${record.request.isThinkingEnabled}: `
				+ `${record.generatedTokenCount} tokens, ${(record.wallMs / 1000).toFixed(1)} s, `
				+ `${tokensPerSecond.toFixed(1)} tokens per second`,
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Prints both renders of one history, whole.
	 *
	 * The prompts are printed with `JSON.stringify`, so every space and every line break the template wrote is visible
	 * on the page rather than swallowed by the markup. A reader can then see what changed without taking the verdict
	 * on trust.
	 *
	 * @param rendered The same history rendered with `enable_thinking` both ways.
	 * @returns Nothing.
	 */
	private static reportRender(rendered: RenderedBothWays): void {
		for (const render of [rendered.withThinkingOff, rendered.withThinkingOn]) {
			ReasoningEffortMeasurement.log(
				`    enable_thinking ${render.isThinkingEnabled} — ${render.tokenCount} tokens`,
			);
			ReasoningEffortMeasurement.log(`    enable_thinking ${render.isThinkingEnabled} renders: `
				+ `${JSON.stringify(render.text)}`);
		}
		ReasoningEffortMeasurement.log(
			`    the two renders are the same text = ${rendered.areTheSame}`,
			rendered.areTheSame ? 'fail' : 'pass',
		);
	}

	/**
	 * Prints everything one generation produced.
	 *
	 * Both decodings are printed. The raw one carries the channel tokens, which is where thinking is visible at all;
	 * the answer is what a consumer would be given once the worker has taken the thinking out.
	 *
	 * @param runName What to call this run in the printed lines.
	 * @param record The record of the run.
	 * @returns Nothing.
	 */
	private static reportRecord(runName: string, record: ThinkingRecord): void {
		if (record.error !== undefined) {
			ReasoningEffortMeasurement.log(`${runName} threw: ${record.error}`, 'fail');
		}
		ReasoningEffortMeasurement.log(
			`${runName}: ${record.generatedTokenCount} tokens in ${record.wallMs.toFixed(0)} ms`
			+ `${record.isCutOffByTheTokenLimit === true ? ', cut off by the token limit' : ''}`,
		);
		ReasoningEffortMeasurement.log(
			`      opened a thought channel = ${record.hasOpenedAThoughtChannel}, `
			+ `closed it = ${record.hasClosedAThoughtChannel}`,
		);
		ReasoningEffortMeasurement.log(`      raw text: ${JSON.stringify(record.rawText)}`);
		ReasoningEffortMeasurement.log(`      answer a consumer would receive: ${JSON.stringify(record.answerText)}`);
	}

	/**
	 * The loaded pipeline, loading it on the first call.
	 *
	 * @returns The pipeline.
	 */
	private static loadedGenerator(): Promise<TextGenerationPipeline> {
		if (ReasoningEffortMeasurement.generatorPromise !== undefined) {
			return ReasoningEffortMeasurement.generatorPromise;
		}
		// `device: 'webgpu'` unconditionally, never a fallback. A WebAssembly answer would look like a working
		// measurement and would prove nothing about the path a worker browser tab takes, which is what issue #211
		// settled for this model.
		ReasoningEffortMeasurement.generatorPromise = pipeline('text-generation', MODEL_ID, {
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
		void ReasoningEffortMeasurement.generatorPromise.then((generator) => {
			(globalThis as unknown as { measurementGenerator: TextGenerationPipeline }).measurementGenerator = generator;
		});
		return ReasoningEffortMeasurement.generatorPromise;
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
	ReasoningEffortMeasurement.run()
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
