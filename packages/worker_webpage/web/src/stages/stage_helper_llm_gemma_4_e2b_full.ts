import { pipeline, TextStreamer, InterruptableStoppingCriteria, LogitsProcessorList, type TextGenerationPipeline } from '@huggingface/transformers';
import { StagePayloadFactory, type HistoryInput, type GenerationSettings, type LlmStagePayload, type ResponseFormatName, type ToolDeclaration } from '@webai/protocol';
import { Gemma4E2bToolCallReader } from './gemma_4_e2b_tool_call_reader.js';
import { ChatTemplateTools } from './chat_template_tools.js';
import { Gemma4E2bHistoryMessages } from './gemma_4_e2b_history_messages.js';
import type { FullModelReadiness } from './stage_helper_llm_qwen3_5_0_8b_full.js';
import type { ModelDownloadProgress } from './model_download_progress.js';
import { VocabularyTable } from './structured_output/vocabulary_table.js';
import { JsonGrammarMaskCache } from './structured_output/json_grammar_mask_cache.js';
import { JsonGrammarLogitsProcessor } from './structured_output/json_grammar_logits_processor.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmGemma4E2bFull — runs the complete Gemma 4 E2B model in a worker browser, on WebGPU only
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Pinned Hugging Face identifier for the ONNX export this stage runs.
 *
 * `onnx-community/gemma-4-E2B-it-ONNX` is the ONNX export of `google/gemma-4-E2B-it`. The
 * repository is not gated, which is what makes it usable at all: a worker browser tab carries no
 * Hugging Face access token.
 */
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
/**
 * Immutable Hugging Face revision of {@link MODEL_ID}, so a later commit to that repository cannot
 * change what this worker downloads. Confirmed against the live repository on 19 August 2026,
 * together with the licence, `apache-2.0`, and the repository being ungated.
 */
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
/**
 * The quantization this stage loads, out of the five the export publishes.
 *
 * `q4f16` is the smallest, at about 3111 megabytes across the two graphs a text-only run needs:
 * about 1520 megabytes of merged decoder and about 1590 megabytes of token embeddings. The token
 * embedding graph is the larger of the two because this model carries per-layer input embeddings.
 * Every other quantization is bigger again — `q4` is about 3627 megabytes and the default about
 * 20528 — so this is the only one a volunteer browser tab is asked to download.
 *
 * The repository's `transformers.js_config` names `float16` as the key-value cache type for this
 * quantization, which is why {@link StageHelperLlmGemma4E2bFull.readiness} insists on an adapter
 * with 16-bit floating point shaders.
 */
const MODEL_DTYPE = 'q4f16';
/**
 * The smallest amount of free storage this browser must report before this stage is offered.
 *
 * The two graphs are about 3111 megabytes at {@link MODEL_DTYPE}, so this leaves headroom above
 * that for the tokenizer and the browser's own overhead. It is more than four times what
 * `stage_helper_llm_qwen3_5_0_8b_full.ts` asks for, which is the honest size of the difference
 * between the two models rather than a number copied across.
 */
const MINIMUM_FREE_STORAGE_BYTES = 3500 * 1024 * 1024;
/**
 * Maximum number of new tokens generated for one answer, as a safety bound if the model never
 * emits an end-of-sequence token. The model's own `generation_config.json` supplies the actual
 * end-of-sequence token identifiers, so none is hard-coded here.
 */
const MAX_NEW_TOKENS = 1024;
/**
 * The largest number of pieces one answer may be read in, the same kind of bound as
 * {@link MAX_NEW_TOKENS} but for a task that asked for its answer piece by piece.
 */
const MAXIMUM_ANSWER_PIECES = 400;
/**
 * How long an answer held open between runs waits for the run that carries it on.
 *
 * Matches the two other full-model stage helpers and their reasoning: the stage's assignment lease
 * is 60 seconds and the gateway assigns the next run as soon as the previous result arrives, so a
 * wait this long means the task is not coming back.
 */
const ANSWER_IDLE_TIMEOUT_MS = 300_000;

/** The minimal shape of the WebGPU adapter this helper reads, not part of the browser type definitions this project compiles against. */
type GpuAdapterLike = { features: { has(featureName: string): boolean } };
/** The minimal shape of `navigator.gpu` this helper reads. */
type GpuLike = { requestAdapter(): Promise<GpuAdapterLike | null> };

/** One answer this browser is producing, kept in memory while its stage runs read it. */
type TaskGenerationState = {
	/**
	 * Stops the generation loop this state is reading from, once the model session exists.
	 *
	 * Interrupting is a normal stopping condition to `generate()`, the same kind as reaching the
	 * end-of-sequence token, so the generation this criteria belongs to resolves with whatever it
	 * had produced rather than throwing.
	 */
	criteria: InterruptableStoppingCriteria | undefined;
	/** The reader that delivers the answer one piece at a time, absent until generation has started. */
	reader: ReadableStreamDefaultReader<string> | undefined;
	/**
	 * The assignment whose run currently has this generation in hand.
	 *
	 * One tab can hold two runs of one task at once: a lease that expires while a run is under way
	 * has the gateway assign the stage again, and this stage asks for that retry to come back to the
	 * same tab. Each run releases the generation when it is finished with it, and only the run named
	 * here may, so the run that was replaced cannot release the generation its replacement is
	 * reading.
	 */
	owningStageAssignmentId: string;
	/**
	 * What has been read from the model but not yet returned as a stage result.
	 *
	 * A run that is replaced while it is waiting for a piece still receives that piece, because the
	 * model has already handed it over and a stream cannot give it back. That run may not answer, so
	 * the piece is kept here for the run that replaced it to report.
	 */
	unreportedText: string;
	/** The timer that gives up an answer nobody has come back for. See {@link ANSWER_IDLE_TIMEOUT_MS}. */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/**
	 * The tools the history declared, empty when it declared none.
	 *
	 * Read once, from the run that starts the answer, and kept for the runs that carry it on, because
	 * only the first run of a task carries the history. It decides three things: whether the
	 * declarations reach the chat template, whether the generated text is decoded keeping the special
	 * tokens a tool call is written with, and whether the answer may be reported one piece at a time.
	 */
	declaredTools: readonly ToolDeclaration[];
	/**
	 * Every token identifier the model has generated for this answer, in order.
	 *
	 * Kept because one answer may have to be decoded two ways. A run that declared tools decodes
	 * keeping the special tokens, so that a tool call can be found at all, and then decodes these same
	 * identifiers again with the special tokens skipped when the model answered in words instead — so
	 * the answer a consumer receives never carries an end-of-turn marker, and is arrived at by
	 * decoding rather than by cutting markers off text by hand.
	 */
	generatedTokenIds: number[];
	/** How many pieces have been read, which bounds how long one answer may be read for. */
	pieceCount: number;
	/**
	 * Whether {@link StageHelperLlmGemma4E2bFull.clearGeneration} has released this generation while
	 * the stage run still had it in hand.
	 *
	 * Read at the two points a run can learn its work is no longer wanted: after a read, because a
	 * cancelled reader ends the read waiting on it as if the model had finished, and after the model
	 * session is created, because a release that arrives while the session is still loading has no
	 * reader yet to cancel.
	 */
	isReleased: boolean;
	/**
	 * The exact number of tokens the prompt was encoded into, once known.
	 *
	 * Counted from `generator.tokenizer.apply_chat_template`, the same call `generate()` itself makes
	 * to encode the prompt, so this is what was actually fed to the model rather than an estimate.
	 */
	promptTokenCount: number | undefined;
	/**
	 * The exact number of tokens the model generated for this answer, once generation has finished.
	 *
	 * Counted from `TextStreamer`'s `token_callback_function`, which is called with every raw token
	 * identifier the model produces.
	 */
	completionTokenCount: number | undefined;
	/**
	 * Why generation stopped, once it has, in this stage's own word for it rather than an OpenAI
	 * value.
	 *
	 * `stop_sequence` is not among the values this stage can report, because this task type honours
	 * no `stopSequences` control for there to be a sequence to stop on. See
	 * `generation_control_support.ts`.
	 */
	stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | undefined;
	/**
	 * The shape the consumer asked its answer to be in, or `undefined` when it asked for prose.
	 *
	 * Read once, from the run that starts the answer, and kept for the runs that carry it on, for the
	 * same reason {@link TaskGenerationState.declaredTools} is: only the first run of a task carries
	 * the generation settings.
	 */
	responseFormat: ResponseFormatName | undefined;
	/**
	 * The processor masking this answer into shape, or `undefined` for an answer asked for as prose.
	 *
	 * Kept so that the run which finishes the answer can ask whether the value was ever finished. One
	 * of these belongs to one generation, because the reader inside it is the state of one answer.
	 */
	jsonGrammarProcessor: JsonGrammarLogitsProcessor | undefined;
};

/**
 * Runs the complete Gemma 4 E2B instruction-tuned model, downloaded once and held in this browser's
 * memory for as long as the page stays open, in as many stage runs as the consumer asked its answer
 * to arrive in.
 *
 * **This stage runs on WebGPU and nothing else.** There is no WebAssembly fallback, and
 * {@link StageHelperLlmGemma4E2bFull.readiness} reports the stage unavailable rather than offering
 * it on a browser that cannot provide WebGPU. WebAssembly is far too slow to carry a model meant to
 * become the default one this project reaches for, which is
 * https://github.com/webai-at-home/webai-at-home/issues/210, and a worker that offers a stage it
 * cannot honour properly is worse than a worker that offers nothing.
 *
 * That the model runs correctly this way is measured rather than assumed. Milestone 0 of
 * https://github.com/webai-at-home/webai-at-home/issues/211 loaded this exact repository and
 * quantization in a browser tab on WebGPU, confirmed no execution provider had been dropped, and
 * asked two questions whose answers are known before believing anything else — because WebGPU
 * returns wrong numbers without reporting an error, which is what killed
 * https://github.com/webai-at-home/webai-at-home/issues/172. The gate is
 * `packages/_onnx_experiments/public/gemma4-e2b-it/` and it can be re-run.
 *
 * This model is text-only here, and the model is not. Its repository declares a vision part and an
 * audio part beside the text part, and its pipeline tag is `any-to-any`. Only the merged decoder and
 * the token embedding graphs are downloaded, and only text is ever sent to it.
 *
 * What this stage does not do, and why, because the task type's contract in
 * `generation_control_support.ts` says it does not:
 *
 * - It honours no generation control, so every answer is decoded greedily with `do_sample: false`
 *   and thinking turned off, whatever the consumer asked for. That table is empty because nothing
 *   about this model has been measured yet, and milestone 5 of issue #211 is where it is widened
 *   from a live run. Do not wire a control through here before that row names it: a control acted on
 *   without being declared is exactly as wrong as one declared without being acted on.
 *
 * It does produce a `json_object` response format, since milestone 3 of
 * https://github.com/webai-at-home/webai-at-home/issues/219, by masking the scores of the next token
 * so that nothing which would break the object can be chosen — see `structured_output/`. Three
 * things about that are worth knowing before this file is changed:
 *
 * - `structured_output_support.ts` names `json_object` for this task type, since milestone 5 of that
 *   issue, and it was widened only once the native worker produced the same shape, because a task
 *   type's contract is what all of its workers can keep. That ordering was the point rather than an
 *   oversight — a worker able to keep a promise the task type has not made is safe, and a promise
 *   made before a worker can keep it is not.
 * - A run that asked for a shape and declared tools is refused rather than answered. Every marker a
 *   tool call is written with is a special token of this tokenizer, and the mask leaves no special
 *   token legal until the object is finished, so a masked answer cannot contain a tool call at all.
 * - A run that asked for `json_schema` is refused too. This stage enforces well-formed JSON and not
 *   a schema, and answering a request for a schema with whatever object the model happened to write
 *   would be the exact failure `structured_output_support.ts` exists to prevent.
 *
 * It does read tool calls, since milestone 2 of
 * https://github.com/webai-at-home/webai-at-home/issues/216, and the format it reads them in was
 * measured in that issue's milestone 0 rather than taken from what this model family is known to do.
 * Two things about that are worth knowing before this file is changed:
 *
 * - A run that declared tools decodes the generated text **keeping** the special tokens, because
 *   every marker a tool call is written with is a special token of this tokenizer. A run that
 *   declared none keeps skipping them, so nothing about an answer to a task that declared no tool
 *   changes at all.
 * - Nothing here watches for a complete tool call to stop generation on. The `<|tool_response>` the
 *   model writes after a call is token 50, which this export's own `generation_config.json` names an
 *   end-of-sequence token, so the model writes the call, opens the place the tool's answer goes, and
 *   stops by itself.
 *
 * A history carrying a finished tool round trip renders back, since milestone 3 of the same issue —
 * see {@link Gemma4E2bHistoryMessages.of}, which is where the identifier this template needs and the
 * protocol does not carry is minted. `task_type_llm_gemma_4_e2b_full` accepts a request that
 * declares a tool since milestone 5, which added it to `taskTypeNamesAcceptingTools` in
 * `packages/consumer_cli` — a promise of the task type, kept by this worker and by the native one
 * alike, so neither may stop keeping it on its own.
 *
 * The model is loaded once per page and shared by every task this browser runs. Only the generation
 * in progress is kept per task.
 *
 * The browser produces an answer in pieces, and what one stage run does with those pieces is decided
 * by the `isStreaming` generation setting the consumer submitted, exactly as the two other
 * full-model stage helpers do it:
 *
 * - Asked for nothing, one run reads every piece of the answer and returns the whole thing.
 * - Asked for the answer in pieces, one run reads one piece and returns it, and the generation stays
 *   open in this tab for the run that follows.
 */
export class StageHelperLlmGemma4E2bFull {
	/**
	 * The computation this worker browser implements, named the way a pipeline stage names its
	 * computation.
	 */
	static readonly computation = 'llm_gemma_4_e2b_full';

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmGemma4E2bFull.computation;
	}

	/** The generations this browser is currently producing, by task identifier. */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/** The loaded pipeline, shared by every task, once `preload` or the first run has created it. */
	private static generatorPromise: Promise<TextGenerationPipeline> | undefined;

	/**
	 * The masks of the loaded model's vocabulary, shared by every task that asks for a shape.
	 *
	 * Built on the first answer that asks for one rather than when the model loads, so a tab that
	 * only ever answers in prose never pays for it. What it costs is one decode of the whole
	 * vocabulary, measured at 331 milliseconds for this model by milestone 0 of
	 * https://github.com/webai-at-home/webai-at-home/issues/219, and it is paid once for the life of
	 * the loaded model rather than once per answer.
	 */
	private static maskCache: JsonGrammarMaskCache | undefined;

	/**
	 * Reports whether this browser can run the stage, without downloading anything.
	 *
	 * Asked before the browser advertises the stage, so a browser that cannot run the model says so
	 * at once instead of accepting work it would fail — and, for this stage in particular, instead of
	 * moving about 3111 megabytes before finding out.
	 *
	 * @returns Whether the stage can be run, and why not when it cannot.
	 */
	static async readiness(): Promise<FullModelReadiness> {
		// Read the value rather than asking whether the key is there. `gpu` is defined on
		// `Navigator.prototype`, so `'gpu' in navigator` stays true in a browser that carries the
		// property and leaves it undefined, which is what a page served outside a secure context and a
		// browser with WebGPU turned off both look like. Milestone 0 of issue #211 found this the hard
		// way: the first version of its check passed a browser it should have refused.
		const gpu = (globalThis.navigator as { gpu?: GpuLike }).gpu;
		if (gpu === undefined || gpu === null) {
			return {
				status: 'unavailable',
				message: 'This browser exposes no WebGPU, which the Gemma 4 E2B stage needs. There is no WebAssembly fallback: it would be far too slow to be worth offering.',
			};
		}
		const adapter = await gpu.requestAdapter().catch(() => null);
		if (adapter === null) {
			return {
				status: 'unavailable',
				message: 'This browser reports WebGPU but no adapter could be requested, so the Gemma 4 E2B stage cannot run.',
			};
		}
		if (adapter.features.has('shader-f16') === false) {
			return {
				status: 'unavailable',
				message: "This browser's WebGPU adapter does not support 16-bit floating point shaders, which the Gemma 4 E2B stage needs for the float16 key-value cache of its q4f16 quantization.",
			};
		}
		const estimate = await globalThis.navigator.storage?.estimate().catch(() => undefined);
		if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < MINIMUM_FREE_STORAGE_BYTES) {
			return {
				status: 'unavailable',
				message: `This browser reports too little free storage for the Gemma 4 E2B download, which needs about ${Math.round(MINIMUM_FREE_STORAGE_BYTES / (1024 * 1024))} MB.`,
			};
		}
		return { status: 'ready' };
	}

	/**
	 * Downloads and loads the model, so a task never waits for it.
	 *
	 * Safe to call more than once: the loaded pipeline is memoized and reused.
	 *
	 * @param onProgress Called with progress steps while the model downloads and loads.
	 * @returns A promise that resolves once the model is ready to generate.
	 */
	static preload(onProgress?: (progress: ModelDownloadProgress) => void): Promise<void> {
		return StageHelperLlmGemma4E2bFull.loadedGenerator(onProgress).then(() => undefined);
	}

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer asked
	 * for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this run
	 * is the one allowed to release the answer it is reading.
	 * @param payload The prompt or history submitted with the task, or, on a run that carries an
	 * answer on, a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for. Only `isStreaming` is read: it decides
	 * whether one run returns one piece and leaves the answer open, or reads the whole answer. Every
	 * other control is ignored, because this task type's contract in `generation_control_support.ts`
	 * names none, and a control acted on without being declared is as wrong as one declared without
	 * being acted on.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the model cannot be loaded, if the run is asked to carry on an answer this browser is
	 * not holding, if the answer is abandoned before or while it is being read, or if generation
	 * reports an error.
	 */
	static async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
	): Promise<LlmStagePayload> {
		const state = payload.isContinuation === true
			? StageHelperLlmGemma4E2bFull.heldGeneration(taskId, stageAssignmentId)
			: StageHelperLlmGemma4E2bFull.newGeneration(taskId, stageAssignmentId);
		if (payload.isContinuation !== true) {
			state.declaredTools = payload.history?.tools ?? [];
			state.responseFormat = generationSettings?.responseFormat;
		}
		StageHelperLlmGemma4E2bFull.refuseAnUnproducibleShape(state);
		// A history that declared tools is never read in pieces, even when the consumer asked for
		// pieces. Until the model has finished writing, a piece of a tool call is indistinguishable
		// from a piece of an answer — the two begin the same way — so reporting pieces would send a
		// consumer the raw `<|tool_call>` markup of a request it was supposed to receive as structured
		// data. One run reads the whole thing and returns either an answer or the tool calls.
		const wantsPieces = generationSettings?.isStreaming === true && state.declaredTools.length === 0;
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of run
		// that must not release what it was reading. Every other way out of this method — the finished
		// answer, and every failure — releases it.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await StageHelperLlmGemma4E2bFull.startGeneration(state, payload.history ?? payload.text ?? '');
			while (state.pieceCount < MAXIMUM_ANSWER_PIECES) {
				const piece = await reader.read();
				if (state.isReleased === true) {
					throw new Error('The answer this stage was producing was abandoned before generation had finished.');
				}
				if (piece.done === true) {
					break;
				}
				state.text += piece.value;
				state.unreportedText += piece.value;
				state.pieceCount += 1;
				StageHelperLlmGemma4E2bFull.refuseIfReplaced(state, stageAssignmentId);
				if (wantsPieces === true) {
					leavesAnswerOpen = true;
					const reported = state.unreportedText;
					state.unreportedText = '';
					StageHelperLlmGemma4E2bFull.waitForTheRunAfterThis(taskId, state);
					return StagePayloadFactory.llmPartialText(reported);
				}
			}
			StageHelperLlmGemma4E2bFull.refuseIfReplaced(state, stageAssignmentId);
			StageHelperLlmGemma4E2bFull.refuseAnUnfinishedShape(state);
			// A tool call that cannot be read throws out of here, which fails the stage and names what
			// could not be read. That is deliberate: a calling program runs whatever tool call it
			// receives, so a call read wrongly is a call run wrongly on the caller's own machine.
			const toolCalls = Gemma4E2bToolCallReader.read(state.text, state.declaredTools);
			if (toolCalls.length > 0) {
				return StagePayloadFactory.llmToolCalls(toolCalls, StageHelperLlmGemma4E2bFull.usageOf(state));
			}
			return StagePayloadFactory.llmDone(
				await StageHelperLlmGemma4E2bFull.answerTextOf(state),
				undefined,
				StageHelperLlmGemma4E2bFull.usageOf(state),
			);
		} finally {
			if (leavesAnswerOpen === false) {
				StageHelperLlmGemma4E2bFull.clearGeneration(taskId, stageAssignmentId);
			}
		}
	}

	/**
	 * Releases every answer this browser is holding, without unloading the model itself.
	 *
	 * Called when the connection to the gateway goes away: no run can arrive to carry an open answer
	 * on while there is no connection to assign one.
	 */
	static clearEveryGeneration(): void {
		for (const [taskId, state] of StageHelperLlmGemma4E2bFull.stateByTaskId) {
			StageHelperLlmGemma4E2bFull.stateByTaskId.delete(taskId);
			StageHelperLlmGemma4E2bFull.release(state);
		}
	}

	/**
	 * Releases the answer this browser is producing for one task, if the assignment named is the one
	 * currently reading it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		const state = StageHelperLlmGemma4E2bFull.stateByTaskId.get(taskId);
		if (state === undefined || state.owningStageAssignmentId !== stageAssignmentId) {
			return;
		}
		StageHelperLlmGemma4E2bFull.stateByTaskId.delete(taskId);
		StageHelperLlmGemma4E2bFull.release(state);
	}

	/**
	 * Loads the tokenizer and creates the text-generation pipeline once per page.
	 *
	 * `device` is `webgpu` unconditionally rather than chosen at run time. A run that cannot use
	 * WebGPU must fail loudly here instead of answering from WebAssembly, which would be far slower
	 * than this stage is worth and would look from the outside exactly like a working stage.
	 * {@link StageHelperLlmGemma4E2bFull.readiness} is what stops this browser reaching this point at
	 * all when it has no WebGPU.
	 *
	 * @param onProgress Called with progress steps while the model downloads and loads.
	 * @returns The loaded pipeline.
	 */
	private static loadedGenerator(onProgress?: (progress: ModelDownloadProgress) => void): Promise<TextGenerationPipeline> {
		if (StageHelperLlmGemma4E2bFull.generatorPromise !== undefined) {
			return StageHelperLlmGemma4E2bFull.generatorPromise;
		}
		onProgress?.({ kind: 'message', message: `Downloading ${MODEL_ID}. This moves about 3111 MB and takes minutes on the first run…` });
		const loadPromise = pipeline('text-generation', MODEL_ID, {
			revision: MODEL_REVISION,
			device: 'webgpu',
			dtype: MODEL_DTYPE,
			progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
				if (progress.status === 'progress' && progress.file !== undefined) {
					const percent = Number.isFinite(progress.progress) ? Math.round(progress.progress ?? 0) : 0;
					onProgress?.({ kind: 'file_progress', file: progress.file, percent });
				} else if (progress.status === 'done' && progress.file !== undefined) {
					onProgress?.({ kind: 'file_done', file: progress.file });
				}
			},
		}).then((generator) => {
			onProgress?.({ kind: 'message', message: 'Gemma 4 E2B ready.' });
			return generator;
		}).catch((error: unknown) => {
			StageHelperLlmGemma4E2bFull.generatorPromise = undefined;
			throw error;
		});
		StageHelperLlmGemma4E2bFull.generatorPromise = loadPromise;
		return loadPromise;
	}

	/**
	 * Refuses an answer this stage would have to produce by ignoring the shape that was asked for.
	 *
	 * Neither of the two cases can reach here from a consumer today, and each is stopped by a
	 * different thing. `structured_output_support.ts` names `json_object` for this task type and not
	 * `json_schema`, so `ResponseFormatReader` refuses a schema against that table. A shape asked for
	 * beside declared tools is refused by that same class, on a rule of its own rather than out of
	 * that table, because no worker can hold a model to a shape and let it open a tool call at once.
	 * Both are refused here anyway, because the alternative to a refusal is an answer generated some
	 * other way with nothing said about it — which is the one failure `structured_output_support.ts`
	 * exists to prevent, and a consumer is not the only thing that can reach this method.
	 *
	 * @param state The answer being produced.
	 * @returns Nothing.
	 * @throws When the shape asked for is one this stage cannot produce, or one it cannot produce
	 * together with the tools the history declared.
	 */
	private static refuseAnUnproducibleShape(state: TaskGenerationState): void {
		if (state.responseFormat === undefined) {
			return;
		}
		if (state.responseFormat === 'json_schema') {
			// Enforcing well-formed JSON where a schema was asked for would answer with an object whose
			// keys are the model's own guess and report it as though the schema had been kept.
			throw new Error(
				'This stage produces a response format of json_object and not json_schema, and it does not '
				+ 'answer a request for a schema with whatever object the model happens to write.',
			);
		}
		if (state.declaredTools.length > 0) {
			// Every marker a tool call is written with is a special token of this tokenizer, and the mask
			// leaves no special token legal until the value is finished. So a masked answer cannot
			// contain a tool call at all, and the two asked for together are two things that cannot both
			// be given.
			throw new Error(
				'This stage cannot both produce a response format of json_object and call a tool: the '
				+ 'markers a tool call is written with are masked out for as long as the object is unfinished.',
			);
		}
	}

	/**
	 * Refuses an answer whose shape the model stopped in the middle of, having stopped of its own accord.
	 *
	 * The mask leaves only the end-of-sequence entries legal once the value is finished, and leaves
	 * none of them legal before, so a model that stopped by itself stopped on a finished value. If it
	 * did not, the mask and the model's own end-of-sequence list disagree, and the answer is a
	 * truncated object about to be reported as a finished one.
	 *
	 * An answer cut short by {@link MAX_NEW_TOKENS} or by an interruption is not refused here. It is
	 * unfinished for a reason the stage already reports, in `stopReason`, and a caller told its answer
	 * ran out of budget is a caller that knows what it received.
	 *
	 * @param state The answer being produced.
	 * @returns Nothing.
	 * @throws When the model ended its turn part way through the shape it was masked into.
	 */
	private static refuseAnUnfinishedShape(state: TaskGenerationState): void {
		const processor = state.jsonGrammarProcessor;
		if (processor === undefined || processor.isComplete === true) {
			return;
		}
		if (state.stopReason !== 'end_of_sequence') {
			return;
		}
		throw new Error(
			'This stage was asked for a response format of json_object and the model ended its turn part '
			+ 'way through the object, so the answer is not the shape it was asked for.',
		);
	}

	/**
	 * The masks of this model's vocabulary, built once for the life of the loaded model.
	 *
	 * @param generator The loaded text-generation pipeline whose vocabulary to mask over.
	 * @returns The mask cache every answer of this model shares.
	 */
	private static maskCacheFor(generator: TextGenerationPipeline): JsonGrammarMaskCache {
		if (StageHelperLlmGemma4E2bFull.maskCache === undefined) {
			StageHelperLlmGemma4E2bFull.maskCache = new JsonGrammarMaskCache(
				VocabularyTable.build(generator.tokenizer),
				StageHelperLlmGemma4E2bFull.eosTokenIdsOf(generator),
			);
		}
		return StageHelperLlmGemma4E2bFull.maskCache;
	}

	/**
	 * Creates and stores fresh generation state for a task's first round.
	 *
	 * @param taskId The task the answer belongs to.
	 * @param stageAssignmentId The assignment whose run is starting the answer.
	 * @returns The state this run reads its answer through.
	 */
	private static newGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		// A task asks for its answer once, so anything still held for this task is left over from an
		// attempt that was given up on without being cancelled.
		const abandoned = StageHelperLlmGemma4E2bFull.stateByTaskId.get(taskId);
		if (abandoned !== undefined) {
			StageHelperLlmGemma4E2bFull.release(abandoned);
		}
		const state: TaskGenerationState = {
			criteria: undefined,
			reader: undefined,
			owningStageAssignmentId: stageAssignmentId,
			unreportedText: '',
			idleTimer: undefined,
			text: '',
			declaredTools: [],
			generatedTokenIds: [],
			pieceCount: 0,
			isReleased: false,
			promptTokenCount: undefined,
			completionTokenCount: undefined,
			stopReason: undefined,
			responseFormat: undefined,
			jsonGrammarProcessor: undefined,
		};
		StageHelperLlmGemma4E2bFull.stateByTaskId.set(taskId, state);
		return state;
	}

	/**
	 * Finds the answer this browser is holding open for a task, so this run can read on from it.
	 *
	 * @param taskId The task whose answer is being carried on.
	 * @param stageAssignmentId The assignment whose run is carrying it on, which becomes the one
	 * allowed to release the answer.
	 * @returns The state holding the answer so far.
	 * @throws If this browser holds no answer for the task.
	 */
	private static heldGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		const state = StageHelperLlmGemma4E2bFull.stateByTaskId.get(taskId);
		if (state === undefined) {
			throw new Error('This stage was asked to carry on an answer, but this browser is not holding one for that task.');
		}
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		state.owningStageAssignmentId = stageAssignmentId;
		return state;
	}

	/**
	 * Stops a run that has been replaced from answering for an assignment it no longer holds.
	 *
	 * @param state The answer this run was reading.
	 * @param stageAssignmentId The assignment this run is carrying out.
	 * @throws If another run has taken the answer over.
	 */
	private static refuseIfReplaced(state: TaskGenerationState, stageAssignmentId: string): void {
		if (state.owningStageAssignmentId === stageAssignmentId) {
			return;
		}
		throw new Error('This run was replaced by a later one while it was waiting for the model, so its answer belongs to that run.');
	}

	/**
	 * Starts the wait for the run that carries this answer on, giving the answer up if none comes.
	 *
	 * @param taskId The task whose answer is being held open.
	 * @param state The answer being held open.
	 */
	private static waitForTheRunAfterThis(taskId: string, state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = setTimeout(() => {
			if (StageHelperLlmGemma4E2bFull.stateByTaskId.get(taskId) !== state) {
				return;
			}
			StageHelperLlmGemma4E2bFull.stateByTaskId.delete(taskId);
			StageHelperLlmGemma4E2bFull.release(state);
		}, ANSWER_IDLE_TIMEOUT_MS);
	}

	/**
	 * Ends one answer: stops generation and gives back what the browser holds for it.
	 *
	 * The model itself, and the graphics memory its session holds, are left alone — they are shared
	 * by every task and only released when the page is closed. That matters more here than for the
	 * smaller models: reloading this one costs about 3111 megabytes of download on a cold cache.
	 *
	 * @param state The answer to release.
	 */
	private static release(state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		// Set before either of the two below: both are how a waiting run learns it has been released,
		// and neither exists yet when the release arrives while the model is still loading.
		state.isReleased = true;
		if (state.reader !== undefined) {
			void state.reader.cancel().catch(() => undefined);
		}
		state.criteria?.interrupt();
	}

	/**
	 * Starts one answer, and hands its stopping criteria and reader to the state the run holds.
	 *
	 * @param state The generation state this run registered, already released or not.
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The reader that delivers the answer.
	 * @throws If the prompt or history is empty, if the model cannot be loaded, or if the assignment
	 * was taken away while the browser was loading the model.
	 */
	private static async startGeneration(
		state: TaskGenerationState,
		promptOrHistory: string | HistoryInput,
	): Promise<ReadableStreamDefaultReader<string>> {
		if (StageHelperLlmGemma4E2bFull.isEmpty(promptOrHistory)) {
			throw new Error('A prompt is needed to start an answer.');
		}
		const generator = await StageHelperLlmGemma4E2bFull.loadedGenerator();
		// Loading the model is by far the slowest part of a run for this stage, and the assignment can
		// be taken away while it is happening. A release that arrives then leaves this flag and nothing
		// else, since no reader exists yet to cancel; reading it here is what stops the browser
		// starting a whole generation for a task that was already given up on.
		if (state.isReleased === true) {
			throw new Error('The answer this stage was to produce was abandoned before the model was ready.');
		}
		// The same encoding `generate()` itself applies to the prompt, so this is the exact count of
		// what was fed to the model rather than an estimate.
		const promptTensor = (
			generator.tokenizer as unknown as {
				apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => { data?: ArrayLike<number> };
			}
		).apply_chat_template(Gemma4E2bHistoryMessages.of(promptOrHistory), {
			tokenize: true,
			add_generation_prompt: true,
			enable_thinking: false,
			return_dict: false,
			...ChatTemplateTools.templateOption(state.declaredTools),
		});
		state.promptTokenCount = promptTensor.data?.length;
		const criteria = new InterruptableStoppingCriteria();
		state.criteria = criteria;
		// The whole of what makes this stage produce a shape. `@huggingface/transformers` offers no way
		// to ask for one — its `constraints` field is declared and never read — so the shape is
		// enforced between the logits and the choice of token instead, which is the one place it can
		// be. See `structured_output/`.
		if (state.responseFormat === 'json_object') {
			state.jsonGrammarProcessor = new JsonGrammarLogitsProcessor(
				StageHelperLlmGemma4E2bFull.maskCacheFor(generator),
				true,
			);
		}
		state.reader = StageHelperLlmGemma4E2bFull.createGenerationStream(generator, promptOrHistory, criteria, state).getReader();
		return state.reader;
	}

	/**
	 * Reports whether a prompt or history carries nothing to answer.
	 *
	 * A history that reached this point always has at least one message, because `HistoryInputSchema`
	 * refuses an empty one at submission; this still checks rather than assuming it, so a payload with
	 * neither `text` nor `history` set is caught here as the empty string {@link compute} falls back
	 * to.
	 *
	 * @param promptOrHistory The value {@link startGeneration} was given.
	 * @returns `true` when there is nothing to answer.
	 */
	private static isEmpty(promptOrHistory: string | HistoryInput): boolean {
		if (typeof promptOrHistory === 'string') {
			return promptOrHistory.trim() === '';
		}
		return promptOrHistory.messages.length === 0;
	}

	/**
	 * Builds a stream that delivers a generated answer one piece at a time, backed by
	 * `@huggingface/transformers`'s own streaming callback.
	 *
	 * Also counts the raw tokens the model generates, through `TextStreamer`'s
	 * `token_callback_function`, and works out why generation stopped once it has. Both are written
	 * onto `state` rather than returned, because a `ReadableStream<string>` has nowhere else to carry
	 * them.
	 *
	 * Generation is greedy and thinking is off, whatever the consumer asked for, because this task
	 * type honours no generation control. Thinking off is not an arbitrary default: milestone 0 of
	 * issue #210 measured this model on a local server with thinking on and found it answer 515
	 * characters to a request budgeted at 8 tokens, so thinking is what makes this model's output
	 * unbounded rather than any property of the budget.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param promptOrHistory The prompt or history to generate an answer for.
	 * @param criteria Stops generation early when the stream's reader is cancelled.
	 * @param state The generation state to record the completion token count and stop reason on.
	 * @returns A stream of the pieces of text the model produces, in order.
	 */
	private static createGenerationStream(
		generator: TextGenerationPipeline,
		promptOrHistory: string | HistoryInput,
		criteria: InterruptableStoppingCriteria,
		state: TaskGenerationState,
	): ReadableStream<string> {
		let isCancelled = false;
		const tokenIds = state.generatedTokenIds;
		// A run that declared tools has to keep the special tokens, because every marker a tool call is
		// written with is a special token of this tokenizer and skipping them would strip the call down
		// to text no reader could find it in. A run that declared none keeps skipping them, so a task
		// submitted before tool calling existed receives byte for byte the answer it always did — and
		// so an answer reported one piece at a time never carries a marker, which is the one case
		// nothing could strip after the fact, a forwarded piece being impossible to recall.
		const keepsSpecialTokens = state.declaredTools.length > 0;
		return new ReadableStream<string>({
			start(controller) {
				const streamer = new TextStreamer(generator.tokenizer, {
					skip_prompt: true,
					skip_special_tokens: keepsSpecialTokens === false,
					callback_function: (chunk: string) => {
						if (isCancelled === false && chunk !== '') {
							controller.enqueue(chunk);
						}
					},
					token_callback_function: (newTokens: bigint[]) => {
						for (const tokenId of newTokens) {
							tokenIds.push(Number(tokenId));
						}
					},
				});
				// A history that declared tools is rendered into a prompt here and generated from as
				// text. The text-generation pipeline applies the chat template itself when it is handed
				// a message list, and exposes no way to pass tool declarations through when it does, so
				// a message list would silently produce a prompt with no tools in it. Every task that
				// declared no tool still goes through the message list, exactly as it always has.
				const input = state.declaredTools.length === 0
					? Gemma4E2bHistoryMessages.of(promptOrHistory)
					: StageHelperLlmGemma4E2bFull.renderedPrompt(generator, promptOrHistory, state.declaredTools);
				// The field is absent altogether for an answer asked for as prose, rather than present and
				// empty, so such an answer is generated by exactly the call this stage has always made.
				//
				// When it is present: `_get_logits_processor` calls `processors.extend(logits_processor)`,
				// and `extend` spreads what it is given, so the field takes an iterable of processors and
				// a bare processor throws. `LogitsProcessorList` is the shape
				// `GenerationFunctionParameters` declares for it, and neither that nor the iterable is in
				// the documentation.
				const maskingOption: { logits_processor?: LogitsProcessorList } = {};
				if (state.jsonGrammarProcessor !== undefined) {
					const logitsProcessors = new LogitsProcessorList();
					logitsProcessors.push(state.jsonGrammarProcessor);
					maskingOption.logits_processor = logitsProcessors;
				}
				generator(input, {
					max_new_tokens: MAX_NEW_TOKENS,
					do_sample: false,
					return_full_text: false,
					tokenizer_encode_kwargs: { enable_thinking: false },
					stopping_criteria: criteria,
					...maskingOption,
					streamer,
				}).then(() => {
					state.completionTokenCount = tokenIds.length;
					state.stopReason = StageHelperLlmGemma4E2bFull.stopReasonOf(criteria, generator, tokenIds);
					if (isCancelled === false) {
						controller.close();
					}
				}).catch((error: unknown) => {
					if (isCancelled === false) {
						controller.error(error instanceof Error ? error : new Error(String(error)));
					}
				});
			},
			cancel() {
				isCancelled = true;
				criteria.interrupt();
			},
		});
	}

	/**
	 * The answer to report, for a run whose model wrote words rather than asking for a tool.
	 *
	 * A run that declared no tool decoded with the special tokens skipped already, so the text it
	 * read is the answer, byte for byte as this stage has always reported it.
	 *
	 * A run that declared tools had to keep the special tokens, so its text ends in the end-of-turn
	 * marker the model wrote, which no consumer asked for. The answer is arrived at by decoding the
	 * same token identifiers a second time with the special tokens skipped, rather than by cutting
	 * markers off the text: the set of markers this model may write is the model's, not this file's,
	 * and a list of them written here would be one more thing to keep in step with the model.
	 *
	 * @param state The generation state holding the text read and the tokens it came from.
	 * @returns The answer text to report.
	 */
	private static async answerTextOf(state: TaskGenerationState): Promise<string> {
		if (state.declaredTools.length === 0) {
			return state.text;
		}
		const generator = await StageHelperLlmGemma4E2bFull.loadedGenerator();
		return (
			generator.tokenizer as unknown as {
				decode: (tokenIds: number[], options: Record<string, unknown>) => string;
			}
		).decode(state.generatedTokenIds, { skip_special_tokens: true });
	}

	/**
	 * Renders a history into the prompt text to generate from, with the declared tools in it.
	 *
	 * Used only when tools were declared. Every other task hands its message list to the pipeline and
	 * lets the pipeline apply the template, exactly as before.
	 *
	 * @param generator The loaded text-generation pipeline, read for its tokenizer's chat template.
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @param declaredTools The tools the history declared.
	 * @returns The prompt text to generate from.
	 */
	private static renderedPrompt(
		generator: TextGenerationPipeline,
		promptOrHistory: string | HistoryInput,
		declaredTools: readonly ToolDeclaration[],
	): string {
		return (
			generator.tokenizer as unknown as {
				apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => string;
			}
		).apply_chat_template(Gemma4E2bHistoryMessages.of(promptOrHistory), {
			tokenize: false,
			add_generation_prompt: true,
			enable_thinking: false,
			...ChatTemplateTools.templateOption(declaredTools),
		});
	}

	/**
	 * Builds the `usage` argument {@link StagePayloadFactory.llmDone} takes, from whatever this state
	 * managed to record.
	 *
	 * Built field by field rather than by spreading `state` itself, because `state`'s own fields are
	 * typed `| undefined` from being read before generation finishes, while
	 * {@link StagePayloadFactory.llmDone}'s `usage` parameter types each field as merely optional —
	 * the same distinction `exactOptionalPropertyTypes` enforces throughout this repository.
	 *
	 * @param state The generation state to read.
	 * @returns The usage to report, with a field left out rather than set to `undefined` when this
	 * state has not recorded it.
	 */
	private static usageOf(
		state: TaskGenerationState,
	): { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } {
		const usage: { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } = {};
		if (state.promptTokenCount !== undefined) {
			usage.promptTokenCount = state.promptTokenCount;
		}
		if (state.completionTokenCount !== undefined) {
			usage.completionTokenCount = state.completionTokenCount;
		}
		if (state.stopReason !== undefined) {
			usage.stopReason = state.stopReason;
		}
		return usage;
	}

	/**
	 * Works out why generation stopped, in this stage's own vocabulary rather than an OpenAI value.
	 *
	 * @param criteria The stopping criteria generation ran with.
	 * @param generator The loaded text-generation pipeline, read for its model's own `eos_token_id`
	 * values.
	 * @param tokenIds The raw token identifiers generated for this answer, in order.
	 * @returns Why generation stopped.
	 */
	private static stopReasonOf(
		criteria: InterruptableStoppingCriteria,
		generator: TextGenerationPipeline,
		tokenIds: number[],
	): 'end_of_sequence' | 'max_new_tokens' | 'interrupted' {
		if (criteria.interrupted === true) {
			return 'interrupted';
		}
		const lastTokenId = tokenIds.at(-1);
		const eosTokenIds = StageHelperLlmGemma4E2bFull.eosTokenIdsOf(generator);
		if (lastTokenId !== undefined && eosTokenIds.includes(lastTokenId)) {
			return 'end_of_sequence';
		}
		return 'max_new_tokens';
	}

	/**
	 * Reads the model's own end-of-sequence token identifiers, normalized to an array.
	 *
	 * This model states them twice and the two statements disagree: `config.json` says `[1, 106]` and
	 * `generation_config.json` says `[1, 106, 50]`. `generation_config` is what is read here, because
	 * it is what `generate()` itself reads, so this stage tells `end_of_sequence` apart against the
	 * same list the engine stopped on. Which of the two lists is right for this model is settled by
	 * milestone 5 of https://github.com/webai-at-home/webai-at-home/issues/211, against a live run.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns The end-of-sequence token identifiers this model's `generation_config` declares.
	 */
	private static eosTokenIdsOf(generator: TextGenerationPipeline): number[] {
		const eosTokenId = (generator.model as unknown as { generation_config?: { eos_token_id?: number | number[] } }).generation_config?.eos_token_id;
		if (eosTokenId === undefined) {
			return [];
		}
		return Array.isArray(eosTokenId) ? eosTokenId : [eosTokenId];
	}

}
