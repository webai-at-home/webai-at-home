import {
	pipeline,
	StoppingCriteriaList,
	TextStreamer,
	InterruptableStoppingCriteria,
	type TextGenerationPipeline,
} from '@huggingface/transformers';
import {
	StagePayloadFactory,
	type GenerationSettings,
	type HistoryInput,
	type LlmStagePayload,
	type ResponseFormat,
	type ToolDeclaration,
} from '@webai/protocol';
import { ResponseConstraintBuilder } from './structured_output/response_constraint_builder.js';
import type { ForwardedResponseConstraint } from './structured_output/sampled_token_forwarder.js';
import { Gemma4E2bToolCallReader } from './gemma_4_e2b_tool_call_reader.js';
import { ChatTemplateTools } from './chat_template_tools.js';
import { Gemma4E2bHistoryMessages } from './gemma_4_e2b_history_messages.js';
import { StopSequenceWatcher } from './stop_sequence_watcher.js';
import { ThoughtChannelCut } from './thought_channel_cut.js';
import type { FullModelReadiness } from './stage_helper_llm_qwen3_5_0_8b_full.js';
import type { ModelDownloadProgress } from './model_download_progress.js';

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
	 * The shape the consumer asked its answer to be written in, or `undefined` when it asked for
	 * prose.
	 *
	 * Read once, from the run that starts the answer, and kept for the runs that carry it on, for the
	 * same reason {@link TaskGenerationState.declaredTools} is: only the first run of a task carries
	 * the settings. It decides whether a response constraint is built for the generation call at all,
	 * and a task that asks for nothing here generates byte for byte the answer it always did.
	 */
	responseFormat: ResponseFormat | undefined;
	/**
	 * The stop sequences the consumer asked to stop at, empty when it asked for none.
	 *
	 * Read once, from the run that starts the answer, and kept for the runs that carry it on, for the
	 * same reason {@link TaskGenerationState.declaredTools} is: only the first run of a task carries
	 * the settings, and the run that reports the finished answer is often a later one.
	 *
	 * Kept as the sequences rather than as the watcher built from them, because two watchers are made
	 * from them at two different moments: the one the generation stream forwards through, and the one
	 * {@link StageHelperLlmGemma4E2bFull.answerTextOf} cuts a tool run's re-decoded answer with.
	 */
	stopSequences: readonly string[];
	/**
	 * Whether this answer was generated with the model allowed to think before it answers.
	 *
	 * Kept on the state, rather than read from the generation settings where it is needed, for the same reason
	 * {@link TaskGenerationState.declaredTools} is: only the first run of a task carries the settings, and the run
	 * that reports the finished answer is often a later one.
	 *
	 * Two things read it. {@link StageHelperLlmGemma4E2bFull.compute} refuses to report such an answer one piece at
	 * a time, because where the thinking ends is only known once it has ended. And
	 * {@link StageHelperLlmGemma4E2bFull.answerTextOf} takes the thinking out before the answer is reported.
	 */
	isThinkingEnabled: boolean;
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
	 * `stop_sequence` is among them since milestone 1 of
	 * https://github.com/webai-at-home/webai-at-home/issues/222, because this task type now honours
	 * the `stopSequences` control there is a sequence to stop on. See `generation_control_support.ts`.
	 */
	stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' | undefined;
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
 * Of the six generation controls, this stage acts on three — `temperature`,
 * `maximumOutputTokenCount`, and `stopSequences` — since milestone 1 of
 * https://github.com/webai-at-home/webai-at-home/issues/222. Each of the three is acted on because
 * that issue's milestone 0 watched this model act on it in a real browser tab on WebGPU, and the
 * other three are not: `topP` and `randomSeed` because the same measurement found the engine reads
 * neither, and `reasoningEffort` because it is measured by
 * https://github.com/webai-at-home/webai-at-home/issues/223 and thinking stays off here until then.
 * A request that asked for none of the three generates byte for byte the answer it always did.
 *
 * Do not widen that set here before `generation_control_support.ts` names the control, and do not
 * name one there before a live run has watched this model act on it: a control acted on without
 * being declared is exactly as wrong as one declared without being acted on, and a control declared
 * from what a neighbouring row says would be a claim about the library standing in for a claim about
 * this model.
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
	 * @param generationSettings What the consumer asked for. `isStreaming` decides whether one run
	 * returns one piece and leaves the answer open, or reads the whole answer. `responseFormat`
	 * decides the shape the answer is written in, and is not a generation control: it is honoured
	 * against `structured_output_support.ts`. Of the generation controls, `temperature`,
	 * `maximumOutputTokenCount`, and `stopSequences` are acted on, because those three are what
	 * `generation_control_support.ts` names for this task type and what milestone 0 of
	 * https://github.com/webai-at-home/webai-at-home/issues/222 measured this model acting on. `topP`
	 * and `randomSeed` are not, because that measurement found the engine reads neither, and
	 * `reasoningEffort` is not, which is https://github.com/webai-at-home/webai-at-home/issues/223.
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
			state.stopSequences = generationSettings?.stopSequences ?? [];
			state.isThinkingEnabled = StageHelperLlmGemma4E2bFull.isThinkingEnabled(generationSettings);
		}
		// A history that declared tools is never read in pieces, even when the consumer asked for
		// pieces. Until the model has finished writing, a piece of a tool call is indistinguishable
		// from a piece of an answer — the two begin the same way — so reporting pieces would send a
		// consumer the raw `<|tool_call>` markup of a request it was supposed to receive as structured
		// data. One run reads the whole thing and returns either an answer or the tool calls.
		// An answer generated with thinking on is never reported one piece at a time. Where the thinking
		// ends is only known once it has ended, and `TextStreamer` gives no way to learn it in time: a
		// channel marker is a special token, and a streamer skipping special tokens emits no text for it
		// at all and does not flush what it has buffered, so the piece that follows the marker carries the
		// tail of the thinking merged with the start of the answer. Reporting the answer whole is what lets
		// {@link StageHelperLlmGemma4E2bFull.answerTextOf} cut it exactly, on the token identifiers.
		const wantsPieces = generationSettings?.isStreaming === true
			&& state.declaredTools.length === 0
			&& state.isThinkingEnabled === false;
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of run
		// that must not release what it was reading. Every other way out of this method — the finished
		// answer, and every failure — releases it.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await StageHelperLlmGemma4E2bFull.startGeneration(
				state,
				payload.history ?? payload.text ?? '',
				generationSettings,
			);
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
			// A tool call that cannot be read throws out of here, which fails the stage and names what
			// could not be read. That is deliberate: a calling program runs whatever tool call it
			// receives, so a call read wrongly is a call run wrongly on the caller's own machine.
			const toolCalls = Gemma4E2bToolCallReader.read(
				await StageHelperLlmGemma4E2bFull.toolCallTextOf(state),
				state.declaredTools,
			);
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
			// The response constraint builds the byte form of every token in this model's vocabulary
			// before it can mask anything, which was measured at 1128 to 1534 milliseconds for this
			// tokenizer's 262144 tokens. It is paid here, inside a load that already takes minutes,
			// rather than inside the first request that asks for a shape, where a consumer waits for
			// it. A tab that is never asked for a shape pays it and never uses it, which is the price
			// of no consumer ever waiting for it.
			ResponseConstraintBuilder.warmup(generator.tokenizer);
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
			responseFormat: undefined,
			stopSequences: [],
			isThinkingEnabled: false,
			generatedTokenIds: [],
			pieceCount: 0,
			isReleased: false,
			promptTokenCount: undefined,
			completionTokenCount: undefined,
			stopReason: undefined,
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
	 * @param generationSettings What the consumer asked for, read for the generation controls this
	 * task type honours, or `undefined` when it asked for nothing.
	 * @returns The reader that delivers the answer.
	 * @throws If the prompt or history is empty, if the model cannot be loaded, or if the assignment
	 * was taken away while the browser was loading the model.
	 */
	private static async startGeneration(
		state: TaskGenerationState,
		promptOrHistory: string | HistoryInput,
		generationSettings: GenerationSettings | undefined,
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
			enable_thinking: StageHelperLlmGemma4E2bFull.isThinkingEnabled(generationSettings),
			return_dict: false,
			...ChatTemplateTools.templateOption(state.declaredTools),
		});
		state.promptTokenCount = promptTensor.data?.length;
		const criteria = new InterruptableStoppingCriteria();
		state.criteria = criteria;
		state.reader = StageHelperLlmGemma4E2bFull
			.createGenerationStream(generator, promptOrHistory, criteria, state, generationSettings)
			.getReader();
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
	 * Generation acts on the three controls this task type honours — `temperature`,
	 * `maximumOutputTokenCount`, and `stopSequences` — and a request that asked for none of them
	 * generates byte for byte the answer it always did: `generationControlsOf` then returns the
	 * greedy call this stage has always made, and a watcher built from no stop sequence forwards
	 * every piece whole.
	 *
	 * Thinking stays off, whatever the consumer asked for, because `reasoningEffort` is measured by
	 * issue #223 and not by this one. Thinking off is not an arbitrary default: milestone 0 of
	 * issue #210 measured this model on a local server with thinking on and found it answer 515
	 * characters to a request budgeted at 8 tokens, so thinking is what makes this model's output
	 * unbounded rather than any property of the budget.
	 *
	 * A response format is not a generation control and is honoured: an answer asked for in a shape is
	 * generated through a response constraint, which masks every token the shape does not allow and
	 * stops the run when the shape is complete. An answer asked for in no shape is generated with the
	 * call this stage has always made — no logits processor, and this stage's own stopping criterion
	 * alone — so it is byte for byte the answer it always was.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param promptOrHistory The prompt or history to generate an answer for.
	 * @param criteria Stops generation early when the stream's reader is cancelled.
	 * @param state The generation state to record the completion token count and stop reason on.
	 * @param generationSettings What the consumer asked for, read for the generation controls this
	 * task type honours, or `undefined` when it asked for nothing.
	 * @returns A stream of the pieces of text the model produces, in order.
	 */
	private static createGenerationStream(
		generator: TextGenerationPipeline,
		promptOrHistory: string | HistoryInput,
		criteria: InterruptableStoppingCriteria,
		state: TaskGenerationState,
		generationSettings: GenerationSettings | undefined,
	): ReadableStream<string> {
		let isCancelled = false;
		const tokenIds = state.generatedTokenIds;
		const generationControls = StageHelperLlmGemma4E2bFull.generationControlsOf(generationSettings);
		// Built from the state rather than from the settings, because the settings arrive on the first
		// run of a task and this stream outlives that run.
		const stopSequenceWatcher = new StopSequenceWatcher(state.stopSequences);
		// A run that declared tools has to keep the special tokens, because every marker a tool call is
		// written with is a special token of this tokenizer and skipping them would strip the call down
		// to text no reader could find it in. A run that declared none keeps skipping them, so a task
		// submitted before tool calling existed receives byte for byte the answer it always did — and
		// so an answer reported one piece at a time never carries a marker, which is the one case
		// nothing could strip after the fact, a forwarded piece being impossible to recall.
		const keepsSpecialTokens = state.declaredTools.length > 0;
		// Built before the stream rather than inside the generation call, so that a schema the
		// package cannot enforce throws out of here and fails the stage, naming what it could not
		// keep, rather than starting a run that would answer half-enforced.
		const constraint = state.responseFormat === undefined
			? undefined
			: ResponseConstraintBuilder.build(generator.tokenizer, state.responseFormat);
		const stoppingCriteria = StageHelperLlmGemma4E2bFull.stoppingCriteriaOf(constraint, criteria);
		return new ReadableStream<string>({
			start(controller) {
				const streamer = new TextStreamer(generator.tokenizer, {
					skip_prompt: true,
					skip_special_tokens: keepsSpecialTokens === false,
					callback_function: (chunk: string) => {
						const forwardable = stopSequenceWatcher.accept(chunk);
						if (isCancelled === false && forwardable !== '') {
							controller.enqueue(forwardable);
						}
						// A stop sequence stops generation by interrupting it, which is an ordinary
						// stopping condition, so the generation resolves with what it had rather than
						// throwing. `stopReasonOf` reads the watcher before the interruption, so a run
						// stopped this way is told apart from one whose reader was cancelled.
						if (stopSequenceWatcher.hasStopped === true) {
							criteria.interrupt();
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
					: StageHelperLlmGemma4E2bFull.renderedPrompt(generator, promptOrHistory, state.declaredTools, generationSettings);
				generator(input, {
					...generationControls,
					return_full_text: false,
					tokenizer_encode_kwargs: { enable_thinking: StageHelperLlmGemma4E2bFull.isThinkingEnabled(generationSettings) },
					stopping_criteria: stoppingCriteria,
					streamer,
					...(constraint === undefined ? {} : { logits_processor: constraint.logitsProcessor }),
				}).then(() => {
					// Nothing may stay held back once generation has ended: there is no chunk after the
					// last one to release it.
					const remaining = stopSequenceWatcher.flush();
					if (isCancelled === false && remaining !== '') {
						controller.enqueue(remaining);
					}
					state.completionTokenCount = tokenIds.length;
					state.stopReason = StageHelperLlmGemma4E2bFull
						.stopReasonOf(criteria, generator, tokenIds, stopSequenceWatcher);
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
	 * The generation controls one call runs with, from what the consumer asked for.
	 *
	 * Three of the six are here, and each one is here because milestone 0 of
	 * https://github.com/webai-at-home/webai-at-home/issues/222 watched this model act on it in a
	 * real browser tab on WebGPU. `temperature` was read: one distinct answer of three at
	 * `temperature: 0` against three distinct of three at `temperature: 1.6`. The token limit was
	 * read: 8 asked for and 8 generated, against 32 asked for and 18 generated. `stopSequences` is
	 * kept by {@link StopSequenceWatcher} rather than by this call, which takes no such option.
	 *
	 * `topP` and `randomSeed` are absent because that same measurement found the engine reads
	 * neither: `top_p: 0.01` narrowed nothing, with and without `top_k: 0` beside it, and the loaded
	 * generation configuration carries no option whose name mentions a seed. Gaining either one means
	 * writing a sampler by hand, which is what `task_type_llm_qwen3_0_6b_sharded` did and which issue
	 * #222 does not propose. `reasoningEffort` is issue #223.
	 *
	 * Sampling is turned on only for a request that asked for a temperature. Milestone 0 found the
	 * settled question answered the same way with `do_sample` on and off, so this is not forced by a
	 * measurement; it is the rule `StageHelperLlmQwen3_5_0_8bFull` already follows, and keeping it
	 * costs nothing while one prompt answering the same way four times is no promise about every
	 * prompt.
	 *
	 * @param generationSettings What the consumer asked for, or `undefined` when it asked for
	 * nothing.
	 * @returns The controls to spread into the generation call.
	 */
	private static generationControlsOf(
		generationSettings: GenerationSettings | undefined,
	): { max_new_tokens: number; do_sample: boolean; temperature?: number } {
		const controls: { max_new_tokens: number; do_sample: boolean; temperature?: number } = {
			max_new_tokens: Math.min(MAX_NEW_TOKENS, generationSettings?.maximumOutputTokenCount ?? MAX_NEW_TOKENS),
			do_sample: generationSettings?.temperature !== undefined,
		};
		if (generationSettings?.temperature !== undefined) {
			controls.temperature = generationSettings.temperature;
		}
		return controls;
	}

	/**
	 * Decides whether this model is allowed to think before it answers, from what the consumer asked
	 * for.
	 *
	 * This model thinks, and this engine really does act on `enable_thinking`: milestone 0 of
	 * [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223) rendered the same history
	 * both ways in a real browser tab on WebGPU and got two different prompts, 22 tokens against 29,
	 * where `true` opens a system turn holding `<|think|>` that `false` has not got. A history that
	 * declared a tool reads the option too, 84 tokens against 86, which is why all three places this
	 * stage passes it read the same setting.
	 *
	 * Thinking on or off is all this engine can express, so every level above `none` reads the same
	 * here. A consumer asking for `xhigh` is not being refused and is not being ignored; it is being
	 * told, by this task type's contract, that the control is honoured, and this is how coarsely. The
	 * local server the native worker talks to is no finer: that same milestone sent all six levels to
	 * Ollama serving `gemma4:e2b` and got 8 completion tokens with no reasoning for `none` and an
	 * identical 114 tokens with reasoning for each of the other five.
	 *
	 * An answer that asked for nothing does not think, which is what this stage did before any of this
	 * was settable, so such a request is generated exactly as it is today. That milestone also measured
	 * what thinking costs on this model, and the default is worth keeping: the same settled question
	 * answered in 8 completion tokens without it and 114 with it, for the same answer.
	 *
	 * @param generationSettings What the consumer asked for, or `undefined` when it asked for nothing.
	 * @returns `true` when the model may think before it answers.
	 */
	private static isThinkingEnabled(generationSettings: GenerationSettings | undefined): boolean {
		if (generationSettings?.reasoningEffort === undefined) {
			return false;
		}
		return generationSettings.reasoningEffort !== 'none';
	}

	/**
	 * The stopping criteria one generation call runs with.
	 *
	 * `stopping_criteria` is a single option of the generation call, and a constrained run wants that
	 * option for the constraint while this stage wants it for the criterion that stops a run whose
	 * reader was cancelled. Both go into one list, which is what `StoppingCriteriaList` is for.
	 *
	 * The constraint's criteria come first. The first of them is what tells the constraint's grammar
	 * which token the sampler chose, and the second is the constraint's own criterion reading that
	 * grammar, so asking them in that order is what lets a run stop on the step its shape completes
	 * rather than one token later.
	 *
	 * @param constraint The response constraint this run generates through, or `undefined` when the
	 * consumer asked for no shape.
	 * @param criteria This stage's own criterion, which stops generation when the stream's reader is
	 * cancelled.
	 * @returns This stage's own criterion alone for an unconstrained run, which is what this stage
	 * has always passed, and the two kinds in one list otherwise.
	 */
	private static stoppingCriteriaOf(
		constraint: ForwardedResponseConstraint | undefined,
		criteria: InterruptableStoppingCriteria,
	): InterruptableStoppingCriteria | StoppingCriteriaList {
		if (constraint === undefined) {
			return criteria;
		}
		const stoppingCriteria = new StoppingCriteriaList();
		stoppingCriteria.extend(constraint.stoppingCriteria);
		stoppingCriteria.extend(criteria);
		return stoppingCriteria;
	}

	/**
	 * The text a tool call is looked for in, for a run whose model may have thought first.
	 *
	 * A run that was not allowed to think reads the text the generation stream produced, byte for byte as this stage
	 * has always read it.
	 *
	 * A run that was allowed to think has the model's own thinking taken out first, on the token identifiers, and is
	 * then decoded keeping the special tokens — because the tool call markers this reader looks for are special
	 * tokens themselves. The reader scans whatever text it is handed, so without this cut a tool call the model wrote
	 * inside its thinking, while working out what to do, is read as a call it decided on. The thinking is the model's
	 * own working, and no part of it is a decision the consumer asked for.
	 *
	 * This is kept on that reasoning rather than on an observed failure. Milestone 4 of
	 * [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223) ran the live test that covers this
	 * combination against the uncut reader as well, and it passed: asked for the weather of one city at
	 * `reasoning_effort: "high"`, this model wrote no tool call inside its thinking. Whether it writes one is the
	 * model's choice on the day, and a call run wrongly is run on the caller's own machine.
	 *
	 * @param state The generation state holding the text read and the tokens it came from.
	 * @returns The text to look for a tool call in.
	 */
	private static async toolCallTextOf(state: TaskGenerationState): Promise<string> {
		if (state.isThinkingEnabled === false) {
			return state.text;
		}
		const generator = await StageHelperLlmGemma4E2bFull.loadedGenerator();
		return (
			generator.tokenizer as unknown as {
				decode: (tokenIds: number[], options: Record<string, unknown>) => string;
			}
		).decode(
			ThoughtChannelCut.outsideEveryChannel(generator.tokenizer, state.generatedTokenIds),
			{ skip_special_tokens: false },
		);
	}

	/**
	 * The answer to report, for a run whose model wrote words rather than asking for a tool.
	 *
	 * A run that declared no tool and was not allowed to think decoded with the special tokens skipped already, so
	 * the text it read is the answer, byte for byte as this stage has always reported it.
	 *
	 * A run that declared tools had to keep the special tokens, so its text ends in the end-of-turn marker the model
	 * wrote, which no consumer asked for. The answer is arrived at by decoding the same token identifiers a second
	 * time with the special tokens skipped, rather than by cutting markers off the text: the set of markers this
	 * model may write is the model's, not this file's, and a list of them written here would be one more thing to
	 * keep in step with the model.
	 *
	 * A run that was allowed to think has the model's own thinking to take out as well, which
	 * {@link ThoughtChannelCut} does on those same identifiers. Nothing in this cluster carries a model's thinking
	 * beside its answer, so an answer that thought has to arrive with the thinking already gone — and the native
	 * worker's answer already does, the local server putting its thinking in a `reasoning` field that
	 * `OpenaiApiClient` never reads. See milestone 1 of
	 * [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223), which measured both.
	 *
	 * That second decoding goes round the watcher the generation stream forwarded through, so it is cut by a watcher
	 * of its own. Without it, a task that declared tools and asked for a stop sequence would have generation stopped
	 * at the sequence and then report the sequence anyway, which is the control half kept — and a control declared
	 * and half kept is not honoured. A task that asked for a stop sequence and asked the model to think is the one
	 * case these two controls read each other: the watcher the stream forwards through sees the thinking as well as
	 * the answer, so a sequence the model happens to write while thinking stops generation before the answer begins.
	 * That is recorded rather than worked around, in the milestone 1 comment of issue #223.
	 *
	 * @param state The generation state holding the text read and the tokens it came from.
	 * @returns The answer text to report.
	 */
	private static async answerTextOf(state: TaskGenerationState): Promise<string> {
		if (state.declaredTools.length === 0 && state.isThinkingEnabled === false) {
			return state.text;
		}
		const generator = await StageHelperLlmGemma4E2bFull.loadedGenerator();
		const answerTokenIds = state.isThinkingEnabled === false
			? state.generatedTokenIds
			: ThoughtChannelCut.outsideEveryChannel(generator.tokenizer, state.generatedTokenIds);
		const decoded = (
			generator.tokenizer as unknown as {
				decode: (tokenIds: number[], options: Record<string, unknown>) => string;
			}
		).decode(answerTokenIds, { skip_special_tokens: true });
		const stopSequenceWatcher = new StopSequenceWatcher(state.stopSequences);
		return stopSequenceWatcher.accept(decoded) + stopSequenceWatcher.flush();
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
	 * @param generationSettings What the consumer asked for, or `undefined` when it asked for nothing.
	 * @returns The prompt text to generate from.
	 */
	private static renderedPrompt(
		generator: TextGenerationPipeline,
		promptOrHistory: string | HistoryInput,
		declaredTools: readonly ToolDeclaration[],
		generationSettings: GenerationSettings | undefined,
	): string {
		return (
			generator.tokenizer as unknown as {
				apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => string;
			}
		).apply_chat_template(Gemma4E2bHistoryMessages.of(promptOrHistory), {
			tokenize: false,
			add_generation_prompt: true,
			enable_thinking: StageHelperLlmGemma4E2bFull.isThinkingEnabled(generationSettings),
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
	): { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' } {
		const usage: { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' } = {};
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
	 * @param stopSequenceWatcher The watcher that was forwarding this answer, read before the
	 * interruption because a stop sequence stops generation by interrupting it, and the two mean
	 * different things.
	 * @returns Why generation stopped.
	 */
	private static stopReasonOf(
		criteria: InterruptableStoppingCriteria,
		generator: TextGenerationPipeline,
		tokenIds: number[],
		stopSequenceWatcher: StopSequenceWatcher,
	): 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' {
		if (stopSequenceWatcher.hasStopped === true) {
			return 'stop_sequence';
		}
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
