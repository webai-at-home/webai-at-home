import { StagePayloadFactory, type ConversationInput, type GenerationSettings, type LlmStagePayload } from '@webai/protocol';
import type { ChatCompletionStreamUsage, OpenaiApiClient } from '../libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmLlama3_2_3bFull — runs Llama 3.2 3B through a local OpenAI-compatible server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The largest number of pieces one answer may be read in, a safety bound if the local server
 * never stops streaming. The same kind of bound as
 * `stage_helper_llm_qwen3_5_0_8b_full.ts`'s own `MAXIMUM_ANSWER_PIECES`.
 */
const MAXIMUM_ANSWER_PIECES = 2000;

/**
 * How long an answer held open between runs waits for the run that carries it on.
 *
 * Matches `stage_helper_llm_qwen3_5_0_8b_full.ts`'s own timeout and reasoning: the stage's
 * assignment lease is 60 seconds and the gateway assigns the next run as soon as the previous
 * result arrives, so a wait this long means the task is not coming back.
 */
const ANSWER_IDLE_TIMEOUT_MS = 300_000;

/** Whether this worker can run the stage, and why not when it cannot. */
export type LocalModelReadiness =
	| { status: 'ready' }
	| { status: 'unavailable'; message: string };

/** One answer this worker is producing, kept in memory while its stage runs read it. */
type TaskGenerationState = {
	/**
	 * Stops the request to the local server this state is reading from, once it has started.
	 *
	 * Aborting is a normal way to end this request, the same kind as the server finishing the
	 * answer on its own, so a read against an aborted request ends as if the server had finished
	 * rather than throwing.
	 */
	abortController: AbortController | undefined;
	/** The reader that delivers the answer one piece at a time, absent until the request has started. */
	reader: ReadableStreamDefaultReader<string> | undefined;
	/**
	 * The assignment whose run currently has this generation in hand.
	 *
	 * One worker process can hold two runs of the same task at once: a lease that expires while a
	 * run is under way has the gateway assign the stage again, and this stage asks for that retry
	 * to come back to the same worker. Each run releases the generation when it is finished with
	 * it, and only the run named here may, so the run that was replaced cannot release the
	 * generation its replacement is reading.
	 */
	owningStageAssignmentId: string;
	/**
	 * What has been read from the local server but not yet returned as a stage result.
	 *
	 * A run that is replaced while it is waiting for a piece still receives that piece, because
	 * the server has already sent it and a stream cannot give it back. That run may not answer, so
	 * the piece is kept here for the run that replaced it to report.
	 */
	unreportedText: string;
	/** The timer that gives up an answer nobody has come back for. See `ANSWER_IDLE_TIMEOUT_MS`. */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The pieces of the answer received so far, joined. */
	text: string;
	/** How many pieces have been read, which bounds how long one answer may be read for. */
	pieceCount: number;
	/**
	 * Whether {@link StageHelperLlmLlama3_2_3bFull.clearGeneration} has released this generation
	 * while the stage run still had it in hand.
	 *
	 * Read at the two points a run can learn its work is no longer wanted: after a read, because a
	 * cancelled reader ends the read waiting on it as if the server had finished, and after the
	 * request has started, because a release that arrives while the request is still connecting
	 * has no reader yet to cancel.
	 */
	isReleased: boolean;
	/**
	 * The usage and finish reason the local server reports for this answer, filled in as
	 * `startGeneration`'s stream is read and complete only once it has closed. See milestone 3 of
	 * https://github.com/webai-at-home/webai-at-home/issues/150.
	 */
	usage: ChatCompletionStreamUsage | undefined;
};

/**
 * Runs the complete Llama 3.2 3B model by forwarding the stage's prompt to a locally running
 * server that speaks the OpenAI-compatible Chat Completions API, such as LM Studio.
 *
 * The model is held complete on one device by that server, which also loads it, quantizes it,
 * and drives the hardware, so this helper only has to send a prompt and read the answer back.
 * Which server it talks to, and which model that server is asked for, are options of the worker
 * process rather than decisions this project makes, which is why the task type names the model
 * and not the server (see https://github.com/webai-at-home/webai-at-home/issues/100).
 *
 * The server produces an answer in pieces, and what one stage run does with those pieces is
 * decided by the `isStreaming` generation setting the consumer submitted, exactly as
 * `stage_helper_llm_qwen3_5_0_8b_full.ts` does it:
 *
 * - Asked for nothing, one run reads every piece of the answer and returns the whole thing.
 * - Asked for the answer in pieces, one run reads one piece and returns it, and the request stays
 *   open for the run that follows.
 *
 * Unlike the worker browser page's own full-model helper, no model is downloaded or loaded here:
 * the local server already holds it, so there is no state shared across tasks beyond the answers
 * currently being read.
 */
export class StageHelperLlmLlama3_2_3bFull {
	/**
	 * The computation this worker implements, named the way a pipeline stage names its
	 * computation.
	 */
	static readonly computation = 'llm_llama3_2_3b_full';

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmLlama3_2_3bFull.computation;
	}

	/**
	 * The generations this worker is currently producing, by task identifier. See
	 * `stage_helper_llm_qwen3_5_0_8b_full.ts`'s own field of this name for why a map keyed by
	 * task rather than by assignment.
	 */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/**
	 * Reports whether this worker can run the stage, before it advertises it.
	 *
	 * A worker that cannot reach its configured server, or whose server does not offer the model
	 * it was told to serve, says so at once instead of accepting work it would fail. This is the
	 * native equivalent of the WebGPU and storage checks a worker browser page runs before it
	 * offers a stage that downloads a model.
	 *
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model this worker was told to serve, such as `llama-3.2-3b-instruct`.
	 * @returns Whether the stage can be run, and why not when it cannot.
	 */
	static async readiness(openaiApiClient: OpenaiApiClient, modelId: string): Promise<LocalModelReadiness> {
		let modelIds: string[];
		try {
			modelIds = await openaiApiClient.listModelIds();
		} catch (error: unknown) {
			return {
				status: 'unavailable',
				message: error instanceof Error ? error.message : String(error),
			};
		}
		if (modelIds.includes(modelId) === false) {
			return {
				status: 'unavailable',
				message: `The local server does not offer ${modelId}. The models it offers are: ${modelIds.length === 0 ? 'none' : modelIds.join(', ')}.`,
			};
		}
		return { status: 'ready' };
	}

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer asked
	 * for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this run
	 * is the one allowed to release the answer it is reading.
	 * @param payload The prompt or conversation submitted with the task, or, on a run that carries
	 * an answer on, a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for. `isStreaming` is read here: set, one
	 * run returns one piece and leaves the request open for the run that follows; absent, one run
	 * returns the whole answer. The five generation controls are read by
	 * {@link OpenaiApiClient.chatCompletionStream} instead, and only on the run that starts the
	 * answer, because one request to the local server produces the whole answer however many runs
	 * read it back — which is also what makes `maximumOutputTokenCount`, a budget for the whole
	 * answer, expressible here as `max_tokens` on that one request.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the local server cannot be reached or fails the request, if the run is asked to
	 * carry on an answer this worker is not holding, or if the answer is abandoned before or
	 * while it is being read.
	 */
	static async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
	): Promise<LlmStagePayload> {
		const wantsPieces = generationSettings?.isStreaming === true;
		const state = payload.isContinuation === true
			? StageHelperLlmLlama3_2_3bFull.heldGeneration(taskId, stageAssignmentId)
			: StageHelperLlmLlama3_2_3bFull.newGeneration(taskId, stageAssignmentId);
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of
		// run that must not release what it was reading. Every other way out of this method — the
		// finished answer, and every failure — releases it.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await StageHelperLlmLlama3_2_3bFull.startGeneration(state, payload.conversation ?? payload.text ?? '', openaiApiClient, modelId, generationSettings);
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
				StageHelperLlmLlama3_2_3bFull.refuseIfReplaced(state, stageAssignmentId);
				if (wantsPieces === true) {
					leavesAnswerOpen = true;
					const reported = state.unreportedText;
					state.unreportedText = '';
					StageHelperLlmLlama3_2_3bFull.waitForTheRunAfterThis(taskId, state);
					return StagePayloadFactory.llmPartialText(reported);
				}
			}
			StageHelperLlmLlama3_2_3bFull.refuseIfReplaced(state, stageAssignmentId);
			return StagePayloadFactory.llmDone(state.text, undefined, StageHelperLlmLlama3_2_3bFull.usageOf(state.usage));
		} finally {
			if (leavesAnswerOpen === false) {
				StageHelperLlmLlama3_2_3bFull.clearGeneration(taskId, stageAssignmentId);
			}
		}
	}

	/**
	 * Releases every answer this worker is holding.
	 *
	 * Called when the connection to the gateway goes away, for the same reason
	 * `stage_helper_llm_qwen3_5_0_8b_full.ts` releases its own generations then: no run can arrive
	 * to carry an open answer on while there is no connection to assign one.
	 */
	static clearEveryGeneration(): void {
		for (const [taskId, state] of StageHelperLlmLlama3_2_3bFull.stateByTaskId) {
			StageHelperLlmLlama3_2_3bFull.stateByTaskId.delete(taskId);
			StageHelperLlmLlama3_2_3bFull.release(state);
		}
	}

	/**
	 * Releases the answer this worker is producing for one task, if the assignment named is the
	 * one currently reading it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		const state = StageHelperLlmLlama3_2_3bFull.stateByTaskId.get(taskId);
		if (state === undefined || state.owningStageAssignmentId !== stageAssignmentId) {
			return;
		}
		StageHelperLlmLlama3_2_3bFull.stateByTaskId.delete(taskId);
		StageHelperLlmLlama3_2_3bFull.release(state);
	}

	/** Creates and stores fresh generation state for a task's first round. */
	private static newGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		// A task asks for its answer once, so anything still held for this task is left over from
		// an attempt that was given up on without being cancelled.
		const abandoned = StageHelperLlmLlama3_2_3bFull.stateByTaskId.get(taskId);
		if (abandoned !== undefined) {
			StageHelperLlmLlama3_2_3bFull.release(abandoned);
		}
		const state: TaskGenerationState = {
			abortController: undefined,
			reader: undefined,
			owningStageAssignmentId: stageAssignmentId,
			unreportedText: '',
			idleTimer: undefined,
			text: '',
			pieceCount: 0,
			isReleased: false,
			usage: undefined,
		};
		StageHelperLlmLlama3_2_3bFull.stateByTaskId.set(taskId, state);
		return state;
	}

	/**
	 * Finds the answer this worker is holding open for a task, so this run can read on from it.
	 *
	 * @param taskId The task whose answer is being carried on.
	 * @param stageAssignmentId The assignment whose run is carrying it on, which becomes the one
	 * allowed to release the answer.
	 * @returns The state holding the answer so far.
	 * @throws If this worker holds no answer for the task.
	 */
	private static heldGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		const state = StageHelperLlmLlama3_2_3bFull.stateByTaskId.get(taskId);
		if (state === undefined) {
			throw new Error('This stage was asked to carry on an answer, but this worker is not holding one for that task.');
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
		throw new Error('This run was replaced by a later one while it was waiting for the local server, so its answer belongs to that run.');
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
		const timer = setTimeout(() => {
			if (StageHelperLlmLlama3_2_3bFull.stateByTaskId.get(taskId) !== state) {
				return;
			}
			StageHelperLlmLlama3_2_3bFull.stateByTaskId.delete(taskId);
			StageHelperLlmLlama3_2_3bFull.release(state);
		}, ANSWER_IDLE_TIMEOUT_MS);
		// A worker with an answer held open must stay alive to hand it to the run that carries it
		// on, but that is what the open gateway connection already guarantees; this timer must not
		// be the reason a process with nothing else to do refuses to exit.
		timer.unref?.();
		state.idleTimer = timer;
	}

	/**
	 * Ends one answer: stops the request to the local server and gives back what this worker
	 * holds for it.
	 *
	 * @param state The answer to release.
	 */
	private static release(state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		// Set before either of the two below, for the same reason as
		// `stage_helper_llm_qwen3_5_0_8b_full.ts`'s own release: both are how a waiting run learns
		// it has been released, and neither exists yet when the release arrives while the request
		// is still connecting.
		state.isReleased = true;
		if (state.reader !== undefined) {
			void state.reader.cancel().catch(() => undefined);
		}
		state.abortController?.abort();
	}

	/**
	 * Starts one answer, and hands its reader to the state the run holds.
	 *
	 * @param state The generation state this run registered, already released or not.
	 * @param promptOrConversation The prompt or conversation submitted with the task.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @param generationSettings What the consumer asked for, whose five generation controls become
	 * fields of this one request to the local server.
	 * @returns The reader that delivers the answer.
	 * @throws If the prompt or conversation is empty, if the request fails, or if the assignment
	 * was taken away while the request was starting.
	 */
	private static async startGeneration(
		state: TaskGenerationState,
		promptOrConversation: string | ConversationInput,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
		generationSettings: GenerationSettings | undefined,
	): Promise<ReadableStreamDefaultReader<string>> {
		if (StageHelperLlmLlama3_2_3bFull.isEmpty(promptOrConversation)) {
			throw new Error('A prompt is needed to start an answer.');
		}
		const abortController = new AbortController();
		state.abortController = abortController;
		const { stream, usage } = await openaiApiClient.chatCompletionStream(modelId, promptOrConversation, abortController, generationSettings);
		// A release that arrives while the request is still connecting leaves this flag and
		// nothing else, since no reader exists yet to cancel; reading it here is what stops this
		// worker reading a whole answer for a task that was already given up on.
		if (state.isReleased === true) {
			abortController.abort();
			throw new Error('The answer this stage was to produce was abandoned before the local server had answered.');
		}
		state.usage = usage;
		state.reader = stream.getReader();
		return state.reader;
	}

	/**
	 * Reports whether a prompt or conversation carries nothing to answer.
	 *
	 * A conversation that reached this point always has at least one message, because
	 * `ConversationInputSchema` refuses an empty one at submission; this still checks rather than
	 * assuming it, so a payload with neither `text` nor `conversation` set is caught here as the
	 * empty string {@link compute} falls back to, the same way an empty prompt always was.
	 *
	 * @param promptOrConversation The value {@link startGeneration} was given.
	 * @returns `true` when there is nothing to answer.
	 */
	private static isEmpty(promptOrConversation: string | ConversationInput): boolean {
		if (typeof promptOrConversation === 'string') {
			return promptOrConversation.trim() === '';
		}
		return promptOrConversation.messages.length === 0;
	}

	/**
	 * Builds the `usage` argument {@link StagePayloadFactory.llmDone} takes, from what the local
	 * server reported for this answer.
	 *
	 * Built field by field rather than by spreading `usage` itself, because `usage`'s own fields
	 * are typed `| undefined` from being read before the server has reported them, while
	 * {@link StagePayloadFactory.llmDone}'s `usage` parameter types each field as merely
	 * optional — the same distinction `exactOptionalPropertyTypes` enforces throughout this
	 * repository.
	 *
	 * @param usage The usage {@link OpenaiApiClient.chatCompletionStream} recorded, or `undefined`
	 * if generation never started.
	 * @returns The usage to report, with a field left out rather than set to `undefined` when the
	 * local server did not report it.
	 */
	private static usageOf(
		usage: ChatCompletionStreamUsage | undefined,
	): { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } {
		const result: { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } = {};
		if (usage?.promptTokenCount !== undefined) {
			result.promptTokenCount = usage.promptTokenCount;
		}
		if (usage?.completionTokenCount !== undefined) {
			result.completionTokenCount = usage.completionTokenCount;
		}
		const stopReason = StageHelperLlmLlama3_2_3bFull.stopReasonOf(usage?.finishReason);
		if (stopReason !== undefined) {
			result.stopReason = stopReason;
		}
		return result;
	}

	/**
	 * Translates the local server's own OpenAI `finish_reason` value into this stage's word for
	 * why generation stopped.
	 *
	 * Milestone 0's de-risk gate for https://github.com/webai-at-home/webai-at-home/issues/150
	 * found LM Studio distinguishes `"stop"` from `"length"` already, in OpenAI's
	 * own spelling. Confirmed by that gate: forcing a length cutoff never produced `"stop"`. Any
	 * other value, including none reported at all, is left untranslated — Rule 1 of that issue
	 * forbids inventing a value nobody reported.
	 *
	 * @param finishReason The local server's own `finish_reason` value, once it reported one.
	 * @returns This stage's word for why generation stopped, or `undefined` when the local server
	 * reported no `finish_reason` this stage recognises.
	 */
	private static stopReasonOf(finishReason: string | undefined): 'end_of_sequence' | 'max_new_tokens' | undefined {
		if (finishReason === 'stop') {
			return 'end_of_sequence';
		}
		if (finishReason === 'length') {
			return 'max_new_tokens';
		}
		return undefined;
	}
}
