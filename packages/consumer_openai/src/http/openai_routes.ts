// node imports
import Crypto from 'node:crypto';

// npm imports
import Express from 'express';
import { TaskInputFactory } from '@webai/consumer-cli';
import type { TaskInput } from '@webai/protocol';
import type { z } from 'zod';

// local imports
import type { ClusterTaskRunner } from '../libs/cluster_task_runner.js';
import type {
	CurlStyleTransactionLogger,
	TransactionAuthOutcome,
	TransactionOutcome,
	TransactionResponseType,
} from './curl_style_transaction_logger.js';
import { ConversationBuilder } from '../api/conversation_builder.js';
import { GenerationSettingsBuilder } from '../api/generation_settings_builder.js';
import { ModelCatalog } from '../api/model_catalog.js';
import { OpenaiError } from '../api/openai_error.js';
import { FinishReasonTranslator } from '../api/finish_reason_translator.js';
import { PromptFlattener } from '../api/prompt_flattener.js';
import {
	ChatCompletionRequestSchema,
	type ChatCompletionAnswerChunk,
	type ChatCompletionChunkChoice,
	type ChatCompletionResponse,
	type ChatCompletionUsage,
	type ChatCompletionUsageChunk,
	type HealthResponse,
} from '../api/openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiRoutes — the endpoints this server answers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The largest request body this server reads. */
const bodySizeLimit = '1mb';

/**
 * What this server has learned about one `POST /v1/chat/completions` request, gathered as it is
 * read, checked, and answered, and written to the transaction log exactly once, when the
 * response closes.
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
	 * Every `POST /v1/chat/completions` request's transaction in flight, keyed by its Express
	 * request object, so the response-close handler set up when the request begins can find it
	 * later.
	 */
	private readonly transactions = new WeakMap<Express.Request, ChatCompletionTransaction>();

	/**
	 * @param runner Runs one cluster task per request.
	 * @param apiKey The key a request must present, when this server was started with one.
	 * @param startedAtSeconds When this server started, as a whole number of seconds since the
	 * start of 1970, which is the creation date it states for every model.
	 * @param transactionLogger Where every chat completion request is recorded as one transaction.
	 * @param commitSha The git commit this server was built from, published on the `/health` route.
	 */
	constructor(
		private readonly runner: ClusterTaskRunner,
		private readonly apiKey: string | undefined,
		private readonly startedAtSeconds: number,
		private readonly transactionLogger: CurlStyleTransactionLogger,
		private readonly commitSha: string,
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

		router.get('/v1/models', (_request, response) => {
			response.status(200).json(ModelCatalog.list(this.startedAtSeconds));
		});

		// An asynchronous handler that fails does not reach the error handling of Express by
		// itself, so this route catches its own failures rather than relying on that.
		router.post('/v1/chat/completions', (request, response) => {
			const transaction = this.transactions.get(request);
			void this._handleChatCompletion(request, response, transaction).catch((failure: unknown) =>
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

		// A task type whose worker can hand a message list to its own chat template is sent the
		// conversation as it was written, each message keeping its own role. Every other task type
		// still takes one piece of text, so its request is flattened exactly as it always was.
		const promptOrConversation = TaskInputFactory.acceptsConversation(taskTypeName)
			? ConversationBuilder.build(body.messages)
			: PromptFlattener.flatten(body.messages);
		const isStreaming = body.stream === true;
		// Asking the cluster for the answer in pieces is what makes it report them, and it is
		// asked only when the caller asked, because a task answered in pieces costs a scheduling
		// round for every piece. The five generation controls join it here, and this is also where
		// a request asking a model for a control it cannot honour is refused rather than answered
		// as though nothing had been asked for.
		const generationSettings = GenerationSettingsBuilder.build(body, taskTypeName, isStreaming);
		let taskInput: TaskInput;
		try {
			// A request that asked for nothing submits exactly what it did before generation
			// settings existed: no settings block at all.
			taskInput = TaskInputFactory.createTaskInput(taskTypeName, promptOrConversation, generationSettings);
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
			);
			return;
		}

		const generationStartedAt = performance.now();
		const answer = await this.runner.run(taskInput, body.model, abortController.signal, onCorrelationIds);
		const generationTimeMs = Math.round(performance.now() - generationStartedAt);
		// Rule 2 of this project's OpenAI compatibility requirement: an answer the cluster gave up
		// on producing has no OpenAI value for `finish_reason`, so it is reported as an HTTP error
		// for a whole-answer response like this one, rather than an invented `finish_reason`.
		const finishReason = FinishReasonTranslator.translate(answer.stopReason);
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
			// Rule 2 of this project's OpenAI compatibility requirement: an answer the cluster gave
			// up on producing has no OpenAI value for `finish_reason`. Translating it is done here,
			// after every piece has already been written, so that a failure to translate it falls
			// into the `catch` below and is written into the stream as an error, which is what an
			// OpenAI client already expects when a stream fails partway through.
			const finishReason = FinishReasonTranslator.translate(answer.stopReason);
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
					answer: answer.text,
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
				path: '/v1/chat/completions',
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
