import { pipeline, TextStreamer, InterruptableStoppingCriteria, type Message, type TextGenerationPipeline } from '@huggingface/transformers';
import { StagePayloadFactory, type HistoryInput, type GenerationSettings, type LlmStagePayload, type ToolDeclaration } from '@webai/protocol';
import { ToolCallReader } from './tool_call_reader.js';
import type { ModelDownloadProgress } from './model_download_progress.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmQwen3_5_0_8bFull — runs the complete Qwen3.5-0.8B model in a worker browser
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Pinned Hugging Face identifier for the ONNX export this stage runs.
 *
 * `Qwen/Qwen3.5-0.8B`, the model named by
 * https://github.com/webai-at-home/webai-at-home/issues/96, ships only `safetensors`
 * checkpoints and no ONNX Runtime Web-compatible file. `onnx-community/Qwen3.5-0.8B-ONNX` is
 * the ONNX export of that same base model, recorded here as the asset this stage actually
 * downloads and runs. It is `apache-2.0` licensed, the same licence as the base model.
 */
const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
/**
 * Immutable Hugging Face revision of {@link MODEL_ID}, so a later commit to that repository
 * cannot change what this worker downloads. Confirmed against the real repository before this
 * stage was implemented, together with the file list, sizes, and architecture below.
 */
const MODEL_REVISION = 'c0d619322dad7c4441a8841a53fc59772ddddcc0';
/**
 * The quantization this stage loads, out of the five the export publishes.
 *
 * `fp16` is close to 2 GB of weights; `q4f16` is close to 600 MB, which is the largest download
 * a volunteer device running this project has been asked for so far and is treated as the
 * practical ceiling for a task a browser tab downloads on demand.
 */
const MODEL_DTYPE = 'q4f16';
/**
 * The smallest amount of free storage this browser must report before this stage is offered.
 *
 * The two graphs this stage downloads at {@link MODEL_DTYPE} measured about 584 MB
 * (437 MB decoder plus 147 MB token embedding) plus a 19 MB tokenizer in a live run against the
 * pinned revision, so this leaves headroom above the roughly 604 MB actually needed.
 */
const MINIMUM_FREE_STORAGE_BYTES = 700 * 1024 * 1024;
/**
 * Maximum number of new tokens generated for one answer, as a safety bound if the model never
 * emits an end-of-sequence token. The model's own `generation_config.json` supplies the actual
 * end-of-sequence token identifiers, so none is hard-coded here.
 */
const MAX_NEW_TOKENS = 1024;
/**
 * The largest number of pieces one answer may be read in, the same kind of bound as
 * `MAX_NEW_TOKENS` but for a task that asked for its answer piece by piece.
 */
const MAXIMUM_ANSWER_PIECES = 400;
/**
 * How long an answer held open between runs waits for the run that carries it on.
 *
 * Matches `stage_helper_llm_gemma_nano_chrome_full.ts`'s own timeout and reasoning: the stage's
 * assignment lease is 60 seconds and the gateway assigns the next run as soon as the previous
 * result arrives, so a wait this long means the task is not coming back.
 */
const ANSWER_IDLE_TIMEOUT_MS = 300_000;

/** The minimal shape of the WebGPU adapter this helper reads, not part of the browser type definitions this project compiles against. */
type GpuAdapterLike = { features: { has(featureName: string): boolean } };
/** The minimal shape of `navigator.gpu` this helper reads. */
type GpuLike = { requestAdapter(): Promise<GpuAdapterLike | null> };

/** Whether this browser can run the stage, and why not when it cannot. */
export type FullModelReadiness =
	| { status: 'ready' }
	| { status: 'unavailable'; message: string };

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
	 * One tab can hold two runs of one task at once: a lease that expires while a run is under
	 * way has the gateway assign the stage again, and this stage asks for that retry to come
	 * back to the same tab. Each run releases the generation when it is finished with it, and
	 * only the run named here may, so the run that was replaced cannot release the generation
	 * its replacement is reading.
	 */
	owningStageAssignmentId: string;
	/**
	 * What has been read from the model but not yet returned as a stage result.
	 *
	 * A run that is replaced while it is waiting for a piece still receives that piece, because
	 * the model has already handed it over and a stream cannot give it back. That run may not
	 * answer, so the piece is kept here for the run that replaced it to report.
	 */
	unreportedText: string;
	/** The timer that gives up an answer nobody has come back for. See `ANSWER_IDLE_TIMEOUT_MS`. */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/** How many pieces have been read, which bounds how long one answer may be read for. */
	pieceCount: number;
	/**
	 * Whether {@link StageHelperLlmQwen3_5_0_8bFull.clearGeneration} has released this
	 * generation while the stage run still had it in hand.
	 *
	 * Read at the two points a run can learn its work is no longer wanted: after a read, because
	 * a cancelled reader ends the read waiting on it as if the model had finished, and after the
	 * model session is created, because a release that arrives while the session is still
	 * loading has no reader yet to cancel.
	 */
	isReleased: boolean;
	/**
	 * The exact number of tokens the prompt was encoded into, once known.
	 *
	 * Counted from `generator.tokenizer.apply_chat_template`, the same call `generate()` itself
	 * makes to encode the prompt, so this is what was actually fed to the model rather than an
	 * estimate. See milestone 3 of
	 * https://github.com/webai-at-home/webai-at-home/issues/150.
	 */
	promptTokenCount: number | undefined;
	/**
	 * The exact number of tokens the model generated for this answer, once generation has
	 * finished.
	 *
	 * Counted from `TextStreamer`'s `token_callback_function`, which is called with every raw
	 * token id the model produces. See milestone 3 of
	 * https://github.com/webai-at-home/webai-at-home/issues/150.
	 */
	completionTokenCount: number | undefined;
	/**
	 * Why generation stopped, once it has, in this stage's own word for it rather than an OpenAI
	 * value. See milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/150.
	 */
	stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | undefined;
	/**
	 * The tools this task's history declared, kept for as long as the answer is being read.
	 *
	 * Needed after generation as well as before it: a tool call is refused unless it names one of
	 * these, so a model that invents a tool is reported rather than believed. Empty when the
	 * history declared none, which is every task submitted before tool calling existed.
	 */
	declaredTools: readonly ToolDeclaration[];
};

/**
 * Runs the complete Qwen3.5-0.8B model, downloaded once and held in this browser's memory for
 * as long as the page stays open, in as many stage runs as the consumer asked its answer to
 * arrive in.
 *
 * Unlike `stage_helper_llm_qwen3_0_6b_sharded.ts`, this helper does not build ONNX Runtime Web
 * feeds by hand. Qwen3.5-0.8B is a hybrid architecture: of its 24 layers, 18 are
 * `linear_attention` layers carrying their own convolution and recurrent state
 * (`past_conv.N`/`past_recurrent.N`), and only every fourth layer is an ordinary
 * `full_attention` layer with a `past_key_values.N` cache. Building that cache from scratch
 * would mean reimplementing this project has no reference for. `@huggingface/transformers`
 * already recognises this architecture and builds its feeds correctly — confirmed with a live
 * run against the pinned revision below, on the WebGPU backend, before this stage was written
 * (see the `packages/_onnx_experiments/public/qwen3_5-0.8b-gate/` de-risk gate for
 * https://github.com/webai-at-home/webai-at-home/issues/96) — so this stage is built on it
 * instead. That live run measured about 163 seconds to download and load the model on a cold
 * cache, and about 7 seconds to generate a short answer once loaded.
 *
 * The model is loaded once per page and shared by every task this browser runs, unlike the
 * built-in Chrome model, where each task gets its own browser-managed session. Only the
 * generation in progress is kept per task here.
 *
 * The browser produces an answer in pieces, and what one stage run does with those pieces is
 * decided by the `isStreaming` generation setting the consumer submitted, exactly as
 * `stage_helper_llm_gemma_nano_chrome_full.ts` does it:
 *
 * - Asked for nothing, one run reads every piece of the answer and returns the whole thing.
 * - Asked for the answer in pieces, one run reads one piece and returns it, and the generation
 *   stays open in this tab for the run that follows.
 */
export class StageHelperLlmQwen3_5_0_8bFull {
	/**
	 * The computation this worker browser implements, named the way a pipeline stage names
	 * its computation.
	 */
	static readonly computation = 'llm_qwen3_5_0_8b_full';

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmQwen3_5_0_8bFull.computation;
	}

	/**
	 * The generations this browser is currently producing, by task identifier. See
	 * `stage_helper_llm_gemma_nano_chrome_full.ts`'s own field of this name for why a map keyed
	 * by task rather than by assignment.
	 */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/** The loaded pipeline, shared by every task, once `preload` or the first run has created it. */
	private static generatorPromise: Promise<TextGenerationPipeline> | undefined;

	/**
	 * Reports whether this browser can run the stage, without downloading anything.
	 *
	 * This is asked before the browser advertises the stage, so a browser that cannot run the
	 * model says so at once instead of accepting work it would fail. The three checks are the
	 * three things a live run against the pinned revision actually needed: a WebGPU adapter, that
	 * adapter's support for 16-bit floating point shaders (`q4f16` needs it), and enough free
	 * storage for the download.
	 *
	 * @returns Whether the stage can be run, and why not when it cannot.
	 */
	static async readiness(): Promise<FullModelReadiness> {
		const gpu = (globalThis.navigator as { gpu?: GpuLike }).gpu;
		if (gpu === undefined) {
			return {
				status: 'unavailable',
				message: 'This browser has no WebGPU support, which the Qwen3.5-0.8B stage needs.',
			};
		}
		const adapter = await gpu.requestAdapter().catch(() => null);
		if (adapter === null) {
			return {
				status: 'unavailable',
				message: 'This browser reports WebGPU but no adapter could be requested.',
			};
		}
		if (adapter.features.has('shader-f16') === false) {
			return {
				status: 'unavailable',
				message: "This browser's WebGPU adapter does not support 16-bit floating point shaders, which the Qwen3.5-0.8B stage needs.",
			};
		}
		const estimate = await globalThis.navigator.storage?.estimate().catch(() => undefined);
		if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < MINIMUM_FREE_STORAGE_BYTES) {
			return {
				status: 'unavailable',
				message: `This browser reports too little free storage for the Qwen3.5-0.8B download, which needs about ${Math.round(MINIMUM_FREE_STORAGE_BYTES / (1024 * 1024))} MB.`,
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
		return StageHelperLlmQwen3_5_0_8bFull.loadedGenerator(onProgress).then(() => undefined);
	}

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer
	 * asked for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this run
	 * is the one allowed to release the answer it is reading.
	 * @param payload The prompt or history submitted with the task, or, on a run that carries
	 * an answer on, a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for. Only `isStreaming` is read: set, one
	 * run returns one piece and leaves the answer open for the run that follows; absent, one run
	 * returns the whole answer.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the model cannot be loaded, if the run is asked to carry on an answer this
	 * browser is not holding, if the answer is abandoned before or while it is being read, or if
	 * generation reports an error.
	 */
	static async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
	): Promise<LlmStagePayload> {
		const state = payload.isContinuation === true
			? StageHelperLlmQwen3_5_0_8bFull.heldGeneration(taskId, stageAssignmentId)
			: StageHelperLlmQwen3_5_0_8bFull.newGeneration(taskId, stageAssignmentId);
		if (payload.isContinuation !== true) {
			state.declaredTools = payload.history?.tools ?? [];
		}
		// A history that declared tools is never read in pieces, even when the consumer asked for
		// pieces. Until the model has finished writing, a piece of a tool call is indistinguishable
		// from a piece of an answer — the two begin the same way — so reporting pieces would send a
		// consumer the raw `<tool_call>` markup of a request it was supposed to receive as structured
		// data. One run reads the whole thing and returns either an answer or the tool calls.
		const wantsPieces = generationSettings?.isStreaming === true && state.declaredTools.length === 0;
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of
		// run that must not release what it was reading. Every other way out of this method — the
		// finished answer, and every failure — releases it.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await StageHelperLlmQwen3_5_0_8bFull.startGeneration(state, payload.history ?? payload.text ?? '');
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
				StageHelperLlmQwen3_5_0_8bFull.refuseIfReplaced(state, stageAssignmentId);
				if (wantsPieces === true) {
					leavesAnswerOpen = true;
					const reported = state.unreportedText;
					state.unreportedText = '';
					StageHelperLlmQwen3_5_0_8bFull.waitForTheRunAfterThis(taskId, state);
					return StagePayloadFactory.llmPartialText(reported);
				}
			}
			StageHelperLlmQwen3_5_0_8bFull.refuseIfReplaced(state, stageAssignmentId);
			// A tool call that cannot be read throws out of here, which fails the stage and names what
			// could not be read. That is deliberate: a calling program runs whatever tool call it
			// receives, so a call read wrongly is a call run wrongly on the caller's own machine.
			const toolCalls = ToolCallReader.read(state.text, state.declaredTools);
			if (toolCalls.length > 0) {
				return StagePayloadFactory.llmToolCalls(toolCalls, StageHelperLlmQwen3_5_0_8bFull.usageOf(state));
			}
			return StagePayloadFactory.llmDone(state.text, undefined, StageHelperLlmQwen3_5_0_8bFull.usageOf(state));
		} finally {
			if (leavesAnswerOpen === false) {
				StageHelperLlmQwen3_5_0_8bFull.clearGeneration(taskId, stageAssignmentId);
			}
		}
	}

	/**
	 * Releases every answer this browser is holding, without unloading the model itself.
	 *
	 * Called when the connection to the gateway goes away, for the same reason
	 * `stage_helper_llm_gemma_nano_chrome_full.ts` releases its own generations then: no run can
	 * arrive to carry an open answer on while there is no connection to assign one.
	 */
	static clearEveryGeneration(): void {
		for (const [taskId, state] of StageHelperLlmQwen3_5_0_8bFull.stateByTaskId) {
			StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.delete(taskId);
			StageHelperLlmQwen3_5_0_8bFull.release(state);
		}
	}

	/**
	 * Releases the answer this browser is producing for one task, if the assignment named is the
	 * one currently reading it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		const state = StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.get(taskId);
		if (state === undefined || state.owningStageAssignmentId !== stageAssignmentId) {
			return;
		}
		StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.delete(taskId);
		StageHelperLlmQwen3_5_0_8bFull.release(state);
	}

	/**
	 * Loads the tokenizer and creates the text-generation pipeline once per page.
	 *
	 * @param onProgress Called with progress steps while the model downloads and loads.
	 * @returns The loaded pipeline.
	 */
	private static loadedGenerator(onProgress?: (progress: ModelDownloadProgress) => void): Promise<TextGenerationPipeline> {
		if (StageHelperLlmQwen3_5_0_8bFull.generatorPromise !== undefined) {
			return StageHelperLlmQwen3_5_0_8bFull.generatorPromise;
		}
		onProgress?.({ kind: 'message', message: `Downloading ${MODEL_ID}. This can take a while on the first run…` });
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
			onProgress?.({ kind: 'message', message: 'Qwen3.5-0.8B ready.' });
			return generator;
		}).catch((error: unknown) => {
			StageHelperLlmQwen3_5_0_8bFull.generatorPromise = undefined;
			throw error;
		});
		StageHelperLlmQwen3_5_0_8bFull.generatorPromise = loadPromise;
		return loadPromise;
	}

	/** Creates and stores fresh generation state for a task's first round. */
	private static newGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		// A task asks for its answer once, so anything still held for this task is left over from
		// an attempt that was given up on without being cancelled.
		const abandoned = StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.get(taskId);
		if (abandoned !== undefined) {
			StageHelperLlmQwen3_5_0_8bFull.release(abandoned);
		}
		const state: TaskGenerationState = {
			criteria: undefined,
			reader: undefined,
			owningStageAssignmentId: stageAssignmentId,
			unreportedText: '',
			idleTimer: undefined,
			text: '',
			pieceCount: 0,
			isReleased: false,
			promptTokenCount: undefined,
			completionTokenCount: undefined,
			stopReason: undefined,
			declaredTools: [],
		};
		StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.set(taskId, state);
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
		const state = StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.get(taskId);
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
			if (StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.get(taskId) !== state) {
				return;
			}
			StageHelperLlmQwen3_5_0_8bFull.stateByTaskId.delete(taskId);
			StageHelperLlmQwen3_5_0_8bFull.release(state);
		}, ANSWER_IDLE_TIMEOUT_MS);
	}

	/**
	 * Ends one answer: stops generation and gives back what the browser holds for it.
	 *
	 * The model itself, and the graphics memory its session holds, are left alone — they are
	 * shared by every task and only released when the page is closed.
	 *
	 * @param state The answer to release.
	 */
	private static release(state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		// Set before either of the two below, for the same reason as
		// `stage_helper_llm_gemma_nano_chrome_full.ts`'s own release: both are how a waiting run
		// learns it has been released, and neither exists yet when the release arrives while the
		// model is still loading.
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
	 * @throws If the prompt or history is empty, if the model cannot be loaded, or if the
	 * assignment was taken away while the browser was loading the model.
	 */
	private static async startGeneration(
		state: TaskGenerationState,
		promptOrHistory: string | HistoryInput,
	): Promise<ReadableStreamDefaultReader<string>> {
		if (StageHelperLlmQwen3_5_0_8bFull.isEmpty(promptOrHistory)) {
			throw new Error('A prompt is needed to start an answer.');
		}
		const generator = await StageHelperLlmQwen3_5_0_8bFull.loadedGenerator();
		// Loading the model is the slowest part of a run — about 163 seconds on a cold cache in
		// testing — and the assignment can be taken away while it is happening. A release that
		// arrives then leaves this flag and nothing else, since no reader exists yet to cancel;
		// reading it here is what stops the browser starting a whole generation for a task that
		// was already given up on before the model was ready.
		if (state.isReleased === true) {
			throw new Error('The answer this stage was to produce was abandoned before the model was ready.');
		}
		// The same encoding `generate()` itself applies to the prompt, so this is the exact count of
		// what was fed to the model rather than an estimate. See milestone 0's de-risk gate for
		// https://github.com/webai-at-home/webai-at-home/issues/150.
		const promptTensor = (
			generator.tokenizer as unknown as {
				apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => { data?: ArrayLike<number> };
			}
		).apply_chat_template(StageHelperLlmQwen3_5_0_8bFull.messagesOf(promptOrHistory), {
			tokenize: true,
			add_generation_prompt: true,
			enable_thinking: false,
			return_dict: false,
			...StageHelperLlmQwen3_5_0_8bFull.toolTemplateOption(state.declaredTools),
		});
		state.promptTokenCount = promptTensor.data?.length;
		const criteria = new InterruptableStoppingCriteria();
		state.criteria = criteria;
		state.reader = StageHelperLlmQwen3_5_0_8bFull.createGenerationStream(generator, promptOrHistory, criteria, state).getReader();
		return state.reader;
	}

	/**
	 * Builds the `tools` option handed to the chat template, or nothing at all when the history
	 * declared no tool.
	 *
	 * Nothing is added to the call when there are no tools, rather than an empty list, so that every
	 * task submitted before tool calling existed produces byte for byte the prompt it always did.
	 *
	 * @param declaredTools The tools the history declared.
	 * @returns The option to spread into the chat template call, empty when no tool was declared.
	 */
	private static toolTemplateOption(declaredTools: readonly ToolDeclaration[]): Record<string, unknown> {
		if (declaredTools.length === 0) {
			return {};
		}
		return {
			tools: ToolCallReader.toChatTemplateTools(declaredTools),
		};
	}

	/**
	 * Reports whether a prompt or history carries nothing to answer.
	 *
	 * A history that reached this point always has at least one message, because
	 * `HistoryInputSchema` refuses an empty one at submission; this still checks rather than
	 * assuming it, so a payload with neither `text` nor `history` set is caught here as the
	 * empty string {@link compute} falls back to, the same way an empty prompt always was.
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
	 * `token_callback_function`, and works out why generation stopped once it has — the three
	 * ways Milestone 0's de-risk gate found generation to end for this model, distinguished the
	 * same way that gate did: `criteria.interrupted`, whether the last generated token id is one
	 * of the model's own `eos_token_id` values, or otherwise the `MAX_NEW_TOKENS` cap. Both are
	 * written onto `state` rather than returned, because a `ReadableStream<string>` has nowhere
	 * else to carry them. See milestone 3 of
	 * https://github.com/webai-at-home/webai-at-home/issues/150.
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
		const tokenIds: number[] = [];
		// `<tool_call>` and `</tool_call>` are added tokens of this tokenizer with `special: false`,
		// read off the pinned revision's own tokenizer.json, so they survive this decoding and the
		// setting below does not have to change for a tool call to arrive intact.
		let writtenSoFar = '';
		return new ReadableStream<string>({
			start(controller) {
				const streamer = new TextStreamer(generator.tokenizer, {
					skip_prompt: true,
					skip_special_tokens: true,
					callback_function: (chunk: string) => {
						writtenSoFar += chunk;
						// Stop the moment the model has finished asking for a tool. Nothing after a
						// complete tool call is wanted, and on a volunteer's browser the tokens that
						// would follow are not cheap. Interrupting is an ordinary stopping condition,
						// so the generation resolves with what it had rather than throwing.
						if (state.declaredTools.length > 0 && ToolCallReader.hasCompleteToolCall(writtenSoFar) === true) {
							criteria.interrupt();
						}
						if (isCancelled === false) {
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
					? StageHelperLlmQwen3_5_0_8bFull.messagesOf(promptOrHistory)
					: StageHelperLlmQwen3_5_0_8bFull.renderedPrompt(generator, promptOrHistory, state.declaredTools);
				generator(input, {
					max_new_tokens: MAX_NEW_TOKENS,
					do_sample: false,
					return_full_text: false,
					tokenizer_encode_kwargs: { enable_thinking: false },
					stopping_criteria: criteria,
					streamer,
				}).then(() => {
					state.completionTokenCount = tokenIds.length;
					state.stopReason = StageHelperLlmQwen3_5_0_8bFull.stopReasonOf(criteria, generator, tokenIds);
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
	 * Builds the `usage` argument {@link StagePayloadFactory.llmDone} takes, from whatever this
	 * state managed to record.
	 *
	 * Built field by field rather than by spreading `state` itself, because `state`'s own fields
	 * are typed `| undefined` from being read before generation finishes, while
	 * {@link StagePayloadFactory.llmDone}'s `usage` parameter types each field as merely
	 * optional — the same distinction `exactOptionalPropertyTypes` enforces throughout this
	 * repository.
	 *
	 * @param state The generation state to read.
	 * @returns The usage to report, with a field left out rather than set to `undefined` when
	 * this state has not recorded it.
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
	 * Works out why generation stopped, in this stage's own vocabulary rather than an OpenAI
	 * value, from the same three signals Milestone 0's de-risk gate proved cleanly distinguish
	 * the three ways this model's generation can end.
	 *
	 * @param criteria The stopping criteria generation ran with.
	 * @param generator The loaded text-generation pipeline, read for its model's own
	 * `eos_token_id` values.
	 * @param tokenIds The raw token ids generated for this answer, in order.
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
		const eosTokenIds = StageHelperLlmQwen3_5_0_8bFull.eosTokenIdsOf(generator);
		if (lastTokenId !== undefined && eosTokenIds.includes(lastTokenId)) {
			return 'end_of_sequence';
		}
		return 'max_new_tokens';
	}

	/**
	 * Reads the model's own end-of-sequence token identifiers, normalized to an array.
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

	/**
	 * Builds the message list handed to the text-generation pipeline, from either a prompt or a
	 * history.
	 *
	 * A single prompt becomes the one user message this stage has always sent. A history
	 * becomes its messages, each carrying the role it was given, so `@huggingface/transformers`
	 * applies the model's own chat template to real turns — a system message reaches the slot the
	 * template has for it — instead of receiving one user message whose content happens to be a
	 * flattened transcript.
	 *
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The message list to pass to the text-generation pipeline.
	 */
	private static messagesOf(promptOrHistory: string | HistoryInput): Message[] {
		if (typeof promptOrHistory === 'string') {
			return [{ role: 'user', content: promptOrHistory }];
		}
		// `Message` declares `role` and `content` and nothing else, while this model's chat template
		// reads a `tool_calls` field beside them and renders it — proved in the de-risk gate for
		// https://github.com/webai-at-home/webai-at-home/issues/115. The cast is that gap, and is kept
		// to the one message that needs it rather than widening the whole return type.
		return promptOrHistory.messages.map((message): Message => {
			if (message.toolCalls === undefined) {
				return { role: message.role, content: message.content };
			}
			// An assistant message that asked for tools is handed back in the shape the template reads,
			// so the template renders it into the same form the model itself writes. That is what lets
			// a history carrying a finished tool round trip be answered: the model reads its own
			// earlier request written the way it would have written it, not a rewriting of it.
			return {
				role: message.role,
				content: message.content,
				tool_calls: message.toolCalls.map((toolCall) => ({
					type: 'function',
					function: {
						name: toolCall.name,
						arguments: toolCall.argumentValues,
					},
				})),
			} as unknown as Message;
		});
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
		).apply_chat_template(StageHelperLlmQwen3_5_0_8bFull.messagesOf(promptOrHistory), {
			tokenize: false,
			add_generation_prompt: true,
			enable_thinking: false,
			...StageHelperLlmQwen3_5_0_8bFull.toolTemplateOption(declaredTools),
		});
	}
}
