// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { CompletionSender } from '../src/clients/completion_sender.js';
import type { CompletionTarget } from '../src/completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The clients: what CompletionSender reads off a real connection
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Starts a local HTTP server on a free port, so a test can measure a real streamed connection
 * rather than a stand-in for one.
 *
 * @param handler What the server answers with.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startTestServer(handler: Http.RequestListener): Promise<{ baseUrl: string; stop: () => Promise<void>; }> {
	const server = Http.createServer(handler);
	// Bound to 127.0.0.1 rather than to every interface, because 127.0.0.1 is the address the
	// client below is given. `listen(0)` with no host binds `::`, which macOS lets sit beside an
	// unrelated process already holding `127.0.0.1` on the same port — and the client then reaches
	// that process instead of this server. Measured: a run answered `400 WebSockets request was
	// expected` and another `404 <!DOCTYPE html>`, neither of which this handler can write. Naming
	// the address makes the port exclusive, because the kernel refuses a second bind on it. See
	// [issue #227](https://github.com/webai-at-home/webai-at-home/issues/227).
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The test server did not report a port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}



//	CompletionSender
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads Time to First and Time to Last Character from a real server-sent event stream, spaced out over real wall-clock time', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
		});
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
		setTimeout(() => {
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
			setTimeout(() => {
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ', world' } }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
				response.write('data: [DONE]\n\n');
				response.end();
			}, 60);
		}, 40);
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const pieces: string[] = [];
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			streamSetting: 'on',
			writePiece: (piece) => pieces.push(piece),
		});
		Assert.equal(result.answer, 'Hello, world');
		Assert.deepEqual(pieces, ['Hello', ', world']);
		// The two content chunks are spaced 40 ms and then 60 ms apart, so the Time to First
		// Character must land after roughly the first wait and the Time to Last Character after
		// roughly both — proof this measures real elapsed wall-clock time from a real streamed
		// connection, not just the shape of the numbers.
		Assert.ok(result.timeToFirstCharacterMs >= 30, `expected the Time to First Character to reflect the 40 ms wait, got ${result.timeToFirstCharacterMs} ms`);
		Assert.ok(
			result.timeToLastCharacterMs >= result.timeToFirstCharacterMs + 50,
			`expected the Time to Last Character to be at least ~60 ms after the Time to First Character, got Time to First Character ${result.timeToFirstCharacterMs} ms and Time to Last Character ${result.timeToLastCharacterMs} ms`,
		);
	} finally {
		await server.stop();
	}
});

Test('reads the cluster generation-time header a streamed answer names, and leaves the whole-answer one unset', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'X-Webai-Time-To-First-Piece-Ms': '42',
		});
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
		response.write('data: [DONE]\n\n');
		response.end();
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'on',
		});
		Assert.equal(result.clusterTimeToFirstPieceMs, 42);
		Assert.equal(result.clusterGenerationTimeMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('reads the cluster generation-time header a whole answer names, and leaves the streamed one unset', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'X-Webai-Generation-Time-Ms': '99',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'off',
		});
		Assert.equal(result.clusterGenerationTimeMs, 99);
		Assert.equal(result.clusterTimeToFirstPieceMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('reports no cluster generation time at all against an endpoint that sends neither header', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'off',
		});
		Assert.equal(result.clusterGenerationTimeMs, undefined);
		Assert.equal(result.clusterTimeToFirstPieceMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('falls back to one whole request when the endpoint ignores the streaming request and answers with one JSON body', async () => {
	// The `openai` npm package reads such a body as a stream carrying no pieces at all, so
	// without the fallback this endpoint would look like one that answered with nothing.
	const requestedStreams: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreams.push(JSON.parse(body).stream);
			response.writeHead(200, {
				'Content-Type': 'application/json',
			});
			response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer, no streaming' } }] }));
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			streamSetting: 'on',
		});
		Assert.equal(result.answer, 'whole answer, no streaming');
		Assert.equal(result.timeToFirstCharacterMs, result.timeToLastCharacterMs);
		Assert.deepEqual(requestedStreams, [true, undefined]);
	} finally {
		await server.stop();
	}
});

Test('reports an endpoint that answered with no text at all as a failure', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		await Assert.rejects(
			async () => CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				streamSetting: 'off',
			}),
			/no answer text/,
		);
	} finally {
		await server.stop();
	}
});

Test('reads usage and finish_reason straight from the nostream response body', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({
			choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
		}));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'off',
		});
		Assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('leaves usage undefined when the nostream response body carries none', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'off',
		});
		Assert.equal(result.usage, undefined);
	} finally {
		await server.stop();
	}
});

Test('asks for and reads usage from the final, choice-less streamed chunk only when includeUsage is set', async () => {
	const requestedStreamOptions: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreamOptions.push(JSON.parse(body).stream_options);
			response.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
			});
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }], usage: null })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'on',
			includeUsage: true,
		});
		Assert.deepEqual(requestedStreamOptions, [{ include_usage: true }]);
		Assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 1, totalTokens: 5 });
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('sends reasoning_effort none only when the caller turned thinking off, and no such field at all otherwise', async () => {
	const requestedEfforts: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			const requested = JSON.parse(body);
			requestedEfforts.push(requested.reasoning_effort);
			// The whole-answer path is checked here too, so the server answers each request in the
			// shape it asked for rather than streaming to a caller that asked for one piece.
			if (requested.stream !== true) {
				response.writeHead(200, {
					'Content-Type': 'application/json',
				});
				response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
				return;
			}
			response.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
			});
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const messages = [{ role: 'user' as const, content: 'say hi' }];
		await CompletionSender.send({ client, modelId: 'a-model', messages, streamSetting: 'on', thinkingSetting: 'off' });
		await CompletionSender.send({ client, modelId: 'a-model', messages, streamSetting: 'on', thinkingSetting: 'on' });
		// A caller that names no setting sends the exact request `conformance` and `chat` always sent.
		await CompletionSender.send({ client, modelId: 'a-model', messages, streamSetting: 'on' });
		await CompletionSender.send({ client, modelId: 'a-model', messages, streamSetting: 'off', thinkingSetting: 'off' });

		Assert.deepEqual(requestedEfforts, ['none', undefined, undefined, 'none']);
	} finally {
		await server.stop();
	}
});

Test('sends no stream_options at all when includeUsage is left out, exactly as completion/history/benchmark already do', async () => {
	const requestedStreamOptions: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreamOptions.push(JSON.parse(body).stream_options);
			response.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
			});
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			streamSetting: 'on',
		});
		Assert.deepEqual(requestedStreamOptions, [undefined]);
		Assert.equal(result.usage, undefined);
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('reports a refusal from the endpoint in words rather than as a stack trace', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(503, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ error: { message: 'no worker is offering this work', code: 'no_worker' } }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		try {
			await CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				streamSetting: 'off',
			});
			Assert.fail('the request should have been refused');
		} catch (error: unknown) {
			const message = CompletionSender.describeFailure(error);
			Assert.match(message, /^HTTP 503 \(no_worker\)/);
			Assert.match(message, /no worker is offering this work/);
		}
	} finally {
		await server.stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The reported model identifier check, and one whole streamed answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Starts a local HTTP server that answers one streamed chat completion, naming whichever model
 * identifier the caller asks it to name.
 *
 * This is how the substitution LM Studio 0.4.20 performs is reproduced without LM Studio: a server
 * that answers HTTP 200 to a request naming one model, with a body naming another. See
 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
 *
 * @param reportedModelId The model identifier the answer names, whatever the request asked for.
 * @param answer The assistant answer text the server streams, one chunk per character.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startStreamingServer(reportedModelId: string, answer: string): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
	const server = Http.createServer((request, response) => {
		response.writeHead(200, {
			'content-type': 'text/event-stream',
		});
		for (const piece of answer) {
			const chunk = {
				id: 'chatcmpl-test',
				object: 'chat.completion.chunk',
				created: 1,
				model: reportedModelId,
				choices: [
					{
						index: 0,
						delta: {
							content: piece,
						},
						finish_reason: null,
					},
				],
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		response.write('data: [DONE]\n\n');
		response.end();
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the test server did not report a port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		stop: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

/**
 * Builds an endpoint pointed at a local test server.
 *
 * @param baseUrl The base URL the test server is listening on.
 * @returns The endpoint to hand to `CompletionSender.createClient`.
 */
function targetOf(baseUrl: string): CompletionTarget {
	return {
		baseUrl,
		apiKey: 'no-key-required',
		timeoutMs: 5_000,
	};
}

///////////////////////////////////////////////////////////////////////////////

//	The Reported Model Identifier Check
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('CompletionSender.isReportedModelIdAcceptable accepts an endpoint that names exactly the requested model identifier', () => {
	Assert.equal(CompletionSender.isReportedModelIdAcceptable('llama-3.2-1b-instruct', 'llama-3.2-1b-instruct'), true);
});

Test('CompletionSender.isReportedModelIdAcceptable accepts an endpoint that resolved an alias to a longer, dated identifier', () => {
	Assert.equal(CompletionSender.isReportedModelIdAcceptable('gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'), true);
});

Test('CompletionSender.isReportedModelIdAcceptable accepts an endpoint that named no model at all', () => {
	Assert.equal(CompletionSender.isReportedModelIdAcceptable('llama-3.2-1b-instruct', undefined), true);
});

Test('CompletionSender.isReportedModelIdAcceptable refuses an endpoint that answered as a different model', () => {
	Assert.equal(CompletionSender.isReportedModelIdAcceptable('text-embedding-nomic-embed-text-v1.5', 'llama-3.2-1b-instruct'), false);
});

Test('CompletionSender.isReportedModelIdAcceptable refuses an endpoint that answered as a shorter identifier than the one requested', () => {
	Assert.equal(CompletionSender.isReportedModelIdAcceptable('gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'), false);
});

Test('CompletionSender.assertReportedModelId names both model identifiers when it refuses one', () => {
	Assert.throws(
		() => CompletionSender.assertReportedModelId('this-model-does-not-exist-at-all', 'qwen_qwen3-0.6b'),
		/this-model-does-not-exist-at-all[\s\S]*qwen_qwen3-0\.6b|qwen_qwen3-0\.6b[\s\S]*this-model-does-not-exist-at-all/,
	);
});

///////////////////////////////////////////////////////////////////////////////

//	Sending One Turn
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('CompletionSender.send, streamed, against a local server streams every piece and reports the model the endpoint named', async () => {
	const server = await startStreamingServer('a-model', 'Paris');
	try {
		const pieces: string[] = [];
		const result = await CompletionSender.send({
			client: CompletionSender.createClient(targetOf(server.baseUrl)),
			modelId: 'a-model',
			messages: [
				{
					role: 'user',
					content: 'What is the capital of France?',
				},
			],
			streamSetting: 'on',
			writePiece: (piece: string) => pieces.push(piece),
		});
		Assert.equal(result.answer, 'Paris');
		Assert.deepEqual(pieces, ['P', 'a', 'r', 'i', 's']);
		Assert.equal(result.reportedModelId, 'a-model');
		Assert.ok(result.timeToFirstCharacterMs <= result.timeToLastCharacterMs);
	} finally {
		await server.stop();
	}
});

Test('CompletionSender.send, streamed, against a local server fails the request when the endpoint answered as a model nobody asked for', async () => {
	const server = await startStreamingServer('a-substitute-model', 'Paris');
	try {
		await Assert.rejects(
			async () =>
				await CompletionSender.send({
					client: CompletionSender.createClient(targetOf(server.baseUrl)),
					modelId: 'the-model-that-was-asked-for',
					messages: [
						{
							role: 'user',
							content: 'What is the capital of France?',
						},
					],
					streamSetting: 'on',
				}),
			/a-substitute-model/,
		);
	} finally {
		await server.stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
