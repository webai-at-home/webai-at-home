import { StagePayloadFactory, type HistoryInput, type GenerationSettings, type LlmStagePayload, type ToolCall, type ToolDeclaration } from '@webai/protocol';
import { OpenaiApiClient, type ChatCompletionStreamToolCalls, type ChatCompletionStreamUsage, type StreamedToolCall } from '../libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	LocalServerGeneration — reads answers from a local OpenAI-compatible server, one stage helper's worth
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The largest number of pieces one answer may be read in, a safety bound if the local server
 * never stops streaming. The same kind of bound as the worker browser page's
 * `stage_helper_llm_qwen3_5_0_8b_full.ts` own `MAXIMUM_ANSWER_PIECES`.
 */
const MAXIMUM_ANSWER_PIECES = 2000;

/**
 * How long an answer held open between runs waits for the run that carries it on.
 *
 * Matches the worker browser page's `stage_helper_llm_qwen3_5_0_8b_full.ts` own timeout and
 * reasoning: the stage's assignment lease is 60 seconds and the gateway assigns the next run as
 * soon as the previous result arrives, so a wait this long means the task is not coming back.
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
	 * Whether {@link LocalServerGeneration.clearGeneration} has released this generation while the
	 * stage run still had it in hand.
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
	/**
	 * The tools the history that started this answer declared, empty when it declared none.
	 *
	 * Read on the run that starts the answer and kept, because a run that carries the answer on
	 * receives a payload saying only that it is a continuation, and whether tools were declared
	 * decides how the answer is read.
	 */
	declaredTools: readonly ToolDeclaration[];
	/**
	 * The tool calls the local server reports for this answer, filled in as `startGeneration`'s
	 * stream is read and complete only once it has closed.
	 */
	toolCalls: ChatCompletionStreamToolCalls | undefined;
};

/**
 * Reads the answers of one stage helper from a locally running server that speaks the
 * OpenAI-compatible Chat Completions API, such as LM Studio.
 *
 * The model is held complete on one device by that server, which also loads it, quantizes it,
 * and drives the hardware, so this only has to send a prompt and read the answer back. Nothing
 * here names a model or a computation: which server is talked to, and which model that server is
 * asked for, are options of the worker process rather than decisions this project makes, which is
 * why the task type names the model and not the server (see
 * https://github.com/webai-at-home/webai-at-home/issues/100).
 *
 * The server produces an answer in pieces, and what one stage run does with those pieces is
 * decided by the `isStreaming` generation setting the consumer submitted, exactly as the worker
 * browser page's own `stage_helper_llm_qwen3_5_0_8b_full.ts` does it:
 *
 * - Asked for nothing, one run reads every piece of the answer and returns the whole thing.
 * - Asked for the answer in pieces, one run reads one piece and returns it, and the request stays
 *   open for the run that follows.
 *
 * Unlike the worker browser page's own full-model helpers, no model is downloaded or loaded here:
 * the local server already holds it, so there is no state shared across tasks beyond the answers
 * currently being read.
 *
 * One of these belongs to each stage helper in this folder, so the answers of one stage are never
 * released by a run of another.
 */
export class LocalServerGeneration {
	/**
	 * Reports whether this worker can run a stage, before it advertises it.
	 *
	 * A worker that cannot reach its configured server, or whose server does not offer the model
	 * it was told to serve, says so at once instead of accepting work it would fail. This is the
	 * native equivalent of the WebGPU and storage checks a worker browser page runs before it
	 * offers a stage that downloads a model.
	 *
	 * It asks the local server rather than the generation state, so it belongs to no one answer
	 * and is the same question for every stage helper in this folder.
	 *
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model this worker was told to serve, such as `llama-3.2-1b-instruct`.
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
	 * The generations this stage helper is currently producing, by task identifier. See the worker
	 * browser page's `stage_helper_llm_qwen3_5_0_8b_full.ts` own field of this name for why a map
	 * keyed by task rather than by assignment.
	 */
	private readonly stateByTaskId = new Map<string, TaskGenerationState>();

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer asked
	 * for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this run
	 * is the one allowed to release the answer it is reading.
	 * @param payload The prompt or history submitted with the task, or, on a run that carries
	 * an answer on, a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for. `isStreaming` is read here: set, one
	 * run returns one piece and leaves the request open for the run that follows; absent, one run
	 * returns the whole answer. The five generation controls are read by
	 * {@link OpenaiApiClient.chatCompletionStream} instead, and only on the run that starts the
	 * answer, because one request to the local server produces the whole answer however many runs
	 * read it back — which is also what makes `maximumOutputTokenCount`, a budget for the whole
	 * answer, expressible here as `max_tokens` on that one request. `responseFormat` is read in both
	 * places: that same method puts it in the request, and the run that finishes the answer reads it
	 * again here to check the shape that came back is the shape that was asked for.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the local server cannot be reached or fails the request, if the run is asked to
	 * carry on an answer this worker is not holding, or if the answer is abandoned before or
	 * while it is being read.
	 */
	async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
	): Promise<LlmStagePayload> {
		const state = payload.isContinuation === true
			? this.heldGeneration(taskId, stageAssignmentId)
			: this.newGeneration(taskId, stageAssignmentId);
		if (payload.isContinuation !== true) {
			state.declaredTools = payload.history?.tools ?? [];
		}
		// A history that declared tools is never read in pieces, even when the consumer asked for
		// pieces, which is the rule `packages/worker_webpage`'s own stage helper already applies to
		// this same task type. A model that asks for a tool writes no answer text at all, so there is
		// nothing to report a piece of, and the run that ends the generation is the one that has the
		// whole tool call to report.
		const wantsPieces = generationSettings?.isStreaming === true && state.declaredTools.length === 0;
		// A run that returns a piece leaves the answer open behind it, so it is the one kind of
		// run that must not release what it was reading. Every other way out of this method — the
		// finished answer, and every failure — releases it.
		let leavesAnswerOpen = false;
		try {
			const reader = state.reader ?? await this.startGeneration(state, payload.history ?? payload.text ?? '', openaiApiClient, modelId, generationSettings);
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
				this.refuseIfReplaced(state, stageAssignmentId);
				if (wantsPieces === true) {
					leavesAnswerOpen = true;
					const reported = state.unreportedText;
					state.unreportedText = '';
					this.waitForTheRunAfterThis(taskId, state);
					return StagePayloadFactory.llmPartialText(reported);
				}
			}
			this.refuseIfReplaced(state, stageAssignmentId);
			// A tool call whose arguments could not be read throws out of here, which fails the stage
			// and names what could not be read. That is deliberate, and is the same rule
			// `packages/worker_webpage`'s own stage helper follows: a calling program runs whatever
			// tool call it receives, so a call read wrongly is a call run wrongly on the caller's own
			// machine.
			const toolCalls = this.toolCallsOf(state.toolCalls);
			if (toolCalls.length > 0) {
				return StagePayloadFactory.llmToolCalls(toolCalls, this.usageOf(state.usage));
			}
			this.refuseAnswerThatRanOutBeforeItBegan(state);
			this.refuseAnswerThatIsNotTheShapeAskedFor(state, generationSettings);
			return StagePayloadFactory.llmDone(state.text, undefined, this.usageOf(state.usage));
		} finally {
			if (leavesAnswerOpen === false) {
				this.clearGeneration(taskId, stageAssignmentId);
			}
		}
	}

	/**
	 * Releases every answer this stage helper is holding.
	 *
	 * Called when the connection to the gateway goes away, for the same reason the worker browser
	 * page's `stage_helper_llm_qwen3_5_0_8b_full.ts` releases its own generations then: no run can
	 * arrive to carry an open answer on while there is no connection to assign one.
	 */
	clearEveryGeneration(): void {
		for (const [taskId, state] of this.stateByTaskId) {
			this.stateByTaskId.delete(taskId);
			this.release(state);
		}
	}

	/**
	 * Releases the answer this stage helper is producing for one task, if the assignment named is
	 * the one currently reading it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	clearGeneration(taskId: string, stageAssignmentId: string): void {
		const state = this.stateByTaskId.get(taskId);
		if (state === undefined || state.owningStageAssignmentId !== stageAssignmentId) {
			return;
		}
		this.stateByTaskId.delete(taskId);
		this.release(state);
	}

	/**
	 * Creates and stores fresh generation state for a task's first round.
	 *
	 * @param taskId The task the answer is being produced for.
	 * @param stageAssignmentId The assignment whose run starts the answer.
	 * @returns The state holding the new answer.
	 */
	private newGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		// A task asks for its answer once, so anything still held for this task is left over from
		// an attempt that was given up on without being cancelled.
		const abandoned = this.stateByTaskId.get(taskId);
		if (abandoned !== undefined) {
			this.release(abandoned);
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
			declaredTools: [],
			toolCalls: undefined,
		};
		this.stateByTaskId.set(taskId, state);
		return state;
	}

	/**
	 * Finds the answer this stage helper is holding open for a task, so this run can read on from
	 * it.
	 *
	 * @param taskId The task whose answer is being carried on.
	 * @param stageAssignmentId The assignment whose run is carrying it on, which becomes the one
	 * allowed to release the answer.
	 * @returns The state holding the answer so far.
	 * @throws If this worker holds no answer for the task.
	 */
	private heldGeneration(taskId: string, stageAssignmentId: string): TaskGenerationState {
		const state = this.stateByTaskId.get(taskId);
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
	private refuseIfReplaced(state: TaskGenerationState, stageAssignmentId: string): void {
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
	private waitForTheRunAfterThis(taskId: string, state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		const timer = setTimeout(() => {
			if (this.stateByTaskId.get(taskId) !== state) {
				return;
			}
			this.stateByTaskId.delete(taskId);
			this.release(state);
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
	private release(state: TaskGenerationState): void {
		if (state.idleTimer !== undefined) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = undefined;
		// Set before either of the two below, for the same reason as the worker browser page's
		// `stage_helper_llm_qwen3_5_0_8b_full.ts` own release: both are how a waiting run learns
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
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @param generationSettings What the consumer asked for, whose five generation controls become
	 * fields of this one request to the local server.
	 * @returns The reader that delivers the answer.
	 * @throws If the prompt or history is empty, if the request fails, or if the assignment
	 * was taken away while the request was starting.
	 */
	private async startGeneration(
		state: TaskGenerationState,
		promptOrHistory: string | HistoryInput,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
		generationSettings: GenerationSettings | undefined,
	): Promise<ReadableStreamDefaultReader<string>> {
		if (this.isEmpty(promptOrHistory)) {
			throw new Error('A prompt is needed to start an answer.');
		}
		const abortController = new AbortController();
		state.abortController = abortController;
		const { stream, usage, toolCalls } = await openaiApiClient.chatCompletionStream(modelId, promptOrHistory, abortController, generationSettings);
		// A release that arrives while the request is still connecting leaves this flag and
		// nothing else, since no reader exists yet to cancel; reading it here is what stops this
		// worker reading a whole answer for a task that was already given up on.
		if (state.isReleased === true) {
			abortController.abort();
			throw new Error('The answer this stage was to produce was abandoned before the local server had answered.');
		}
		state.usage = usage;
		state.toolCalls = toolCalls;
		state.reader = stream.getReader();
		return state.reader;
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
	private isEmpty(promptOrHistory: string | HistoryInput): boolean {
		if (typeof promptOrHistory === 'string') {
			return promptOrHistory.trim() === '';
		}
		return promptOrHistory.messages.length === 0;
	}

	/**
	 * Fails the stage when the local server reached its output limit without ever writing any answer
	 * text, rather than reporting the empty answer as a finished one.
	 *
	 * A consumer receiving HTTP 200 with an empty answer cannot tell that apart from a model that
	 * genuinely had nothing to say. This is the one case where the two can be told apart from the
	 * outside: the model was still generating when its budget ran out, so it had more to say and no
	 * room to say it, and calling that a finished answer is the fault
	 * `generation_control_support.ts` calls the worst of the three — an answer produced some other
	 * way, reported as though nothing went wrong.
	 *
	 * What produces it in practice is a model that thinks before it answers and never stops
	 * thinking. Qwen3.5-0.8B spent all 8153 tokens of an 8192-token context reasoning about a plain
	 * two-turn question and wrote no answer at all, and raising the context window to 32768 only
	 * bought 32731 reasoning tokens and the same empty answer. See
	 * https://github.com/webai-at-home/webai-at-home/issues/192. The cause is upstream of this
	 * project, and the silence was not: this method is what ends the silence.
	 *
	 * An empty answer that ended any other way is left alone. A model that stopped of its own accord
	 * having written nothing has said what it had to say, and a run that ends with a tool call
	 * writes no answer text by design — that one never reaches here, being returned before this is
	 * called.
	 *
	 * @param state The answer this run has finished reading.
	 * @throws If the answer holds no text and the local server reported it stopped at its output
	 * limit.
	 */
	private refuseAnswerThatRanOutBeforeItBegan(state: TaskGenerationState): void {
		if (state.text !== '') {
			return;
		}
		if (state.usage?.finishReason !== 'length') {
			return;
		}
		const completionTokenCount = state.usage.completionTokenCount;
		const generated = completionTokenCount === undefined
			? 'every token it was allowed'
			: `all ${completionTokenCount} tokens it was allowed`;
		throw new Error(`The model generated ${generated} without writing any answer text, and stopped because it ran out of room rather than because it had finished. A model that thinks before it answers can do this by never finishing thinking; asking for reasoning_effort "none" stops it.`);
	}

	/**
	 * Refuses an answer that is not the shape the consumer asked for.
	 *
	 * The worker browser tab running this same task type cannot produce the wrong shape at all: it
	 * masks every token that would break the shape, so a well-formed object is what the model is
	 * able to write and nothing else is. This worker has no such hold over the model. It asks the
	 * local server for the shape and reads back whatever that server chose to send, so the promise
	 * the task type makes is only as good as the server's word, and a server that reads
	 * `response_format` and ignores it silently would return prose to a consumer that asked for an
	 * object. That is the fault `structured_output_support.ts` calls worse than a refusal and worse
	 * than an honoured request both. This method is the only place this worker can catch it.
	 *
	 * A top-level object is required, and a valid JSON value that is not one — a bare number, a
	 * string, a list — is refused with it, because that is the same shape the worker browser tab's
	 * grammar allows and the two workers of one task type keep one promise between them.
	 *
	 * An answer the local server cut short at its output limit is left alone, however unfinished the
	 * JSON it holds is. Running out of room is already reported, as `stopReason: max_new_tokens`, and
	 * a consumer told the answer was cut short is not being told nothing. This is the same line the
	 * worker browser tab draws for the same reason.
	 *
	 * @param state The answer this run has finished reading.
	 * @param generationSettings What the consumer asked for, read for its response format.
	 * @throws If a shape was asked for, the answer ended of its own accord, and what came back is
	 * not a JSON object.
	 */
	private refuseAnswerThatIsNotTheShapeAskedFor(state: TaskGenerationState, generationSettings: GenerationSettings | undefined): void {
		if (generationSettings?.responseFormat === undefined) {
			return;
		}
		if (state.usage?.finishReason !== 'stop') {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(state.text);
		} catch {
			throw new Error(`The consumer asked for a ${generationSettings.responseFormat} answer, and the local server returned text that is not JSON at all: ${state.text}`);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) === true) {
			throw new Error(`The consumer asked for a ${generationSettings.responseFormat} answer, and the local server returned JSON that is not an object: ${state.text}`);
		}
	}

	/**
	 * Turns the tool calls read from the local server's stream into the shape the protocol carries.
	 *
	 * The two interfaces disagree about the arguments, and this is where that is settled. The OpenAI
	 * Chat Completions interface carries them as one string of JSON, while the protocol carries each
	 * argument value as the text the model wrote, keyed by argument name — see `ToolCallSchema` in
	 * `@webai/protocol` for why. Converting each value back into the type its tool declared belongs
	 * to `packages/consumer_openai`, which is the one that knows the declared types and the one whose
	 * interface asks for types at all.
	 *
	 * @param toolCalls The tool calls assembled while the stream was read, `undefined` when
	 * generation never started.
	 * @returns The tool calls to report, empty when the model asked for none.
	 * @throws If a tool call's arguments are not a JSON object, since a call that could not be read
	 * is a failed stage rather than a call passed on half-formed.
	 */
	private toolCallsOf(toolCalls: ChatCompletionStreamToolCalls | undefined): ToolCall[] {
		if (toolCalls === undefined) {
			return [];
		}
		return OpenaiApiClient.orderedToolCallsOf(toolCalls).map((toolCall) => ({
			name: toolCall.name,
			argumentValues: this.argumentValuesOf(toolCall),
		}));
	}

	/**
	 * Reads one tool call's arguments out of the string of JSON the local server carried them in.
	 *
	 * A value that is not already text is written back out as the text of what it was: the number
	 * `31` becomes `"31"`, and an object or a list becomes its JSON. That is what the protocol
	 * carries, and it is the same text the model itself wrote, because the local server built this
	 * JSON out of what the model wrote in the first place.
	 *
	 * @param toolCall The tool call assembled from the stream.
	 * @returns Each argument the model filled in, as text, keyed by argument name.
	 * @throws If the arguments are not a JSON object, naming the tool and what could not be read.
	 */
	private argumentValuesOf(toolCall: StreamedToolCall): Record<string, string> {
		// A tool that takes nothing is asked for with empty arguments rather than with `{}`, which
		// is a complete tool call and not an unreadable one.
		if (toolCall.argumentsJson.trim() === '') {
			return {};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(toolCall.argumentsJson);
		} catch {
			throw new Error(`The local server asked for the tool ${toolCall.name} with arguments that are not JSON: ${toolCall.argumentsJson}`);
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) === true) {
			throw new Error(`The local server asked for the tool ${toolCall.name} with arguments that are not a JSON object: ${toolCall.argumentsJson}`);
		}
		const argumentValues: Record<string, string> = {};
		for (const [argumentName, writtenValue] of Object.entries(parsed as Record<string, unknown>)) {
			argumentValues[argumentName] = typeof writtenValue === 'string' ? writtenValue : JSON.stringify(writtenValue);
		}
		return argumentValues;
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
	private usageOf(
		usage: ChatCompletionStreamUsage | undefined,
	): { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } {
		const result: { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } = {};
		if (usage?.promptTokenCount !== undefined) {
			result.promptTokenCount = usage.promptTokenCount;
		}
		if (usage?.completionTokenCount !== undefined) {
			result.completionTokenCount = usage.completionTokenCount;
		}
		const stopReason = this.stopReasonOf(usage?.finishReason);
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
	private stopReasonOf(finishReason: string | undefined): 'end_of_sequence' | 'max_new_tokens' | undefined {
		if (finishReason === 'stop') {
			return 'end_of_sequence';
		}
		if (finishReason === 'length') {
			return 'max_new_tokens';
		}
		return undefined;
	}
}
