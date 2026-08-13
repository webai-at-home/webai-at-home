import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';
import { protocolVersion, type ClientMessage, type GatewayMessage, type GenerationSettings } from '@webai/protocol';
import { GatewayWorkerClient, type WorkerSocket } from '../src/libs/gateway_worker_client.js';
import { GatewayConnectionSupervisor } from '../src/libs/gateway_connection_supervisor.js';
import { WorkerStageOffer } from '../src/libs/worker_stage_offer.js';
import { StageHelperLlmLlama3_2_1bFull } from '../src/stages/stage_helper_llm_llama3_2_1b_full.js';
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
 * @returns The parsed request body the local server received.
 */
const requestBodyOf = async (generationSettings: GenerationSettings | undefined): Promise<Record<string, unknown>> => {
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
		const { stream } = await client.chatCompletionStream('llama-3.2-1b-instruct', 'hello', new AbortController(), generationSettings);
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
	Assert.deepEqual(offered.stageNames, ['stage_llm_llama3_2_1b_full']);
	Assert.deepEqual(offered.localModelStageNames, ['stage_llm_llama3_2_1b_full']);
	// A stage name this worker has never heard of is offered all the same, as long as it names a
	// computation this worker implements, which is what lets a pipeline be added without
	// releasing the worker.
	const laterPipeline = [{ stages: [{ name: 'stage_llm_llama3_2_1b_full_again', computation: 'llm_llama3_2_1b_full' }] }];
	Assert.deepEqual(WorkerStageOffer.offeredStages(laterPipeline, []).stageNames, ['stage_llm_llama3_2_1b_full_again']);
});

Test('restricts the offer to the stages the command line named', () => {
	Assert.deepEqual(WorkerStageOffer.offeredStages(loadedPipelines, ['stage_llm_llama3_2_1b_full']).stageNames, ['stage_llm_llama3_2_1b_full']);
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
	});
	Assert.equal(body.temperature, 0);
	Assert.equal(body.top_p, 0.9);
	Assert.equal(body.max_tokens, 20);
	Assert.deepEqual(body.stop, ['\nUser:']);
	Assert.equal(body.seed, 42);
	// `isStreaming` is not a generation control the local server is told about: it decides how
	// many stage runs read the answer, and this client always reads the answer as a stream.
	Assert.equal(body.stream, true);
});

Test('sends no generation control field at all when the consumer asked for none, so the local server applies its own defaults', async () => {
	const askedForNothing = await requestBodyOf(undefined);
	Assert.deepEqual(Object.keys(askedForNothing).sort(), ['messages', 'model', 'stream', 'stream_options']);
	// A control left out of the settings block is left out of the body, rather than sent as
	// `null`, one control at a time as well as all five at once.
	const askedForOne = await requestBodyOf({ temperature: 0 });
	Assert.equal(askedForOne.temperature, 0);
	Assert.equal('top_p' in askedForOne, false);
	Assert.equal('max_tokens' in askedForOne, false);
	Assert.equal('stop' in askedForOne, false);
	Assert.equal('seed' in askedForOne, false);
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
	Assert.deepEqual(register?.type === 'deviceRegister' ? register.stageNames : [], ['stage_llm_llama3_2_1b_full']);
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
	receive(openedSockets[2], { type: 'deviceAuthenticated', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
	receive(openedSockets[2], { type: 'pipelines', pipelines: loadedPipelines });
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
