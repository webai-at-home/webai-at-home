// node imports
import Crypto from 'node:crypto';

// npm imports
import Express from 'express';
import { TaskInputFactory, taskTypeNamesAcceptingTools } from '@webai/consumer-cli';
import type { TaskInput, ToolDeclaration } from '@webai/protocol';
import type { z } from 'zod';

// local imports
import type { ClusterTaskRunner } from '../libs/cluster_task_runner.js';
import { ModelAvailability, type ModelAvailabilityOptions } from '../libs/model_availability.js';
import type {
	CurlStyleTransactionLogger,
	TransactionAuthOutcome,
	TransactionOutcome,
	TransactionResponseType,
} from './curl_style_transaction_logger.js';
import { HistoryBuilder } from '../api/history_builder.js';
import { GenerationSettingsBuilder } from '../api/generation_settings_builder.js';
import { ModelCatalog } from '../api/model_catalog.js';
import { OpenaiError } from '../api/openai_error.js';
import { FinishReasonTranslator } from '../api/finish_reason_translator.js';
import { PromptFlattener } from '../api/prompt_flattener.js';
import { ResponseFormatReader } from '../api/response_format_reader.js';
import { ToolTranslator } from '../api/tool_translator.js';
import {
	ChatCompletionRequestSchema,
	type ChatCompletionAnswerChunk,
	type ChatCompletionChunkChoice,
	type ChatCompletionMessage,
	type ChatCompletionResponse,
	type ChatCompletionUsage,
	type ChatCompletionUsageChunk,
	type HealthResponse,
} from '../api/openai_types.js';
import { ResponsesTranslator } from '../api/responses_translator.js';
import { ResponsesRequestSchema, type ResponsesResponse, type ResponsesTool } from '../api/responses_types.js';
import { ResponsesStreamWriter } from './responses_stream_writer.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiRoutes — the endpoints this server answers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest request body this server reads. */
const bodySizeLimit = '1mb';

/**
 * What this server has learned about one `POST /v1/chat/completions` or `POST /v1/responses`
 * request, gathered as it is read, checked, and answered, and written to the transaction log
 * exactly once, when the response closes.
 */
type ChatCompletionTransaction = {
	/** The identifier of this transaction. */
	id: string;
	/** When this request was received. */
	receivedAt: Date;
	/** The model the request asked for, once the body could be read safely. */
	model: string | undefined;
	/** Whether, and how, the request's key was checked. */
	authOutcome: TransactionAuthOutcome | undefined;
	/** The identifier the task was submitted to the central gateway under, once one exists. */
	gatewayTaskRequestId: string | undefined;
	/** The task identifier the central gateway assigned, once one exists. */
	gatewayTaskId: string | undefined;
	/** When this request was answered or failed, once it has been. */
	respondedAt: Date | undefined;
	/** How this request's lifecycle ended, once it has. */
	outcome: TransactionOutcome | undefined;
	/** The HTTP status returned, once one has been decided. */
	status: number | undefined;
	/** What kind of body was returned, once one has been decided. */
	responseType: TransactionResponseType | undefined;
	/** The response body, once one has been decided. */
	responseBody: unknown;
};

/**
 * The endpoints this server answers: the two of the OpenAI completion interface it serves, and
 * one that reports its own state.
 *
 * Every failure leaves here as an `OpenaiError`, which carries both the HTTP status and the
 * body, so that the list of ways a request can fail is read in one file rather than being
 * spread across the handlers.
 */
export class OpenaiRoutes {
	/**
	 * Every `POST /v1/chat/completions` and every `POST /v1/responses` request's transaction in
	 * flight, keyed by its Express request object, so the response-close handler set up when the
	 * request begins can find it later.
	 */
	private readonly transactions = new WeakMap<Express.Request, ChatCompletionTransaction>();

	/**
	 * @param runner Runs one cluster task per request.
	 * @param apiKey The key a request must present, when this server was started with one.
	 * @param startedAtSeconds When this server started, as a whole number of seconds since the
	 * start of 1970, which is the creation date it states for every model.
	 * @param transactionLogger Where every chat completion request is recorded as one transaction.
	 * @param commitSha The git commit this server was built from, published on the `/health` route.
	 * @param modelAvailabilityOptions How `GET /v1/models` reaches the central gateway to ask which
	 * models the connected workers can currently run.
	 */
	constructor(
		private readonly runner: ClusterTaskRunner,
		private readonly apiKey: string | undefined,
		private readonly startedAtSeconds: number,
		private readonly transactionLogger: CurlStyleTransactionLogger,
		private readonly commitSha: string,
		private readonly modelAvailabilityOptions: ModelAvailabilityOptions,
	) {}

	/**
	 * Builds the routes, in the order they are tried.
	 *
	 * @returns The Express router to mount on the server.
	 */
	router(): Express.Router {
		const router = Express.Router();
		router.use(
			Express.json({
				limit: bodySizeLimit,
			}),
		);

		// The state of this server is readable without a key, so that whatever watches it does
		// not have to hold one.
		router.get('/health', (_request, response) => {
			const health: HealthResponse = {
				isHealthy: this.runner.isGatewayConnected,
				isGatewayConnected: this.runner.isGatewayConnected,
				tasksInFlight: this.runner.tasksInFlight,
				commitSha: this.commitSha,
			};
			response.status(health.isHealthy ? 200 : 503).json(health);
		});

		// Registered ahead of the key check below, so a request to this route is tracked for its
		// transaction log even when that check is what fails it.
		router.use('/v1/chat/completions', (request, response, next) => {
			this._beginTransaction(request, response);
			next();
		});

		// The Responses route is tracked the same way, and for the same reason.
		router.use('/v1/responses', (request, response, next) => {
			this._beginTransaction(request, response);
			next();
		});

		router.use('/v1', (request, response, next) => {
			try {
				this._checkApiKey(request);
				const transaction = this.transactions.get(request);
				if (transaction !== undefined && this.apiKey !== undefined) {
					transaction.authOutcome = 'ok';
				}
				next();
			} catch (failure: unknown) {
				const transaction = this.transactions.get(request);
				if (transaction !== undefined) {
					transaction.authOutcome = 'failed';
				}
				OpenaiRoutes._sendFailure(response, failure, transaction);
			}
		});

		// Only the models the cluster can currently run are listed, which needs one snapshot of the
		// central gateway and so cannot be answered as the plain catalogue used to be. An
		// asynchronous handler that fails does not reach the error handling of Express by itself,
		// so this route catches its own failures, the same way the completion route below does.
		router.get('/v1/models', (_request, response) => {
			void this._handleModelList(response).catch((failure: unknown) => OpenaiRoutes._sendFailure(response, failure));
		});

		// An asynchronous handler that fails does not reach the error handling of Express by
		// itself, so this route catches its own failures rather than relying on that.
		router.post('/v1/chat/completions', (request, response) => {
			const transaction = this.transactions.get(request);
			void this._handleChatCompletion(request, response, transaction).catch((failure: unknown) =>
				OpenaiRoutes._sendFailure(response, failure, transaction),
			);
		});

		// The Responses interface of the same models, added in
		// [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214). It catches its
		// own failures for the same reason the route above does.
		router.post('/v1/responses', (request, response) => {
			const transaction = this.transactions.get(request);
			void this._handleResponses(request, response, transaction).catch((failure: unknown) =>
				OpenaiRoutes._sendFailure(response, failure, transaction),
			);
		});

		// A body that is not valid JSON is refused by the reader mounted above, which fails
		// before any handler runs, so its failure is turned into an answer here.
		const reportBodyFailure: Express.ErrorRequestHandler = (error, _request, response, _next) => {
			OpenaiRoutes._sendFailure(
				response,
				OpenaiError.invalidRequest(
					`The request body could not be read as JSON: ${error instanceof Error ? error.message : String(error)}.`,
				),
			);
		};
		router.use(reportBodyFailure);

		return router;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Models On Offer
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Answers `GET /v1/models` with the models the cluster can currently run.
	 *
	 * A model this server knows the name of is not a model anybody can run: a task type with no
	 * connected worker behind it is a model every request for would be given up on. So the list is
	 * the models with a capacity above zero right now, read through `ModelAvailability`, rather
	 * than the whole catalogue this server was built with. See
	 * [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
	 *
	 * @param response The response to answer with.
	 * @throws OpenaiError when the central gateway cannot be reached, which is answered as 503
	 * rather than as an empty list: an empty list says every worker went away, and being unable to
	 * ask says nothing at all about the workers.
	 */
	private async _handleModelList(response: Express.Response): Promise<void> {
		let availableModelIds: readonly string[];
		try {
			availableModelIds = await ModelAvailability.availableModelIds(this.modelAvailabilityOptions);
		} catch (failure: unknown) {
			throw OpenaiError.gatewayUnavailable(
				`The models on offer could not be read, because the central gateway at ` +
					`${this.modelAvailabilityOptions.gatewayUrl} could not be asked which models the connected workers ` +
					`can run: ${failure instanceof Error ? failure.message : String(failure)}.`,
			);
		}
		response.status(200).json(ModelCatalog.list(this.startedAtSeconds, availableModelIds));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Chat Completions
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Answers one chat completion request by running one cluster task.
	 *
	 * @param request The incoming request.
	 * @param response The response to answer with.
	 * @param transaction This request's transaction record, absent only in a test that builds
	 * routes without going through {@link router}.
	 * @throws OpenaiError when the request cannot be read or the cluster cannot serve it.
	 */
	private async _handleChatCompletion(
		request: Express.Request,
		response: Express.Response,
		transaction: ChatCompletionTransaction | undefined,
	): Promise<void> {
		const parsed = ChatCompletionRequestSchema.safeParse(request.body);
		if (parsed.success === false) {
			throw OpenaiRoutes._schemaFailureOf(parsed.error);
		}
		const body = parsed.data;
		if (transaction !== undefined) {
			transaction.model = body.model;
		}
		const taskTypeName = ModelCatalog.taskTypeNameOf(body.model);
		if (taskTypeName === undefined) {
			throw OpenaiError.unknownModel(body.model, ModelCatalog.modelIds);
		}

		// Tool declarations are refused rather than dropped by a model that cannot read them, and a
		// tool_choice this server cannot enforce is refused rather than accepted and ignored. The
		// second of those is the failure that closed issue #78: a server accepted
		// `tool_choice: "required"`, did not enforce it, and the model's answering in words read as
		// "this model cannot call tools" when nothing had ever made it try.
		const declaredTools = ToolTranslator.toProtocolTools(body.tools);
		if (declaredTools !== undefined && TaskInputFactory.acceptsTools(taskTypeName) === false) {
			throw OpenaiError.unsupportedToolDeclarations(body.model, taskTypeNamesAcceptingTools);
		}
		if (body.tool_choice !== null && body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
			throw OpenaiError.unenforceableToolChoice(typeof body.tool_choice === 'string' ? `"${body.tool_choice}"` : `naming the function "${body.tool_choice.function.name}"`);
		}
		// `none` is honoured by declaring nothing, which is the one way this server can enforce it:
		// a model told about no tool cannot ask for one.
		const toolsToDeclare = body.tool_choice === 'none' ? undefined : declaredTools;

		// A response format the chosen task type cannot produce is refused rather than dropped, on
		// the same rule the generation controls follow. What is read back travels with the task, in
		// the generation settings, so that the worker running the stage produces the shape rather
		// than being asked for prose and having its answer read as an object.
		// The tools that will really be declared are what is given here, rather than the tools the
		// request carries: `tool_choice: "none"` declares none, and a request asking for that may ask
		// for a shape as well.
		const responseFormatName = ResponseFormatReader.read(body, taskTypeName, toolsToDeclare);

		// A task type whose worker can hand a message list to its own chat template is sent the
		// history as it was written, each message keeping its own role. Every other task type
		// still takes one piece of text, so its request is flattened exactly as it always was.
		const promptOrHistory = TaskInputFactory.acceptsHistory(taskTypeName)
			? HistoryBuilder.build(body.messages, toolsToDeclare)
			: PromptFlattener.flatten(body.messages);
		const isStreaming = body.stream === true;
		// Asking the cluster for the answer in pieces is what makes it report them, and it is
		// asked only when the caller asked, because a task answered in pieces costs a scheduling
		// round for every piece. The five generation controls join it here, and this is also where
		// a request asking a model for a control it cannot honour is refused rather than answered
		// as though nothing had been asked for.
		const generationSettings = GenerationSettingsBuilder.build(body, taskTypeName, isStreaming, responseFormatName);
		let taskInput: TaskInput;
		try {
			// A request that asked for nothing submits exactly what it did before generation
			// settings existed: no settings block at all.
			taskInput = TaskInputFactory.createTaskInput(taskTypeName, promptOrHistory, generationSettings);
		} catch (error: unknown) {
			throw OpenaiError.unusableMessages(
				`The model ${body.model} cannot take this request: ` +
					`${error instanceof Error ? error.message : String(error)}.`,
			);
		}

		// A caller that hangs up before the answer arrives has its task cancelled, so the
		// cluster stops running stages for an answer nobody will read.
		//
		// The response's `close` event is what says the caller has gone, and the request's is
		// not. A request emits `close` as soon as its body has been read, which is before this
		// task is even submitted, so listening there aborted every request the moment it
		// arrived. Nothing was seen to go wrong, because `run` attaches its own listener to the
		// signal afterwards and an abort that has already happened is never delivered to a
		// listener attached later — so no task was ever cancelled, whether or not its caller
		// was still there. The transaction record below listens on the response for the same
		// reason.
		const abortController = new AbortController();
		response.on('close', () => {
			if (response.writableEnded === false) {
				abortController.abort();
			}
		});

		const onCorrelationIds = (ids: { taskRequestId: string; taskId?: string }): void => {
			if (transaction === undefined) {
				return;
			}
			transaction.gatewayTaskRequestId = ids.taskRequestId;
			if (ids.taskId !== undefined) {
				transaction.gatewayTaskId = ids.taskId;
			}
		};
		if (isStreaming === true) {
			await this._streamChatCompletion(
				body.model,
				taskInput,
				response,
				transaction,
				abortController.signal,
				onCorrelationIds,
				body.stream_options?.include_usage === true,
				declaredTools,
			);
			return;
		}

		const generationStartedAt = performance.now();
		const answer = await this.runner.run(taskInput, body.model, abortController.signal, onCorrelationIds);
		const generationTimeMs = Math.round(performance.now() - generationStartedAt);
		// Rule 2 of this project's OpenAI compatibility requirement: an answer the cluster gave up
		// on producing has no OpenAI value for `finish_reason`, so it is reported as an HTTP error
		// for a whole-answer response like this one, rather than an invented `finish_reason`.
		// A model that asked for a tool stopped because it had finished asking, not because it gave up
		// on an answer, so its own stop reason is not translated: `tool_calls` is what this interface
		// says happened, and it is what a client reads to know it must run something and come back.
		const askedForTools = answer.toolCalls !== undefined && answer.toolCalls.length > 0;
		const finishReason = askedForTools === true ? 'tool_calls' : FinishReasonTranslator.translate(answer.stopReason);
		const usage = OpenaiRoutes._usageOf(answer);
		const completion: ChatCompletionResponse = {
			id: `chatcmpl-${Crypto.randomUUID()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: body.model,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: answer.text,
						...(answer.toolCalls === undefined || answer.toolCalls.length === 0
							? {}
							: { tool_calls: ToolTranslator.toOpenaiToolCalls(answer.toolCalls, declaredTools ?? []) }),
					},
					logprobs: null,
					finish_reason: finishReason,
				},
			],
			...(usage === undefined ? {} : { usage }),
		};
		if (transaction !== undefined) {
			transaction.respondedAt = new Date();
			transaction.outcome = 'completed';
			transaction.status = 200;
			transaction.responseType = 'chat.completion';
			transaction.responseBody = completion;
		}
		if (response.writableEnded === true) {
			return;
		}
		// Rule 3 of this project's OpenAI compatibility requirement: a value the OpenAI Chat
		// Completions interface has no field for travels in a response header, or not at all. An
		// OpenAI client ignores a header it does not recognise, so this one breaks nothing. Only
		// the whole-answer response can carry it, because only here is the total generation time
		// known before the response headers must be sent — a streamed response sends its headers
		// with its first chunk, before the cluster has finished generating the rest of the answer.
		response.status(200).set({ 'X-Webai-Generation-Time-Ms': String(generationTimeMs) }).json(completion);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Responses
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Answers one `POST /v1/responses` request by running one cluster task.
	 *
	 * The Responses interface is a second spelling of a request this server already runs, and it is
	 * carried onto that one rather than given a second way of reaching the cluster: `instructions`
	 * and `input` become the message list through `ResponsesTranslator`, the flat tool declarations
	 * become the nested ones `ToolTranslator` already carries, and `HistoryBuilder`,
	 * `GenerationSettingsBuilder`, and `ClusterTaskRunner` do the rest unchanged.
	 *
	 * Every rule the chat completion route follows is followed here. A tool declared to a model
	 * that cannot read one is refused rather than dropped. A `tool_choice` this server cannot
	 * enforce is refused rather than accepted and ignored. `usage` is present only when the worker
	 * reported both counts, and is never estimated.
	 *
	 * See [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214).
	 *
	 * @param request The incoming request.
	 * @param response The response to answer with.
	 * @param transaction This request's transaction record, absent only in a test that builds
	 * routes without going through {@link router}.
	 * @throws OpenaiError when the request cannot be read or the cluster cannot serve it.
	 */
	private async _handleResponses(
		request: Express.Request,
		response: Express.Response,
		transaction: ChatCompletionTransaction | undefined,
	): Promise<void> {
		const parsed = ResponsesRequestSchema.safeParse(request.body);
		if (parsed.success === false) {
			throw OpenaiRoutes._responsesSchemaFailureOf(parsed.error);
		}
		const body = parsed.data;
		if (transaction !== undefined) {
			transaction.model = body.model;
		}
		const taskTypeName = ModelCatalog.taskTypeNameOf(body.model);
		if (taskTypeName === undefined) {
			throw OpenaiError.unknownModel(body.model, ModelCatalog.modelIds);
		}

		const declaredTools = ToolTranslator.toProtocolTools(ResponsesTranslator.toChatTools(body.tools));
		if (declaredTools !== undefined && TaskInputFactory.acceptsTools(taskTypeName) === false) {
			throw OpenaiError.unsupportedToolDeclarations(body.model, taskTypeNamesAcceptingTools);
		}
		if (body.tool_choice !== null && body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
			throw OpenaiError.unenforceableToolChoice(
				typeof body.tool_choice === 'string' ? `"${body.tool_choice}"` : `naming the function "${body.tool_choice.name}"`,
			);
		}
		const toolsToDeclare = body.tool_choice === 'none' ? undefined : declaredTools;

		const chatMessages = ResponsesTranslator.toChatMessages(body.instructions, body.input);
		if (chatMessages.length === 0) {
			throw OpenaiError.unusableMessages(
				`The request to ${body.model} carries neither instructions nor any input item this server can read.`,
			);
		}

		const promptOrHistory = TaskInputFactory.acceptsHistory(taskTypeName)
			? HistoryBuilder.build(chatMessages, toolsToDeclare)
			: PromptFlattener.flatten(chatMessages);
		const isStreaming = body.stream === true;
		// The Responses interface of the Codex command-line program carries no generation control
		// at all, measured in exp_03_prompt_size_measure of
		// [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213). The builder is
		// still what decides the settings, so that a control arriving here one day is refused by
		// the same rule rather than by a second one written here.
		const generationSettings = GenerationSettingsBuilder.build(
			{
				model: body.model,
				messages: chatMessages as ChatCompletionMessage[],
			},
			taskTypeName,
			isStreaming,
		);
		let taskInput: TaskInput;
		try {
			taskInput = TaskInputFactory.createTaskInput(taskTypeName, promptOrHistory, generationSettings);
		} catch (error: unknown) {
			throw OpenaiError.unusableMessages(
				`The model ${body.model} cannot take this request: ` +
					`${error instanceof Error ? error.message : String(error)}.`,
			);
		}

		// A caller that hangs up before the answer arrives has its task cancelled, for the same
		// reason and in the same way as on the chat completion route.
		const abortController = new AbortController();
		response.on('close', () => {
			if (response.writableEnded === false) {
				abortController.abort();
			}
		});

		const onCorrelationIds = (ids: { taskRequestId: string; taskId?: string }): void => {
			if (transaction === undefined) {
				return;
			}
			transaction.gatewayTaskRequestId = ids.taskRequestId;
			if (ids.taskId !== undefined) {
				transaction.gatewayTaskId = ids.taskId;
			}
		};

		const answerShell: ResponsesResponse = {
			id: `resp_${Crypto.randomUUID()}`,
			object: 'response',
			created_at: Math.floor(Date.now() / 1000),
			completed_at: null,
			status: 'in_progress',
			incomplete_details: null,
			model: body.model,
			output: [],
			error: null,
			tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice : 'auto',
			parallel_tool_calls: body.parallel_tool_calls === true,
			usage: null,
		};

		if (isStreaming === true) {
			await this._streamResponses(
				answerShell,
				taskInput,
				response,
				transaction,
				abortController.signal,
				onCorrelationIds,
				declaredTools,
				OpenaiRoutes._unsupportedToolKindsHeaderOf(body.tools),
			);
			return;
		}

		const generationStartedAt = performance.now();
		const answer = await this.runner.run(taskInput, body.model, abortController.signal, onCorrelationIds);
		const generationTimeMs = Math.round(performance.now() - generationStartedAt);

		answerShell.status = 'completed';
		answerShell.completed_at = Math.floor(Date.now() / 1000);
		answerShell.output = ResponsesTranslator.toOutputItems(answer.text, answer.toolCalls, declaredTools);
		answerShell.usage = ResponsesTranslator.toUsage(answer) ?? null;

		if (transaction !== undefined) {
			transaction.respondedAt = new Date();
			transaction.outcome = 'completed';
			transaction.status = 200;
			transaction.responseType = 'response';
			transaction.responseBody = answerShell;
		}
		if (response.writableEnded === true) {
			return;
		}
		response
			.status(200)
			.set({
				'X-Webai-Generation-Time-Ms': String(generationTimeMs),
				...OpenaiRoutes._unsupportedToolKindsHeaderOf(body.tools),
			})
			.json(answerShell);
	}

	/**
	 * Names the kinds of tool a request declared that this server carries nowhere, as a response
	 * header, so that a caller reads which of its declarations never reached the model.
	 *
	 * This follows Rule 3 of this project's OpenAI compatibility requirement: a value the interface
	 * has no field for travels in an `X-Webai-*` response header, or not at all.
	 *
	 * @param tools The `tools` field of the request, absent or null when it declared none.
	 * @returns The header to set, or nothing at all when every declared tool was carried.
	 */
	private static _unsupportedToolKindsHeaderOf(tools: ResponsesTool[] | null | undefined): Record<string, string> {
		const kinds = ResponsesTranslator.unsupportedToolKinds(tools);
		if (kinds.length === 0) {
			return {};
		}
		return {
			'X-Webai-Unsupported-Tool-Kinds': kinds.join(', '),
		};
	}

	/**
	 * Turns a `POST /v1/responses` body that does not match the schema into the failure to answer
	 * with.
	 *
	 * It is not the chat completion one: that one ends by saying a message's content must be a
	 * single piece of text, which is true there and false here, because this interface writes
	 * content as a list of parts.
	 *
	 * @param failure What the schema reported.
	 * @returns The failure to answer with.
	 */
	private static _responsesSchemaFailureOf(failure: z.ZodError): OpenaiError {
		const reasons = failure.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
		const firstPathPart = failure.issues[0]?.path[0];
		const param = typeof firstPathPart === 'string' ? firstPathPart : null;
		return OpenaiError.invalidRequest(`The request body is not one this server can read. ${reasons}.`, param);
	}

	/**
	 * Answers one `POST /v1/responses` request as its answer is written, as named server-sent
	 * events.
	 *
	 * The order and the shape of those events are the ones recorded between the Codex command-line
	 * program and a server it accepts, and they are written by `ResponsesStreamWriter`. A failure
	 * after the first event is written into the stream as `response.failed`, because the status
	 * line is gone by then; a failure before it is thrown and answered with a status like any
	 * other.
	 *
	 * @param answerShell The answer being built, already carrying its identifier and its model.
	 * @param taskInput The task to run, already asking for its answer in pieces.
	 * @param response The response to write the stream to.
	 * @param transaction This request's transaction record, absent only in a test.
	 * @param abortSignal Reports that whoever sent the request has gone.
	 * @param onCorrelationIds Told the identifiers this request is submitted under.
	 * @param declaredTools The tools the request declared, read for the types each argument was
	 * declared with when a tool call has to be written out.
	 * @param unsupportedToolKindsHeader Names the kinds of tool this server carried nowhere, empty
	 * when every declared tool was carried.
	 * @throws OpenaiError when the task fails before any event has been written.
	 */
	private async _streamResponses(
		answerShell: ResponsesResponse,
		taskInput: TaskInput,
		response: Express.Response,
		transaction: ChatCompletionTransaction | undefined,
		abortSignal: AbortSignal,
		onCorrelationIds: (ids: { taskRequestId: string; taskId?: string }) => void,
		declaredTools: ToolDeclaration[] | undefined,
		unsupportedToolKindsHeader: Record<string, string>,
	): Promise<void> {
		const writer = new ResponsesStreamWriter(response, answerShell);
		const messageItemId = `msg_${Crypto.randomUUID()}`;
		let isMessageStarted = false;
		let writtenText = '';

		try {
			writer.start(unsupportedToolKindsHeader);
			if (transaction !== undefined) {
				transaction.status = 200;
				transaction.responseType = 'response.stream';
			}

			const answer = await this.runner.run(taskInput, answerShell.model, abortSignal, onCorrelationIds, (piece) => {
				if (isMessageStarted === false) {
					isMessageStarted = true;
					writer.startMessageItem(messageItemId);
				}
				writtenText = writtenText + piece;
				writer.writeTextPiece(messageItemId, piece);
			});

			// An answer that produced no pieces at all still has to be sent, which happens when the
			// stage that ran it produced its whole answer in one go. An answer that is only a tool
			// call carries no text at all, and opens no message item.
			if (isMessageStarted === false && answer.text !== '') {
				isMessageStarted = true;
				writer.startMessageItem(messageItemId);
				writtenText = answer.text;
				writer.writeTextPiece(messageItemId, answer.text);
			}
			if (isMessageStarted === true) {
				writer.finishMessageItem({
					id: messageItemId,
					type: 'message',
					role: 'assistant',
					status: 'completed',
					content: [
						{
							type: 'output_text',
							text: writtenText,
							annotations: [],
						},
					],
				});
			}

			for (const item of ResponsesTranslator.toOutputItems('', answer.toolCalls, declaredTools)) {
				writer.writeFunctionCallItem(item);
			}

			writer.finish(ResponsesTranslator.toUsage(answer));

			if (transaction !== undefined) {
				transaction.respondedAt = new Date();
				transaction.outcome = 'completed';
				transaction.responseBody = writer.answer;
			}
		} catch (failure: unknown) {
			if (writer.hasWritten === false) {
				throw failure;
			}
			const openaiError = failure instanceof OpenaiError ? failure : undefined;
			writer.fail(
				openaiError === undefined ? 'server_error' : openaiError.body.error.code ?? 'server_error',
				failure instanceof Error ? failure.message : String(failure),
			);
			if (transaction !== undefined) {
				transaction.respondedAt = new Date();
				transaction.outcome = 'failed';
				transaction.responseBody = writer.answer;
			}
		}
	}

	/**
	 * Answers one chat completion as its answer is written, as server-sent events.
	 *
	 * The answer is sent as a sequence of chunks, each on its own `data:` line, ended by a
	 * `data: [DONE]` line. The first chunk states the role and carries no text; each chunk after
	 * it carries one piece of the answer as the cluster reports it; the last carries no text and
	 * says the answer stopped.
	 *
	 * A failure is answered differently here from everywhere else in this file. Once the first
	 * chunk has been written the status line is gone, so there is no HTTP status left to fail
	 * with: the failure is written into the stream instead, as a `data:` line carrying the same
	 * error body an ordinary failure would have carried, and the stream is then ended. A failure
	 * before the first chunk is thrown, and is answered with a status like any other.
	 *
	 * @param modelId The model the request asked for, repeated on every chunk.
	 * @param taskInput The task to run, already asking for its answer in pieces.
	 * @param response The response to write the stream to.
	 * @param transaction This request's transaction record, absent only in a test.
	 * @param abortSignal Reports that whoever sent the request has gone.
	 * @param onCorrelationIds Told the identifiers this request is submitted under.
	 * @param includeUsage Whether the request asked for a final usage chunk with
	 * `stream_options: { include_usage: true }`, an existing field of the OpenAI Chat Completions
	 * interface. See milestone 4 of
	 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
	 * @param declaredTools The tools the request declared, `undefined` when it declared none, read
	 * for the types each argument was declared with when a tool call has to be written out.
	 * @throws OpenaiError when the task fails before any chunk has been written.
	 */
	private async _streamChatCompletion(
		modelId: string,
		taskInput: TaskInput,
		response: Express.Response,
		transaction: ChatCompletionTransaction | undefined,
		abortSignal: AbortSignal,
		onCorrelationIds: (ids: { taskRequestId: string; taskId?: string }) => void,
		includeUsage: boolean,
		declaredTools: ToolDeclaration[] | undefined,
	): Promise<void> {
		const completionId = `chatcmpl-${Crypto.randomUUID()}`;
		const created = Math.floor(Date.now() / 1000);
		const generationStartedAt = performance.now();
		let isAnythingWritten = false;
		/** Writes one chunk of the answer, opening the stream if this is the first. */
		const writeChunk = (choice: ChatCompletionChunkChoice): void => {
			if (response.writableEnded === true) {
				return;
			}
			if (isAnythingWritten === false) {
				isAnythingWritten = true;
				// Announced before anything is written, because the headers can no longer be set
				// afterwards. `no-cache` keeps anything in between from holding the answer back
				// until it is complete, which would undo the point of sending it in pieces. The
				// total generation time is not known yet, so under Rule 3 the one fact this
				// response can still carry in a header is how long the cluster took to produce
				// this first chunk — the only generation-time fact known before the headers of a
				// streamed answer must be sent.
				const timeToFirstPieceMs = Math.round(performance.now() - generationStartedAt);
				response.status(200).set({
					'Content-Type': 'text/event-stream; charset=utf-8',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					'X-Webai-Time-To-First-Piece-Ms': String(timeToFirstPieceMs),
				});
				if (transaction !== undefined) {
					transaction.status = 200;
					transaction.responseType = 'chat.completion.chunk';
				}
			}
			// Every answer chunk carries `usage: null`, whether or not the caller asked for the
			// final usage chunk, exactly as the OpenAI Chat Completions interface does it — a
			// reader watching `usage` in order sees `null` on every chunk until the final one.
			const chunk: ChatCompletionAnswerChunk = {
				id: completionId,
				object: 'chat.completion.chunk',
				created,
				model: modelId,
				choices: [choice],
				usage: null,
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		};
		/**
		 * Writes the final usage chunk, carrying no choices, once the request asked for it with
		 * `stream_options: { include_usage: true }`.
		 */
		const writeUsageChunk = (usage: ChatCompletionUsage): void => {
			if (includeUsage === false) {
				return;
			}
			if (response.writableEnded === true) {
				return;
			}
			const chunk: ChatCompletionUsageChunk = {
				id: completionId,
				object: 'chat.completion.chunk',
				created,
				model: modelId,
				choices: [],
				usage,
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		};

		try {
			const answer = await this.runner.run(taskInput, modelId, abortSignal, onCorrelationIds, (piece) => {
				if (isAnythingWritten === false) {
					writeChunk({
						index: 0,
						delta: {
							role: 'assistant',
						},
						logprobs: null,
						finish_reason: null,
					});
				}
				writeChunk({
					index: 0,
					delta: {
						content: piece,
					},
					logprobs: null,
					finish_reason: null,
				});
			});
			// An answer that produced no pieces at all still has to be sent. That happens when the
			// stage that ran it produced its whole answer in one go, which is what an older worker
			// does, so the whole answer is sent as one piece rather than the caller being told the
			// answer was empty.
			if (isAnythingWritten === false) {
				writeChunk({
					index: 0,
					delta: {
						role: 'assistant',
					},
					logprobs: null,
					finish_reason: null,
				});
				if (answer.text !== '') {
					writeChunk({
						index: 0,
						delta: {
							content: answer.text,
						},
						logprobs: null,
						finish_reason: null,
					});
				}
			}
			// A model that asked for a tool wrote no text, so nothing above has written its answer:
			// the tool calls are the answer, and they are written here as one chunk. This interface
			// allows them to arrive in pieces across several chunks, and they never do here, because
			// a worker reports a whole tool call or none at all.
			const askedForTools = answer.toolCalls !== undefined && answer.toolCalls.length > 0;
			if (askedForTools === true && answer.toolCalls !== undefined) {
				writeChunk({
					index: 0,
					delta: {
						tool_calls: ToolTranslator.toOpenaiToolCalls(answer.toolCalls, declaredTools ?? []).map((toolCall, toolCallIndex) => ({
							index: toolCallIndex,
							...toolCall,
						})),
					},
					logprobs: null,
					finish_reason: null,
				});
			}
			// Rule 2 of this project's OpenAI compatibility requirement: an answer the cluster gave
			// up on producing has no OpenAI value for `finish_reason`. Translating it is done here,
			// after every piece has already been written, so that a failure to translate it falls
			// into the `catch` below and is written into the stream as an error, which is what an
			// OpenAI client already expects when a stream fails partway through.
			//
			// A model that asked for a tool has its own stop reason left untranslated, exactly as in
			// the whole-answer path above: it stopped because it had finished asking, and the worker
			// reports that as `interrupted` because stopping the moment a tool call is complete is
			// how it stops. Translating that would fail every streamed answer that asked for a tool,
			// which is what it did until this was written.
			const finishReason = askedForTools === true ? 'tool_calls' : FinishReasonTranslator.translate(answer.stopReason);
			writeChunk({
				index: 0,
				delta: {},
				logprobs: null,
				finish_reason: finishReason,
			});
			// Rule 1 of this project's OpenAI compatibility requirement: the final usage chunk is
			// sent only when both counts are known, never with an invented or estimated count.
			const usage = OpenaiRoutes._usageOf(answer);
			if (usage !== undefined) {
				writeUsageChunk(usage);
			}
			if (transaction !== undefined) {
				transaction.respondedAt = new Date();
				transaction.outcome = 'completed';
				transaction.responseBody = {
					object: 'chat.completion.chunk',
					// An answer that asked for a tool has no text, so the record would say nothing at
					// all about what was answered unless the tool calls are recorded beside it.
					answer: answer.text,
					...(askedForTools === false ? {} : { toolCalls: answer.toolCalls }),
				};
			}
			OpenaiRoutes._endStream(response);
		} catch (failure: unknown) {
			if (isAnythingWritten === false) {
				throw failure;
			}
			const error =
				failure instanceof OpenaiError
					? failure
					: OpenaiError.taskFailed(failure instanceof Error ? failure.message : String(failure));
			if (transaction !== undefined) {
				transaction.respondedAt = new Date();
				transaction.outcome = 'failed';
				transaction.responseBody = error.body;
			}
			if (response.writableEnded === false) {
				response.write(`data: ${JSON.stringify(error.body)}\n\n`);
			}
			OpenaiRoutes._endStream(response);
		}
	}

	/**
	 * Ends a stream the way a reader expects, with the line that says no more chunks follow.
	 *
	 * @param response The response carrying the stream.
	 */
	private static _endStream(response: Express.Response): void {
		if (response.writableEnded === true) {
			return;
		}
		response.write('data: [DONE]\n\n');
		response.end();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading The Request
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the `usage` object for a task's answer, under Rule 1 of this project's OpenAI
	 * compatibility requirement.
	 *
	 * @param answer What the cluster task produced.
	 * @returns The `usage` object, or `undefined` when the worker that produced the answer did
	 * not report both counts, since `total_tokens` cannot be stated without both of them and no
	 * count here is ever estimated from one that is missing.
	 */
	private static _usageOf(answer: { promptTokenCount: number | undefined; completionTokenCount: number | undefined }): ChatCompletionUsage | undefined {
		if (answer.promptTokenCount === undefined || answer.completionTokenCount === undefined) {
			return undefined;
		}
		return {
			prompt_tokens: answer.promptTokenCount,
			completion_tokens: answer.completionTokenCount,
			total_tokens: answer.promptTokenCount + answer.completionTokenCount,
		};
	}

	/**
	 * Turns the reasons a body failed its checks into one failure naming each of them.
	 *
	 * @param failure The reasons the schema gave.
	 * @returns The failure to answer with.
	 */
	private static _schemaFailureOf(failure: z.ZodError): OpenaiError {
		const reasons = failure.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
		const firstPathPart = failure.issues[0]?.path[0];
		const param = typeof firstPathPart === 'string' ? firstPathPart : null;
		return OpenaiError.invalidRequest(
			`The request body is not one this server can read. ${reasons}. A message's content must be a ` +
				'single piece of text; a list of content parts is not accepted.',
			param,
		);
	}

	/**
	 * Checks the key a request presents, when this server was started with one to require.
	 *
	 * @param request The incoming request.
	 * @throws OpenaiError when the key is absent or does not match.
	 */
	private _checkApiKey(request: Express.Request): void {
		const apiKey = this.apiKey;
		if (apiKey === undefined) {
			return;
		}
		const presentedMatch = /^Bearer (.*)$/i.exec(request.header('authorization') ?? '');
		if (presentedMatch === null) {
			throw OpenaiError.authenticationFailed();
		}
		const presented = Buffer.from(presentedMatch[1], 'utf8');
		const expected = Buffer.from(apiKey, 'utf8');
		// The two are compared in a way that takes the same time whether they match early or
		// late, which needs them to be the same length before they are compared at all.
		if (presented.length !== expected.length) {
			throw OpenaiError.authenticationFailed();
		}
		if (Crypto.timingSafeEqual(presented, expected) === false) {
			throw OpenaiError.authenticationFailed();
		}
	}

	/**
	 * Answers a request with a failure.
	 *
	 * @param response The response to answer with.
	 * @param failure The failure. Anything that is not an `OpenaiError` is a fault in this
	 * server rather than in the request, so it is reported as such and written to this server's
	 * own output.
	 * @param transaction This request's transaction record, so the failure is recorded on it.
	 * Absent for a route this server does not log a transaction for, such as `GET /v1/models`.
	 */
	private static _sendFailure(
		response: Express.Response,
		failure: unknown,
		transaction?: ChatCompletionTransaction,
	): void {
		const openaiFailure = failure instanceof OpenaiError ? failure : OpenaiError.unexpected();
		if (failure instanceof OpenaiError === false) {
			console.error(failure);
		}
		if (transaction !== undefined) {
			transaction.respondedAt = new Date();
			transaction.outcome = 'failed';
			transaction.status = openaiFailure.status;
			transaction.responseType = 'error';
			transaction.responseBody = openaiFailure.body;
		}
		if (response.writableEnded === true) {
			return;
		}
		response.status(openaiFailure.status).json(openaiFailure.body);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Transaction Log
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Starts this request's transaction record, and arranges for it to be written exactly once,
	 * when the response closes.
	 *
	 * The response's `close` event is used rather than writing the record at the place a status
	 * is decided, because it fires exactly once whether the response was sent in full or the
	 * caller went away first, and by then `response.writableEnded` says which one happened. That
	 * keeps the record for a completed call and the record for an abandoned one to a single
	 * write, rather than one attempt per place a status can be decided.
	 *
	 * @param request The incoming request.
	 * @param response The response that will answer it.
	 */
	private _beginTransaction(request: Express.Request, response: Express.Response): void {
		const transaction: ChatCompletionTransaction = {
			id: Crypto.randomUUID(),
			receivedAt: new Date(),
			model: undefined,
			authOutcome: undefined,
			gatewayTaskRequestId: undefined,
			gatewayTaskId: undefined,
			respondedAt: undefined,
			outcome: undefined,
			status: undefined,
			responseType: undefined,
			responseBody: undefined,
		};
		this.transactions.set(request, transaction);
		response.on('close', () => {
			// A response that was never written to has not answered the request: the caller went
			// away, whether or not a failure had already been decided for it.
			const isCallerDisconnected = response.writableEnded === false;
			const respondedAt = transaction.respondedAt ?? new Date();
			this.transactionLogger.log({
				id: transaction.id,
				receivedAt: transaction.receivedAt,
				method: request.method,
				path: request.originalUrl,
				httpVersion: `HTTP/${request.httpVersion}`,
				requestHeaders: request.headers,
				requestBody: request.body,
				model: transaction.model,
				authOutcome: transaction.authOutcome ?? 'not_required',
				gatewayTaskRequestId: transaction.gatewayTaskRequestId,
				gatewayTaskId: transaction.gatewayTaskId,
				outcome: isCallerDisconnected ? 'cancelled' : (transaction.outcome ?? 'failed'),
				status: isCallerDisconnected ? 0 : (transaction.status ?? 0),
				responseType: isCallerDisconnected ? 'none' : (transaction.responseType ?? 'none'),
				responseBody: isCallerDisconnected ? undefined : transaction.responseBody,
				elapsedMs: respondedAt.getTime() - transaction.receivedAt.getTime(),
				isCallerDisconnected,
			});
		});
	}
}
