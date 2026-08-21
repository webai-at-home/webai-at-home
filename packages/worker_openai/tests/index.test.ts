import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';
import { protocolVersion, type ClientMessage, type GatewayMessage, type GenerationSettings, type HistoryInput, type LlmStagePayload } from '@webai/protocol';
import { GatewayWorkerClient, type WorkerSocket } from '../src/libs/gateway_worker_client.js';
import { GatewayConnectionSupervisor } from '../src/libs/gateway_connection_supervisor.js';
import { WorkerStageOffer } from '../src/libs/worker_stage_offer.js';
import { StageHelperLlmLlama3_2_1bFull } from '../src/stages/stage_helper_llm_llama3_2_1b_full.js';
import { StageHelperLlmQwen3_5_0_8bFull } from '../src/stages/stage_helper_llm_qwen3_5_0_8b_full.js';
import { OpenaiApiClient, type ChatCompletionStreamUsage } from '../src/libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the native worker that calls a local OpenAI-compatible server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** A model list, standing in for one a local server would answer with. */
const fakeOpenaiApiClient = (modelIds: string[] | Error): OpenaiApiClient => ({
	listModelIds: async (): Promise<string[]> => {
		if (modelIds instanceof Error) {
			throw modelIds;
		}
		return modelIds;
	},
} as unknown as OpenaiApiClient);

/**
 * A local server's Chat Completions stream, standing in for one LM Studio would
 * answer with: it delivers the given pieces in order, tracks whether the request was aborted,
 * and reports the usage it was given once the stream closes, the same way the real client fills
 * in its own `usage` object as it reads.
 *
 * @param pieces The text pieces the fake stream delivers, one per `pull`.
 * @param usage The usage to report once the stream closes. Defaults to nothing reported, the
 * same as a server milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/150 was
 * not written for.
 * @returns The fake client, and the state tracking whether it was aborted.
 */
const fakeChatClient = (
	pieces: string[],
	usage?: ChatCompletionStreamUsage,
): { client: OpenaiApiClient; state: { abortedCount: number } } => {
	const state = { abortedCount: 0 };
	const client = {
		listModelIds: async (): Promise<string[]> => ['llama-3.2-1b-instruct'],
		chatCompletionStream: async (
			_modelId: string,
			_prompt: string,
			abortController: AbortController,
		): Promise<{ stream: ReadableStream<string>; usage: ChatCompletionStreamUsage }> => {
			abortController.signal.addEventListener('abort', () => {
				state.abortedCount += 1;
			});
			let index = 0;
			const stream = new ReadableStream<string>({
				pull(controller) {
					if (index >= pieces.length) {
						controller.close();
						return;
					}
					controller.enqueue(pieces[index]);
					index += 1;
				},
			});
			return { stream, usage: usage ?? { promptTokenCount: undefined, completionTokenCount: undefined, finishReason: undefined } };
		},
	};
	return { client: client as unknown as OpenaiApiClient, state };
};

/**
 * Runs one real Chat Completions request through {@link OpenaiApiClient} against a local HTTP
 * server, and returns the request body that server received.
 *
 * A local server is used rather than a fake client because what is being checked is the request
 * body this client builds, which no fake client would build.
 *
 * @param generationSettings What the consumer asked for, passed to the client unchanged.
 * @param promptOrHistory The prompt or history submitted with the task, a single prompt by default
 * so that every test written before a history could carry tools reads unchanged.
 * @returns The parsed request body the local server received.
 */
const requestBodyOf = async (generationSettings: GenerationSettings | undefined, promptOrHistory: string | HistoryInput = 'hello'): Promise<Record<string, unknown>> => {
	let receivedBody = '';
	const server = Http.createServer((request, response) => {
		request.on('data', (piece: Buffer) => {
			receivedBody += piece.toString();
		});
		request.on('end', () => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.end('data: [DONE]\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	try {
		const client = new OpenaiApiClient(`http://127.0.0.1:${port}/v1`);
		const { stream } = await client.chatCompletionStream('llama-3.2-1b-instruct', promptOrHistory, new AbortController(), generationSettings);
		const reader = stream.getReader();
		while ((await reader.read()).done === false) {
			continue;
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	return JSON.parse(receivedBody) as Record<string, unknown>;
};

/**
 * Runs one stage run against a local HTTP server that answers with the streamed events given, and
 * returns the stage result.
 *
 * A local server is used rather than a fake client because what is being checked is what
 * {@link OpenaiApiClient} reads out of a real stream of events, which no fake client would produce.
 * The events are the ones LM Studio sent in milestone 0's de-risk gate for
 * https://github.com/webai-at-home/webai-at-home/issues/190, so a tool call arrives the way a
 * local server really sends one: the name in one event, the arguments in a later one of the same
 * index.
 *
 * @param events The bodies of the `data:` lines the local server answers with, in order.
 * @param payload The stage payload the run is given, which is what declares the tools.
 * @param generationSettings What the consumer asked for, passed to the stage unchanged.
 * @returns The stage result.
 */
const streamedStageResultOf = async (
	events: Record<string, unknown>[],
	payload: LlmStagePayload,
	generationSettings?: GenerationSettings,
): Promise<LlmStagePayload> => {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n`).join('')}data: [DONE]\n`;
	return await rawStreamedStageResultOf(body, payload, generationSettings);
};

/**
 * Runs one stage run against a local HTTP server that answers with exactly the body given, and
 * returns the stage result.
 *
 * Separate from {@link streamedStageResultOf} because a body built out of `data:` lines can carry
 * no `event:` line, and `event: error` is how LM Studio writes a failure into a stream it has
 * already answered with a successful status. Milestone 0 of
 * https://github.com/webai-at-home/webai-at-home/issues/215 measured that shape live.
 *
 * @param body The whole response body the local server answers with, written exactly as given.
 * @param payload The stage payload the run is given.
 * @param generationSettings What the consumer asked for, passed to the stage unchanged.
 * @returns The stage result.
 */
const rawStreamedStageResultOf = async (
	body: string,
	payload: LlmStagePayload,
	generationSettings?: GenerationSettings,
): Promise<LlmStagePayload> => {
	const server = Http.createServer((request, response) => {
		request.on('data', () => undefined);
		request.on('end', () => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	const taskId = `task-${String(port)}`;
	const stageAssignmentId = `assignment-${String(port)}`;
	try {
		const client = new OpenaiApiClient(`http://127.0.0.1:${port}/v1`);
		return await StageHelperLlmQwen3_5_0_8bFull.compute(
			taskId, stageAssignmentId, payload, generationSettings, client, 'qwen_qwen3.5-0.8b',
		);
	} finally {
		// A run that returned a piece leaves its answer open, holding the request to this local
		// server open with it, and a local server with an open request never finishes closing.
		StageHelperLlmQwen3_5_0_8bFull.clearGeneration(taskId, stageAssignmentId);
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
};

/** One streamed event carrying a tool call fragment, as a local server sends one. */
const toolCallEvent = (index: number, fragment: { name?: string; arguments?: string }): Record<string, unknown> => ({
	choices: [
		{
			delta: {
				tool_calls: [
					{
						index,
						type: 'function',
						function: fragment,
					},
				],
			},
		},
	],
});

/** The history the tool tests submit: one question, and one tool that answers it. */
const weatherHistory: HistoryInput = {
	messages: [
		{
			role: 'user',
			content: 'What is the weather in Paris?',
		},
	],
	tools: [
		{
			name: 'get_weather',
			description: 'Get the weather for a city',
			parametersJsonSchema: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
					},
				},
				required: ['city'],
			},
		},
	],
};

/**
 * Runs one real request through {@link OpenaiApiClient} against a local HTTP server, and returns
 * the `Authorization` header that server received.
 *
 * @param apiKey The API key to construct the client with, passed to it unchanged.
 * @returns The `Authorization` header the local server received, or `undefined` when none was sent.
 */
const receivedAuthorizationHeaderOf = async (apiKey: string | undefined): Promise<string | undefined> => {
	let receivedAuthorizationHeader: string | undefined;
	const server = Http.createServer((request, response) => {
		receivedAuthorizationHeader = request.headers.authorization;
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ data: [] }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address !== null ? address.port : 0;
	try {
		const client = new OpenaiApiClient(`http://127.0.0.1:${port}/v1`, apiKey);
		await client.listModelIds();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	return receivedAuthorizationHeader;
};

/** The pipelines a gateway with the built-in specifications would answer `pipelines.get` with. */
const loadedPipelines = [
	{
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply' },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add' },
		],
	},
	{
		stages: [
			{ name: 'stage_llm_llama3_2_1b_full', computation: 'llm_llama3_2_1b_full' },
		],
	},
	{
		stages: [
			{ name: 'stage_llm_qwen3_5_0_8b_full', computation: 'llm_qwen3_5_0_8b_full' },
		],
	},
];

/** A connection that records what was sent on it, standing in for one to the gateway. */
const fakeSocket = (): WorkerSocket & { sent: ClientMessage[]; closeReason: string | undefined } => {
	const socket = {
		readyState: 1,
		OPEN: 1,
		sent: [] as ClientMessage[],
		closeReason: undefined as string | undefined,
		send(data: string): void {
			socket.sent.push((JSON.parse(data) as { body: ClientMessage }).body);
		},
		close(code?: number, reason?: string): void {
			socket.closeReason = reason;
		},
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	return socket;
};

/**
 * Hands one gateway message to a client, as the connection would.
 *
 * @param socket The connection the client was built with.
 * @param message The message the gateway sent.
 */
const receive = (socket: WorkerSocket, message: GatewayMessage): void => {
	socket.onmessage?.({
		data: JSON.stringify({
			v: protocolVersion,
			id: 'message-test',
			ts: new Date().toISOString(),
			body: message,
		}),
	});
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Choosing The Stages To Offer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('offers a stage by the computation it names, and never by its stage name', () => {
	const offered = WorkerStageOffer.offeredStages(loadedPipelines, []);
	Assert.deepEqual(offered.stageNames, ['stage_llm_llama3_2_1b_full', 'stage_llm_qwen3_5_0_8b_full']);
	// Every stage this worker carries a helper for is one the local server must hold the model for.
	Assert.deepEqual(offered.localModelStageNames, ['stage_llm_llama3_2_1b_full', 'stage_llm_qwen3_5_0_8b_full']);
	// A stage name this worker has never heard of is offered all the same, as long as it names a
	// computation this worker implements, which is what lets a pipeline be added without
	// releasing the worker.
	const laterPipeline = [{ stages: [{ name: 'stage_llm_llama3_2_1b_full_again', computation: 'llm_llama3_2_1b_full' }] }];
	Assert.deepEqual(WorkerStageOffer.offeredStages(laterPipeline, []).stageNames, ['stage_llm_llama3_2_1b_full_again']);
});

Test('restricts the offer to the stages the command line named', () => {
	Assert.deepEqual(WorkerStageOffer.offeredStages(loadedPipelines, ['stage_llm_llama3_2_1b_full']).stageNames, ['stage_llm_llama3_2_1b_full']);
	Assert.deepEqual(WorkerStageOffer.offeredStages(loadedPipelines, ['stage_llm_qwen3_5_0_8b_full']).stageNames, ['stage_llm_qwen3_5_0_8b_full']);
	Assert.deepEqual(WorkerStageOffer.offeredStages(loadedPipelines, ['stage_dev_formula_add']).stageNames, []);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Readiness Of The Local Server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('is ready only when the local server offers the model this worker was told to serve', async () => {
	const ready = await StageHelperLlmLlama3_2_1bFull.readiness(fakeOpenaiApiClient(['llama-3.2-1b-instruct', 'qwen3.5-9b']), 'llama-3.2-1b-instruct');
	Assert.deepEqual(ready, { status: 'ready' });
	const missing = await StageHelperLlmLlama3_2_1bFull.readiness(fakeOpenaiApiClient(['qwen3.5-9b']), 'llama-3.2-1b-instruct');
	Assert.equal(missing.status, 'unavailable');
	Assert.match(missing.status === 'unavailable' ? missing.message : '', /does not offer llama-3\.2-1b-instruct/);
	// A server that cannot be reached is reported in the same shape, rather than thrown, because
	// it is the same decision: this worker does not offer the stage.
	const unreachable = await StageHelperLlmLlama3_2_1bFull.readiness(fakeOpenaiApiClient(new Error('connection refused')), 'llama-3.2-1b-instruct');
	Assert.equal(unreachable.status, 'unavailable');
	Assert.match(unreachable.status === 'unavailable' ? unreachable.message : '', /connection refused/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generating An Answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads the whole answer in one run when the consumer asked for nothing', async () => {
	const { client } = fakeChatClient(['Paris', ' is', ' the capital.']);
	const result = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-a', 'assignment-a', { text: 'What is the capital of France?' }, undefined, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(result, { text: 'Paris is the capital.', done: true });
});

Test('sends every generation control the consumer asked for to the local server, under its OpenAI name', async () => {
	const body = await requestBodyOf({
		isStreaming: true,
		temperature: 0,
		topP: 0.9,
		maximumOutputTokenCount: 20,
		stopSequences: ['\nUser:'],
		randomSeed: 42,
		reasoningEffort: 'none',
	});
	Assert.equal(body.temperature, 0);
	Assert.equal(body.top_p, 0.9);
	Assert.equal(body.max_tokens, 20);
	Assert.deepEqual(body.stop, ['\nUser:']);
	Assert.equal(body.seed, 42);
	Assert.equal(body.reasoning_effort, 'none');
	// `isStreaming` is not a generation control the local server is told about: it decides how
	// many stage runs read the answer, and this client always reads the answer as a stream.
	Assert.equal(body.stream, true);
});

Test('sends no generation control field at all when the consumer asked for none, so the local server applies its own defaults', async () => {
	const askedForNothing = await requestBodyOf(undefined);
	Assert.deepEqual(Object.keys(askedForNothing).sort(), ['messages', 'model', 'stream', 'stream_options']);
	// A control left out of the settings block is left out of the body, rather than sent as
	// `null`, one control at a time as well as all six at once.
	const askedForOne = await requestBodyOf({ temperature: 0 });
	Assert.equal(askedForOne.temperature, 0);
	Assert.equal('top_p' in askedForOne, false);
	Assert.equal('max_tokens' in askedForOne, false);
	Assert.equal('stop' in askedForOne, false);
	Assert.equal('seed' in askedForOne, false);
	// This one matters beyond the pattern: a request that says nothing about thinking must reach the
	// local server exactly as it did before this field existed, so that the server's own default is
	// what applies and no default is changed on the consumer's behalf. See
	// [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192).
	Assert.equal('reasoning_effort' in askedForOne, false);
});

Test('sends every reasoning_effort level through untouched, including the ones only a thinking model reads', async () => {
	// The six levels are the ones LM Studio 0.4.20 names itself when it refuses a seventh. This
	// worker translates none of them: what a level means is the local server's business.
	for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
		const body = await requestBodyOf({ reasoningEffort: level });
		Assert.equal(body.reasoning_effort, level);
	}
});

Test('sends an Authorization header carrying the API key it was constructed with, and none at all when it was constructed with none', async () => {
	Assert.equal(await receivedAuthorizationHeaderOf('sk-test-key'), 'Bearer sk-test-key');
	Assert.equal(await receivedAuthorizationHeaderOf(undefined), undefined);
});

Test('reports the usage and finish reason the local server sent, translated into this worker\'s own stopReason vocabulary', async () => {
	const { client } = fakeChatClient(['Paris', ' is', ' the capital.'], { promptTokenCount: 32, completionTokenCount: 5, finishReason: 'stop' });
	const result = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-usage-stop', 'assignment-usage-stop', { text: 'What is the capital of France?' }, undefined, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(result, { text: 'Paris is the capital.', done: true, promptTokenCount: 32, completionTokenCount: 5, stopReason: 'end_of_sequence' });
});

Test('translates a "length" finish reason into "max_new_tokens", and reports no stopReason for one it does not recognise', async () => {
	const { client: lengthClient } = fakeChatClient(['In'], { promptTokenCount: 12, completionTokenCount: 1, finishReason: 'length' });
	const lengthResult = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-usage-length', 'assignment-usage-length', { text: 'Write a long story.' }, undefined, lengthClient, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(lengthResult, { text: 'In', done: true, promptTokenCount: 12, completionTokenCount: 1, stopReason: 'max_new_tokens' });

	const { client: unknownClient } = fakeChatClient(['hi'], { promptTokenCount: undefined, completionTokenCount: undefined, finishReason: 'content_filter' });
	const unknownResult = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-usage-unknown', 'assignment-usage-unknown', { text: 'hello' }, undefined, unknownClient, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(unknownResult, { text: 'hi', done: true });
});

Test('fails the stage when the local server ran out of room before writing any answer text', async () => {
	// The defect of [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192), as the
	// local server reports it: no text at all, and `finish_reason: length` because the model was
	// still generating when its budget ran out. Qwen3.5-0.8B does this by thinking about a plain
	// two-turn question until all 8153 tokens of an 8192-token context are gone.
	const { client } = fakeChatClient([], { promptTokenCount: 37, completionTokenCount: 8153, finishReason: 'length' });
	await Assert.rejects(
		async () => await StageHelperLlmQwen3_5_0_8bFull.compute(
			'task-empty-length', 'assignment-empty-length', { text: 'What is my name?' }, undefined, client, 'qwen_qwen3.5-0.8b',
		),
		(error: unknown) => {
			// The message says how many tokens went nowhere and what to ask for instead, because a
			// consumer reading it has no other way to find out either.
			Assert.match((error as Error).message, /all 8153 tokens/);
			Assert.match((error as Error).message, /reasoning_effort "none"/);
			return true;
		},
	);
});

Test('still reports an empty answer the model ended of its own accord, which says something an interrupted one does not', async () => {
	// `finish_reason: stop` with no text is a model that had nothing to say, which is an answer.
	// Only running out of room mid-generation says the model had more to say and no room to say it.
	const { client } = fakeChatClient([], { promptTokenCount: 12, completionTokenCount: 0, finishReason: 'stop' });
	const result = await StageHelperLlmQwen3_5_0_8bFull.compute(
		'task-empty-stop', 'assignment-empty-stop', { text: 'Say nothing at all.' }, undefined, client, 'qwen_qwen3.5-0.8b',
	);
	Assert.deepEqual(result, { text: '', done: true, promptTokenCount: 12, completionTokenCount: 0, stopReason: 'end_of_sequence' });
});

Test('still reports an answer that ran out of room after writing something, since that answer is real as far as it goes', async () => {
	// `max_completion_tokens: 1` ends a perfectly good answer at its limit. Only an answer that
	// never began is refused.
	const { client } = fakeChatClient(['In'], { promptTokenCount: 12, completionTokenCount: 1, finishReason: 'length' });
	const result = await StageHelperLlmQwen3_5_0_8bFull.compute(
		'task-short-length', 'assignment-short-length', { text: 'Write a long story.' }, undefined, client, 'qwen_qwen3.5-0.8b',
	);
	Assert.deepEqual(result, { text: 'In', done: true, promptTokenCount: 12, completionTokenCount: 1, stopReason: 'max_new_tokens' });
});

Test('fails the stage when the local server writes an error event into a stream it already answered successfully', async () => {
	// The defect of [issue #215](https://github.com/webai-at-home/webai-at-home/issues/215), as
	// LM Studio 0.4.20 serving `qwen_qwen3.5-0.8b` really writes it: HTTP 200, one `event: error`
	// line, one `data:` line carrying the message twice, and then nothing at all — no
	// `finish_reason`, no `usage`, and no `data: [DONE]`. Measured live for milestone 0.
	const failure = 'Engine protocol predict request returned 500: Jinja Exception: System message must be at the beginning.';
	const body = `event: error\ndata: ${JSON.stringify({ error: { message: failure }, message: failure })}\n\n`;
	await Assert.rejects(
		async () => await rawStreamedStageResultOf(body, { text: 'What is the capital of France?' }),
		(error: unknown) => {
			// The stage fails with the message the local server gave, because that message is the
			// only account of the real cause anyone downstream will ever get.
			Assert.match((error as Error).message, /Jinja Exception: System message must be at the beginning\./);
			return true;
		},
	);
});

Test('fails the stage when a streamed event carries an error object with no event line before it', async () => {
	// `--openai-base-url` can be pointed at any server speaking this interface, and only LM Studio
	// and Ollama have been measured, so an `error` object is read as a failure however it arrives.
	const body = `data: ${JSON.stringify({ error: { message: 'the engine crashed' } })}\n\ndata: [DONE]\n\n`;
	await Assert.rejects(
		async () => await rawStreamedStageResultOf(body, { text: 'What is the capital of France?' }),
		(error: unknown) => {
			Assert.match((error as Error).message, /the engine crashed/);
			return true;
		},
	);
});

Test('reads an answer whose events are named something other than a failure, and reads the pieces after one', async () => {
	// Only an event named `error` is a failure. A server that names its ordinary events is read
	// exactly as one that names none, and the blank line ending a named event clears that name
	// rather than carrying it onto whatever follows.
	const body = 'event: message\ndata: {"choices":[{"delta":{"content":"Par"}}]}\n\n'
		+ 'data: {"choices":[{"delta":{"content":"is"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	const result = await rawStreamedStageResultOf(body, { text: 'What is the capital of France?' });
	Assert.deepEqual(result, { text: 'Paris', done: true, stopReason: 'end_of_sequence' });
});

Test('fails the stage when the answer holds no text and the local server never said why generation stopped', async () => {
	// The safety net behind reading the error events: a failure written in a shape this worker has
	// never seen still ends a stream having produced nothing and having reported no finish reason,
	// and a server that finishes an answer always reports one.
	const body = `data: ${JSON.stringify({ failure: 'the engine died' })}\n\ndata: [DONE]\n\n`;
	await Assert.rejects(
		async () => await rawStreamedStageResultOf(body, { text: 'What is the capital of France?' }),
		(error: unknown) => {
			Assert.match((error as Error).message, /without ever saying why generation stopped/);
			return true;
		},
	);
});

Test('still reports an empty answer that ended of its own accord when it is read out of a real stream', async () => {
	// The [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) decision, checked
	// through the real reader rather than a fake client: `finish_reason: stop` with no text is a
	// model that had nothing to say, and refusing an empty answer for having no finish reason must
	// not touch it.
	const body = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	const result = await rawStreamedStageResultOf(body, { text: 'Say nothing at all.' });
	Assert.deepEqual(result, { text: '', done: true, stopReason: 'end_of_sequence' });
});

Test('reads one piece per run, and joins them across a continuation, when asked for pieces', async () => {
	const { client } = fakeChatClient(['Paris', ' is', ' the capital.']);
	const first = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-b', 'assignment-b', { text: 'What is the capital of France?' }, { isStreaming: true }, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(first, { newText: 'Paris', isContinuation: true, done: false });
	const second = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-b', 'assignment-b', { isContinuation: true }, { isStreaming: true }, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(second, { newText: ' is', isContinuation: true, done: false });
	const third = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-b', 'assignment-b', { isContinuation: true }, { isStreaming: true }, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(third, { newText: ' the capital.', isContinuation: true, done: false });
	const fourth = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-b', 'assignment-b', { isContinuation: true }, { isStreaming: true }, client, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(fourth, { text: 'Paris is the capital.', done: true });
});

Test('refuses to carry on an answer this worker is not holding', async () => {
	const { client } = fakeChatClient(['hello']);
	await Assert.rejects(
		() => StageHelperLlmLlama3_2_1bFull.compute('task-c', 'assignment-c', { isContinuation: true }, undefined, client, 'llama-3.2-1b-instruct'),
		/not holding one for that task/,
	);
});

Test('aborts the request to the local server when an open answer is released', async () => {
	const { client, state } = fakeChatClient(['piece-one', 'piece-two']);
	await StageHelperLlmLlama3_2_1bFull.compute('task-d', 'assignment-d', { text: 'hello' }, { isStreaming: true }, client, 'llama-3.2-1b-instruct');
	Assert.equal(state.abortedCount, 0);
	StageHelperLlmLlama3_2_1bFull.clearGeneration('task-d', 'assignment-d');
	Assert.equal(state.abortedCount, 1);
});

Test('reads an answer for the Qwen3.5-0.8B stage as well, and holds it apart from the Llama 3.2 1B Instruct stage\'s own', async () => {
	const { client: qwenClient } = fakeChatClient(['Paris', ' it is.']);
	const qwenResult = await StageHelperLlmQwen3_5_0_8bFull.compute(
		'task-two-stages', 'assignment-qwen', { text: 'What is the capital of France?' }, { isStreaming: true }, qwenClient, 'qwen_qwen3.5-0.8b',
	);
	Assert.deepEqual(qwenResult, { newText: 'Paris', isContinuation: true, done: false });

	// The two stage helpers keep their own answers, so one task identifier can be held open by both
	// at once and neither run can carry on or release the other's answer.
	const { client: llamaClient } = fakeChatClient(['Rome', ' it is.']);
	const llamaResult = await StageHelperLlmLlama3_2_1bFull.compute(
		'task-two-stages', 'assignment-llama', { text: 'What is the capital of Italy?' }, { isStreaming: true }, llamaClient, 'llama-3.2-1b-instruct',
	);
	Assert.deepEqual(llamaResult, { newText: 'Rome', isContinuation: true, done: false });

	const qwenSecond = await StageHelperLlmQwen3_5_0_8bFull.compute(
		'task-two-stages', 'assignment-qwen', { isContinuation: true }, { isStreaming: true }, qwenClient, 'qwen_qwen3.5-0.8b',
	);
	Assert.deepEqual(qwenSecond, { newText: ' it is.', isContinuation: true, done: false });

	StageHelperLlmQwen3_5_0_8bFull.clearGeneration('task-two-stages', 'assignment-qwen');
	StageHelperLlmLlama3_2_1bFull.clearGeneration('task-two-stages', 'assignment-llama');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Shape Of The Answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('sends a json_object as the JSON Schema of any object, which is the one spelling both local servers accept', async () => {
	const body = await requestBodyOf({
		responseFormat: {
			type: 'json_object',
		},
	});
	// LM Studio 0.4.20 answers OpenAI's own `{"type":"json_object"}` with HTTP 400 and
	// `'response_format.type' must be 'json_schema' or 'text'`, while Ollama accepts it. The JSON
	// Schema below says what a `json_object` says — every object satisfies it and nothing else does —
	// and both servers accept it, so it is what this worker sends for both shapes.
	Assert.deepEqual(body.response_format, {
		type: 'json_schema',
		json_schema: {
			name: 'webai_at_home_response_format',
			schema: {
				type: 'object',
			},
		},
	});
});

Test('sends the schema the consumer asked for exactly as it arrived, keyword for keyword', async () => {
	const jsonSchema = {
		type: 'object',
		properties: {
			city: {
				type: 'string',
				minLength: 1,
				maxLength: 40,
			},
			celsius: {
				type: 'integer',
			},
		},
		required: ['city'],
		additionalProperties: false,
	};
	const body = await requestBodyOf({
		responseFormat: {
			type: 'json_schema',
			jsonSchema: jsonSchema,
		},
	});
	const responseFormat = body.response_format as { type: string; json_schema: { name: string; schema: unknown } };
	Assert.equal(responseFormat.type, 'json_schema');
	Assert.equal(responseFormat.json_schema.name, 'webai_at_home_response_format');
	// Nothing about the schema is rewritten on the way through: what the consumer read out of the
	// request is what the local server is asked to enforce.
	Assert.deepEqual(responseFormat.json_schema.schema, jsonSchema);
	// No `strict` beside it. The OpenAI API reads that field as a promise about how the schema is
	// written, which a consumer's own schema does not keep, and both local servers enforce the
	// schema without it.
	Assert.equal('strict' in responseFormat.json_schema, false);
});

Test('sends no response_format field at all when the consumer asked for no shape', async () => {
	const askedForNoShape = await requestBodyOf({
		temperature: 0,
	});
	Assert.equal('response_format' in askedForNoShape, false);
	// Which is the same request this worker sent before it carried a shape at all.
	const askedForNothing = await requestBodyOf(undefined);
	Assert.deepEqual(Object.keys(askedForNothing).sort(), ['messages', 'model', 'stream', 'stream_options']);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tools
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('sends the tools the history declared to the local server, so the model reads them at all', async () => {
	const body = await requestBodyOf(undefined, weatherHistory);
	Assert.deepEqual(body.tools, [
		{
			type: 'function',
			function: {
				name: 'get_weather',
				description: 'Get the weather for a city',
				parameters: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
					},
					required: ['city'],
				},
			},
		},
	]);
	// There is no `tool_choice` beside it: the protocol carries no such value, and
	// `packages/consumer_openai` refuses at submission the one it cannot enforce.
	Assert.equal('tool_choice' in body, false);
});

Test('sends no tools field at all when the history declared none, so a request without tools is the request it always was', async () => {
	const withoutTools = await requestBodyOf(undefined, { messages: [{ role: 'user', content: 'What is the capital of France?' }] });
	Assert.equal('tools' in withoutTools, false);
	const withoutHistory = await requestBodyOf(undefined);
	Assert.equal('tools' in withoutHistory, false);
});

Test('sends an assistant tool call and the tool result answering it, each carrying an identifier this worker minted', async () => {
	const body = await requestBodyOf(undefined, {
		messages: [
			{
				role: 'user',
				content: 'What is the weather in Paris?',
			},
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{
						name: 'get_weather',
						argumentValues: {
							city: 'Paris',
						},
					},
				],
			},
			{
				role: 'tool',
				content: '{"celsius":31}',
			},
		],
		tools: weatherHistory.tools,
	});
	// The local server refuses a message list whose tool call carries no identifier, while the
	// protocol carries none, so the identifier is minted here and the result that answers the call
	// is given the same one. See milestone 0's de-risk gate for
	// https://github.com/webai-at-home/webai-at-home/issues/190.
	Assert.deepEqual(body.messages, [
		{
			role: 'user',
			content: 'What is the weather in Paris?',
		},
		{
			role: 'assistant',
			content: '',
			tool_calls: [
				{
					id: 'call_0',
					type: 'function',
					function: {
						name: 'get_weather',
						arguments: '{"city":"Paris"}',
					},
				},
			],
		},
		{
			role: 'tool',
			content: '{"celsius":31}',
			tool_call_id: 'call_0',
		},
	]);
});

Test('assembles a tool call from the fragments the local server streamed, and reports it as the stage result', async () => {
	const result = await streamedStageResultOf(
		[
			toolCallEvent(0, { name: 'get_weather', arguments: '' }),
			toolCallEvent(0, { arguments: '{"city":' }),
			toolCallEvent(0, { arguments: '"Paris"}' }),
			{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
			{ choices: [], usage: { prompt_tokens: 275, completion_tokens: 100 } },
		],
		{ history: weatherHistory },
	);
	// `finish_reason: tool_calls` is left untranslated, because the protocol has no such stopReason
	// and inventing one is forbidden. `packages/consumer_openai` answers `finish_reason: "tool_calls"`
	// from the presence of the tool calls themselves.
	Assert.deepEqual(result, {
		text: '',
		toolCalls: [
			{
				name: 'get_weather',
				argumentValues: {
					city: 'Paris',
				},
			},
		],
		done: true,
		promptTokenCount: 275,
		completionTokenCount: 100,
	});
});

Test('carries every argument value as the text the model wrote, whatever type the local server wrote it as', async () => {
	const result = await streamedStageResultOf(
		[
			toolCallEvent(0, { name: 'book_room', arguments: '{"city":"Paris","nights":3,"balcony":true,"guests":["ana","bo"]}' }),
		],
		{ history: weatherHistory },
	);
	Assert.deepEqual((result as { toolCalls: unknown }).toolCalls, [
		{
			name: 'book_room',
			argumentValues: {
				city: 'Paris',
				nights: '3',
				balcony: 'true',
				guests: '["ana","bo"]',
			},
		},
	]);
});

Test('keeps the order the model asked for its tool calls in, however the fragments were interleaved', async () => {
	const result = await streamedStageResultOf(
		[
			toolCallEvent(1, { name: 'get_time', arguments: '' }),
			toolCallEvent(0, { name: 'get_weather', arguments: '{"city":"Paris"}' }),
			toolCallEvent(1, { arguments: '{"city":"Rome"}' }),
		],
		{ history: weatherHistory },
	);
	Assert.deepEqual((result as { toolCalls: { name: string }[] }).toolCalls.map((toolCall) => toolCall.name), ['get_weather', 'get_time']);
});

Test('fails the stage when a tool call could not be read, rather than passing on a half-formed call', async () => {
	await Assert.rejects(
		async () => await streamedStageResultOf(
			[
				toolCallEvent(0, { name: 'get_weather', arguments: '{"city":' }),
			],
			{ history: weatherHistory },
		),
		/get_weather/,
	);
});

Test('reads the whole answer in one run when the history declared tools, even when the consumer asked for pieces', async () => {
	const result = await streamedStageResultOf(
		[
			toolCallEvent(0, { name: 'get_weather', arguments: '{"city":"Paris"}' }),
		],
		{ history: weatherHistory },
		{ isStreaming: true },
	);
	// A run that returned a piece would leave the answer open and report `newText`. A history that
	// declared tools is read whole instead, because a model that asks for a tool writes no answer
	// text at all, so there is nothing to report a piece of.
	Assert.deepEqual((result as { done: boolean }).done, true);
	Assert.equal('newText' in result, false);
});

Test('still answers in words, in pieces, when the history declared no tool', async () => {
	const result = await streamedStageResultOf(
		[
			{ choices: [{ delta: { content: 'Paris' } }] },
			{ choices: [{ delta: { content: ' it is.' } }] },
		],
		{ history: { messages: [{ role: 'user', content: 'What is the capital of France?' }] } },
		{ isStreaming: true },
	);
	Assert.deepEqual(result, { newText: 'Paris', isContinuation: true, done: false });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The History With The Gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('authenticates, asks for the pipelines, and registers with the stages it can run', async () => {
	const socket = fakeSocket();
	new GatewayWorkerClient(socket, {
		name: 'test-worker',
		authenticationToken: 'development-token',
		requestedStageNames: [],
		openaiApiClient: fakeOpenaiApiClient(['llama-3.2-1b-instruct']),
		modelId: 'llama-3.2-1b-instruct',
	});
	socket.onopen?.();
	Assert.deepEqual(socket.sent.map((message) => message.type), ['deviceAuthenticate']);
	receive(socket, { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
	Assert.deepEqual(socket.sent.map((message) => message.type), ['deviceAuthenticate', 'pipelines.get']);
	receive(socket, { type: 'pipelines', pipelines: loadedPipelines as never });
	// The model list is read before registering, so the registration is sent on a later turn.
	await new Promise((resolve) => setImmediate(resolve));
	const register = socket.sent.at(-1);
	Assert.equal(register?.type, 'deviceRegister');
	Assert.deepEqual(register?.type === 'deviceRegister' ? register.stageNames : [], ['stage_llm_llama3_2_1b_full', 'stage_llm_qwen3_5_0_8b_full']);
});

Test('registers with no stage, and closes, when the local server does not hold the model', async () => {
	const socket = fakeSocket();
	new GatewayWorkerClient(socket, {
		name: 'test-worker',
		authenticationToken: 'development-token',
		requestedStageNames: [],
		openaiApiClient: fakeOpenaiApiClient([]),
		modelId: 'llama-3.2-1b-instruct',
	});
	socket.onopen?.();
	receive(socket, { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
	receive(socket, { type: 'pipelines', pipelines: loadedPipelines as never });
	await new Promise((resolve) => setImmediate(resolve));
	Assert.equal(socket.sent.some((message) => message.type === 'deviceRegister'), false);
	Assert.equal(socket.closeReason, 'No stage to run');
});

Test('reports nothing for an assignment the gateway cancelled while its run was under way', async () => {
	const socket = fakeSocket();
	const { client, state } = fakeChatClient(['piece-one', 'piece-two']);
	new GatewayWorkerClient(socket, {
		name: 'test-worker',
		authenticationToken: 'development-token',
		requestedStageNames: [],
		openaiApiClient: client,
		modelId: 'llama-3.2-1b-instruct',
	});
	socket.onopen?.();
	receive(socket, {
		type: 'stage.assign',
		taskId: 'task-cancel',
		stageAssignmentId: 'assignment-cancel',
		attempt: 1,
		stage: 'stage_llm_llama3_2_1b_full',
		computation: 'llm_llama3_2_1b_full',
		stageIndex: 0,
		value: { text: 'hello' },
		leaseUntil: new Date(Date.now() + 60_000).toISOString(),
	});
	receive(socket, {
		type: 'stage.cancel',
		taskId: 'task-cancel',
		stageAssignmentId: 'assignment-cancel',
		attempt: 1,
		reason: 'the consumer cancelled the task',
	});
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	// Cancelling releases the answer, which is what stops the run waiting, so the run ends by
	// throwing. That throw belongs to an assignment the gateway has already taken back, so
	// neither a result nor a failure is sent for it.
	const types = socket.sent.map((message) => message.type);
	Assert.equal(types.includes('stage.accepted'), true);
	Assert.equal(types.includes('stage.failed'), false);
	Assert.equal(types.includes('stage.result'), false);
	// The request to the local server is stopped rather than left producing an answer nobody
	// will read.
	Assert.equal(state.abortedCount, 1);
});

Test('accepts an assignment, and reports a computation it cannot run as a stage failure', async () => {
	const socket = fakeSocket();
	new GatewayWorkerClient(socket, {
		name: 'test-worker',
		authenticationToken: 'development-token',
		requestedStageNames: [],
		openaiApiClient: fakeOpenaiApiClient(['llama-3.2-1b-instruct']),
		modelId: 'llama-3.2-1b-instruct',
	});
	socket.onopen?.();
	receive(socket, {
		type: 'stage.assign',
		taskId: 'task-test',
		stageAssignmentId: 'assignment-test',
		attempt: 1,
		stage: 'stage_dev_formula_add',
		computation: 'dev_formula_add',
		stageIndex: 0,
		value: 5,
		leaseUntil: new Date(Date.now() + 60_000).toISOString(),
	});
	await new Promise((resolve) => setImmediate(resolve));
	const types = socket.sent.map((message) => message.type);
	Assert.equal(types.includes('stage.accepted'), true);
	const failed = socket.sent.at(-1);
	Assert.equal(failed?.type, 'stage.failed');
	Assert.match(failed?.type === 'stage.failed' ? failed.error : '', /implements no computation named dev_formula_add/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Connecting To The Central Gateway Again
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds a supervisor whose connections and waits are under the test's control.
 *
 * @param isAutomaticReconnectionEnabled Whether a connection that closes is opened again.
 * @returns The supervisor, the connections it opened in order, and the waits it asked for.
 */
const supervisorUnderTest = (isAutomaticReconnectionEnabled = true): {
	supervisor: GatewayConnectionSupervisor;
	openedSockets: ReturnType<typeof fakeSocket>[];
	requestedDelaysMs: number[];
	makePendingAttempt: () => void;
} => {
	const openedSockets: ReturnType<typeof fakeSocket>[] = [];
	const requestedDelaysMs: number[] = [];
	let pendingAttempt: (() => void) | undefined;
	const supervisor = new GatewayConnectionSupervisor(
		{
			gatewayUrl: 'ws://localhost:8787',
			isAutomaticReconnectionEnabled,
		},
		{
			name: 'test-worker',
			authenticationToken: 'development-token',
			requestedStageNames: [],
			openaiApiClient: fakeOpenaiApiClient(['llama-3.2-1b-instruct']),
			modelId: 'llama-3.2-1b-instruct',
		},
		{},
		() => {
			const socket = fakeSocket();
			openedSockets.push(socket);
			return socket;
		},
		(delayMs, makeAttempt) => {
			requestedDelaysMs.push(delayMs);
			pendingAttempt = makeAttempt;
			return (): void => {
				pendingAttempt = undefined;
			};
		},
	);
	return {
		supervisor,
		openedSockets,
		requestedDelaysMs,
		makePendingAttempt: (): void => {
			const attempt = pendingAttempt;
			pendingAttempt = undefined;
			attempt?.();
		},
	};
};

Test('opens a connection again after one closes, waiting longer each time', () => {
	const { supervisor, openedSockets, requestedDelaysMs, makePendingAttempt } = supervisorUnderTest();
	supervisor.start();
	Assert.equal(openedSockets.length, 1);

	// A gateway that has gone away closes the connection without this worker asking for it.
	openedSockets[0].onclose?.();
	Assert.equal(requestedDelaysMs.length, 1);
	makePendingAttempt();
	Assert.equal(openedSockets.length, 2);

	// The second attempt also fails to produce a usable connection, so the wait grows.
	openedSockets[1].onclose?.();
	makePendingAttempt();
	Assert.equal(openedSockets.length, 3);
	Assert.equal(requestedDelaysMs.length, 2);
	Assert.ok(requestedDelaysMs[1] > requestedDelaysMs[0], `${String(requestedDelaysMs[1])} is not longer than ${String(requestedDelaysMs[0])}`);

	supervisor.stop();
});

Test('goes back to the first wait once a connection has registered, and stops for good when told to', () => {
	const { supervisor, openedSockets, requestedDelaysMs, makePendingAttempt } = supervisorUnderTest();
	supervisor.start();

	// Two attempts that produced no usable connection, so the wait has grown.
	openedSockets[0].onclose?.();
	makePendingAttempt();
	openedSockets[1].onclose?.();
	makePendingAttempt();
	Assert.equal(openedSockets.length, 3);
	const grownDelayMs = requestedDelaysMs[1];

	// The third connection registers, which is the first moment it is known to be usable.
	openedSockets[2].onopen?.();
	receive(openedSockets[2], { type: 'deviceAuthenticated', authIdentity: 'authIdentity-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
	receive(openedSockets[2], { type: 'pipelines', pipelines: loadedPipelines as never });
	return new Promise<void>((resolve) => {
		setImmediate(() => {
			receive(openedSockets[2], { type: 'deviceRegistered', deviceId: 'device-test' });
			openedSockets[2].onclose?.();
			// Back to the first wait, rather than to the wait the earlier outage had grown to.
			Assert.equal(requestedDelaysMs.length, 3);
			Assert.ok(requestedDelaysMs[2] < grownDelayMs, `${String(requestedDelaysMs[2])} is not shorter than ${String(grownDelayMs)}`);

			// Stopping closes what is held and opens nothing further, however many closes arrive.
			supervisor.stop();
			makePendingAttempt();
			Assert.equal(openedSockets.length, 3);
			resolve();
		});
	});
});

Test('opens no connection again when automatic reconnection is turned off', () => {
	const { supervisor, openedSockets, requestedDelaysMs } = supervisorUnderTest(false);
	supervisor.start();
	Assert.equal(openedSockets.length, 1);
	openedSockets[0].onclose?.();
	Assert.deepEqual(requestedDelaysMs, []);
	Assert.equal(openedSockets.length, 1);
	supervisor.stop();
});
