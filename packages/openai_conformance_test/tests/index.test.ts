// node imports
import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Http from 'node:http';
import Path from 'node:path';
import Test from 'node:test';

// local imports
import { OpenaiPackageClient } from '../src/clients/openai_package_client.js';
import { RawHttpClient } from '../src/clients/raw_http_client.js';
import { GenerationControlProbeCache } from '../src/probes/generation_control_probe_cache.js';
import { GenerationControlVerdict } from '../src/probes/generation_control_verdict.js';
import { JsonContentExtractor } from '../src/readers/json_content_extractor.js';
import { agentProfile } from '../src/profiles/agent.js';
import { coreProfile } from '../src/profiles/core.js';
import { fullProfile } from '../src/profiles/full.js';
import { parametersProfile } from '../src/profiles/parameters.js';
import { sdkProfile } from '../src/profiles/sdk.js';
import { structuredOutputProfile } from '../src/profiles/structured_output.js';
import { streamingProfile } from '../src/profiles/streaming.js';
import { toolsProfile } from '../src/profiles/tools.js';
import { JsonReporter } from '../src/reporter/json.js';
import { JunitReporter } from '../src/reporter/junit.js';
import { MarkdownReporter } from '../src/reporter/markdown.js';
import { ReportSummary } from '../src/reporter/report_summary.js';
import { TerminalReporter } from '../src/reporter/terminal.js';
import { Runner, type TestRunRecord } from '../src/runner.js';
import { SseEventReader } from '../src/readers/sse_event_reader.js';
import { ToolCallProbeCache } from '../src/probes/tool_call_probe_cache.js';
import { chatBasicTest } from '../src/tests/chat/basic.js';
import { errorsUnknownModelTest } from '../src/tests/errors/unknown_model.js';
import { streamingDoneTest } from '../src/tests/streaming/done.js';
import { streamingHeadersTest } from '../src/tests/streaming/headers.js';
import { streamingTimingTest } from '../src/tests/streaming/timing.js';
import { structuredOutputJsonObjectTest } from '../src/tests/structured_output/json_object.js';
import { structuredOutputJsonSchemaTest } from '../src/tests/structured_output/json_schema.js';
import { sdkToolsTest } from '../src/tests/sdk/tools.js';
import { usageTotalIsSumTest } from '../src/tests/usage/total_is_sum.js';
import { ToolCallVerdict } from '../src/probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, Verdict } from '../src/types.js';

const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TestFixtures — a local HTTP server standing in for an OpenAI-compatible endpoint, so this
//	file runs without a cluster, LM Studio, or any other real server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds test fixtures: a local mock server, and the `TestContext` pointed at it. */
class TestFixtures {
	/** The model identifier every fixture server is asked about. */
	static readonly modelId = 'mock-model';

	/**
	 * Starts a local HTTP server on a free port.
	 *
	 * @param handler What the server answers with.
	 * @returns The context to run a test with, and how to stop the server again.
	 */
	static async startServer(handler: Http.RequestListener): Promise<{ context: TestContext; stop: () => Promise<void> }> {
		const server = Http.createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, () => resolve()));
		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('The test server did not report a port');
		}
		const target = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', timeoutMs: 2_000 };
		const openaiPackageClient = new OpenaiPackageClient(target);
		const context: TestContext = {
			rawHttpClient: new RawHttpClient(target),
			openaiPackageClient,
			modelId: TestFixtures.modelId,
			toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, TestFixtures.modelId, 1),
			generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, TestFixtures.modelId, 1),
		};
		return {
			context,
			stop: async () => {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	/**
	 * A minimal, fully correct OpenAI-compatible server: lists exactly the requested model, answers
	 * every well-formed chat completion request with a fixed reply and a consistent `usage`, and
	 * refuses an unrecognised model, a missing `messages` field, and malformed JSON, each with an
	 * OpenAI-shaped error body.
	 *
	 * @returns The request handler.
	 */
	static wellBehaved(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then((rawBody) => {
				if (request.url === '/v1/models' && request.method === 'GET') {
					TestFixtures._sendJson(response, 200, { object: 'list', data: [{ id: TestFixtures.modelId, object: 'model' }] });
					return;
				}
				if (request.url === '/v1/chat/completions' && request.method === 'POST') {
					TestFixtures._answerChatCompletion(response, rawBody);
					return;
				}
				TestFixtures._sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error', param: null, code: null } });
			});
		};
	}

	/**
	 * A server that always answers a chat completion request, even for a model it was never told
	 * about — the behaviour milestone zero of issue #182 found LM Studio's own server to have.
	 *
	 * @returns The request handler.
	 */
	static ignoresUnknownModel(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				if (request.url === '/v1/chat/completions' && request.method === 'POST') {
					TestFixtures._sendChatCompletion(response, { promptTokens: 5, completionTokens: 1 });
					return;
				}
				TestFixtures._sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error', param: null, code: null } });
			});
		};
	}

	/**
	 * A server whose `usage.total_tokens` never equals `prompt_tokens + completion_tokens`.
	 *
	 * @returns The request handler.
	 */
	static inconsistentUsage(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				if (request.url === '/v1/chat/completions' && request.method === 'POST') {
					TestFixtures._sendJson(response, 200, {
						id: 'chatcmpl-mock',
						object: 'chat.completion',
						created: 0,
						model: TestFixtures.modelId,
						choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
						usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 999 },
					});
					return;
				}
				TestFixtures._sendJson(response, 404, { error: { message: 'not found', type: 'invalid_request_error', param: null, code: null } });
			});
		};
	}

	/**
	 * A server that streams a chat completion correctly: `Content-Type: text/event-stream`, one
	 * `data:` event per content piece, spaced far enough apart in time to be genuinely streamed, a
	 * final chunk carrying `finish_reason`, and the `data: [DONE]` sentinel.
	 *
	 * @returns The request handler.
	 */
	static streamingWellBehaved(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(async () => {
				TestFixtures._openEventStream(response);
				for (const piece of ['One', ', two', ', three']) {
					TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
					await new Promise((resolve) => setTimeout(resolve, 15));
				}
				TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
				response.write('data: [DONE]\n\n');
				response.end();
			});
		};
	}

	/**
	 * A server that writes every chunk in one go before ending the response — the fake streaming
	 * section 12 of issue #181 asks this package to detect.
	 *
	 * @returns The request handler.
	 */
	static streamingBuffered(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				TestFixtures._openEventStream(response);
				for (const piece of ['One', ', two', ', three']) {
					TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
				}
				TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
				response.write('data: [DONE]\n\n');
				response.end();
			});
		};
	}

	/**
	 * A server that streams correctly but never sends the `data: [DONE]` sentinel.
	 *
	 * @returns The request handler.
	 */
	static streamingWithoutDone(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				TestFixtures._openEventStream(response);
				TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: { content: 'One' }, finish_reason: null }] });
				TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
				response.end();
			});
		};
	}

	/**
	 * A server that answers a streamed request with one whole JSON body, as though `stream: true`
	 * had never been sent.
	 *
	 * @returns The request handler.
	 */
	static streamingIgnored(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				TestFixtures._sendChatCompletion(response, { promptTokens: 5, completionTokens: 1 });
			});
		};
	}

	/**
	 * A server that refuses any request carrying tool declarations, naming `tools` as the field at
	 * fault — the way this project's own `consumer_openai` answers for a model that cannot read
	 * them, with the code `unsupported_tool_declarations`, as milestone zero of issue #182 found.
	 *
	 * @returns The request handler.
	 */
	static refusesToolDeclarations(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then((rawBody) => {
				if (rawBody.includes('"tools"') === true || rawBody.includes('"tool_choice"') === true) {
					TestFixtures._sendJson(response, 400, {
						error: {
							message: `The model ${TestFixtures.modelId} cannot read tool declarations.`,
							type: 'invalid_request_error',
							param: 'tools',
							code: 'unsupported_tool_declarations',
						},
					});
					return;
				}
				TestFixtures._sendChatCompletion(response, { promptTokens: 5, completionTokens: 1 });
			});
		};
	}

	/**
	 * A fully correct server that also streams correctly, so the `sdk` profile — which asks for
	 * both in one run — has one endpoint that answers every one of its four requests.
	 *
	 * @returns The request handler.
	 */
	static wellBehavedAndStreaming(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(async (rawBody) => {
				if (request.url === '/v1/models' && request.method === 'GET') {
					TestFixtures._sendJson(response, 200, { object: 'list', data: [{ id: TestFixtures.modelId, object: 'model' }] });
					return;
				}
				// The body is parsed rather than searched for `"stream":true`, because the official
				// `openai` Node.js package pretty-prints its request body: it sends `"stream": true`,
				// with a space, which no substring check written against `JSON.stringify` output finds.
				if (TestFixtures._isStreamingRequest(rawBody) === true) {
					TestFixtures._openEventStream(response);
					for (const piece of ['One', ', two']) {
						TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
						await new Promise((resolve) => setTimeout(resolve, 5));
					}
					TestFixtures._writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
					response.write('data: [DONE]\n\n');
					response.end();
					return;
				}
				TestFixtures._answerChatCompletion(response, rawBody);
			});
		};
	}

	/**
	 * A server whose answer is valid JSON wrapped in a markdown code fence — what
	 * `llm_llama3_2_1b_full` did in nine of ten tries in milestone zero of issue #182.
	 *
	 * @returns The request handler.
	 */
	static answersWithFencedJson(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				TestFixtures._sendJson(response, 200, {
					id: 'chatcmpl-mock',
					object: 'chat.completion',
					created: 0,
					model: TestFixtures.modelId,
					choices: [{ index: 0, message: { role: 'assistant', content: '```json\n{"greeting": "hello"}\n```' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
				});
			});
		};
	}

	/**
	 * A server that refuses `response_format: { type: "json_object" }` with `error` as a bare
	 * string rather than an OpenAI-shaped object — exactly what LM Studio answers, so the refusal
	 * has no `code` field to key on.
	 *
	 * @returns The request handler.
	 */
	static refusesJsonObjectWithBareStringError(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then(() => {
				TestFixtures._sendJson(response, 400, { error: "'response_format.type' must be 'json_schema' or 'text'" });
			});
		};
	}

	/**
	 * A server that refuses `response_format: { type: "json_schema" }`.
	 *
	 * @returns The request handler.
	 */
	static refusesJsonSchema(): Http.RequestListener {
		return (request, response) => {
			void TestFixtures._readBody(request).then((rawBody) => {
				if (rawBody.includes('json_schema') === true) {
					TestFixtures._sendJson(response, 400, { error: { message: "'response_format.type' must be 'text'", type: 'invalid_request_error', param: 'response_format', code: null } });
					return;
				}
				TestFixtures._sendChatCompletion(response, { promptTokens: 5, completionTokens: 1 });
			});
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reports whether a request body asked for a streamed answer.
	 *
	 * @param rawBody The raw request body received.
	 * @returns `true` when the body parses as JSON carrying `stream: true`.
	 */
	private static _isStreamingRequest(rawBody: string): boolean {
		try {
			return (JSON.parse(rawBody) as Record<string, unknown>)['stream'] === true;
		} catch {
			return false;
		}
	}

	/**
	 * Writes the response head of a server-sent event stream.
	 *
	 * @param response The response to write to.
	 * @returns Nothing.
	 */
	private static _openEventStream(response: Http.ServerResponse): void {
		response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
	}

	/**
	 * Writes one `data:` event, followed by the blank line that ends it.
	 *
	 * @param response The response to write to.
	 * @param chunk The value to serialize as this event's `data:` payload.
	 * @returns Nothing.
	 */
	private static _writeEvent(response: Http.ServerResponse, chunk: unknown): void {
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	}

	/**
	 * Answers a `POST /chat/completions` request the way a fully correct endpoint would: refuse an
	 * unrecognised model, a missing `messages` field, or a body that is not valid JSON; otherwise
	 * answer with a fixed reply and consistent usage.
	 *
	 * @param response The response to write to.
	 * @param rawBody The raw request body received.
	 * @returns Nothing.
	 */
	private static _answerChatCompletion(response: Http.ServerResponse, rawBody: string): void {
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(rawBody);
		} catch {
			TestFixtures._sendJson(response, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error', param: null, code: null } });
			return;
		}
		const body = parsedBody as Record<string, unknown>;
		if (body['messages'] === undefined) {
			TestFixtures._sendJson(response, 400, { error: { message: 'messages is required', type: 'invalid_request_error', param: 'messages', code: null } });
			return;
		}
		if (body['model'] !== TestFixtures.modelId) {
			TestFixtures._sendJson(response, 404, { error: { message: `unknown model "${String(body['model'])}"`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } });
			return;
		}
		TestFixtures._sendChatCompletion(response, { promptTokens: 5, completionTokens: 1 });
	}

	/**
	 * Writes a well-formed chat completion response.
	 *
	 * @param response The response to write to.
	 * @param usage The token counts to report; `total_tokens` is their sum.
	 * @returns Nothing.
	 */
	private static _sendChatCompletion(response: Http.ServerResponse, usage: { promptTokens: number; completionTokens: number }): void {
		TestFixtures._sendJson(response, 200, {
			id: 'chatcmpl-mock',
			object: 'chat.completion',
			created: 0,
			model: TestFixtures.modelId,
			choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens },
		});
	}

	/**
	 * Reads a request body to completion.
	 *
	 * @param request The request to read.
	 * @returns The raw body text.
	 */
	private static _readBody(request: Http.IncomingMessage): Promise<string> {
		return new Promise((resolve) => {
			let rawBody = '';
			request.on('data', (chunk: Buffer) => {
				rawBody += chunk.toString('utf8');
			});
			request.on('end', () => resolve(rawBody));
		});
	}

	/**
	 * Writes one JSON response.
	 *
	 * @param response The response to write to.
	 * @param status The HTTP status to answer with.
	 * @param body The value to serialize as the response body.
	 * @returns Nothing.
	 */
	private static _sendJson(response: Http.ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify(body));
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	coreProfile, against a well-behaved endpoint
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('every core profile test passes against a fully correct OpenAI-compatible server', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.wellBehaved());
	try {
		const records = await Runner.run(coreProfile, context);
		const failing = records.filter((record) => record.result.verdict !== 'PASS');
		Assert.deepEqual(
			failing.map((record) => `${record.test.id}: ${record.result.verdict} — ${record.result.detail}`),
			[],
		);
		Assert.equal(records.length, coreProfile.length);
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Individual tests, against a server built to trip one of them
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('errors.unknown_model fails when an unrecognised model is answered instead of refused', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.ignoresUnknownModel());
	try {
		const result = await errorsUnknownModelTest.run(context);
		Assert.equal(result.verdict, 'FAIL');
		Assert.match(result.detail, /expected an error status/);
	} finally {
		await stop();
	}
});

void Test('usage.total_is_sum fails when total_tokens does not equal prompt_tokens + completion_tokens', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.inconsistentUsage());
	try {
		const result = await usageTotalIsSumTest.run(context);
		Assert.equal(result.verdict, 'FAIL');
		Assert.match(result.detail, /999 !== 5 \+ 1/);
	} finally {
		await stop();
	}
});

void Test('chat.basic passes against a server that answers a well-formed reply', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.wellBehaved());
	try {
		const result = await chatBasicTest.run(context);
		Assert.equal(result.verdict, 'PASS');
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SseEventReader
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('SseEventReader reads a data: payload, recognises [DONE], and refuses an event carrying no data: line', () => {
	Assert.equal(SseEventReader.beginsWithData('data: {"a":1}'), true);
	Assert.equal(SseEventReader.beginsWithData('event: ping'), false);
	Assert.equal(SseEventReader.dataPayload('data: {"a":1}'), '{"a":1}');
	Assert.equal(SseEventReader.dataPayload('event: ping'), undefined);
	Assert.equal(SseEventReader.isDoneSentinel('data: [DONE]'), true);
	Assert.equal(SseEventReader.isDoneSentinel('data: {"a":1}'), false);
	Assert.deepEqual(SseEventReader.parseDataJson('data: {"a":1}'), { a: 1 });
	Assert.equal(SseEventReader.parseDataJson('data: [DONE]'), undefined);
	Assert.equal(SseEventReader.parseDataJson('data: not json'), undefined);
});

void Test('SseEventReader finds the data: line among the other fields a server-sent event may carry', () => {
	Assert.deepEqual(SseEventReader.parseDataJson('event: message\nid: 7\ndata: {"a":1}'), { a: 1 });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	streamingProfile
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('every streaming profile test passes against a server that streams correctly', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.streamingWellBehaved());
	try {
		const records = await Runner.run(streamingProfile, context);
		const failing = records.filter((record) => record.result.verdict !== 'PASS');
		Assert.deepEqual(
			failing.map((record) => `${record.test.id}: ${record.result.verdict} — ${record.result.detail}`),
			[],
		);
		Assert.equal(records.length, streamingProfile.length);
	} finally {
		await stop();
	}
});

void Test('streaming.timing warns, rather than failing, when every chunk arrives at once', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.streamingBuffered());
	try {
		const result = await streamingTimingTest.run(context);
		Assert.equal(result.verdict, 'WARN');
		Assert.match(result.detail, /may be buffering the complete response/);
	} finally {
		await stop();
	}
});

void Test('streaming.done fails when the stream never sends the [DONE] sentinel', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.streamingWithoutDone());
	try {
		const result = await streamingDoneTest.run(context);
		Assert.equal(result.verdict, 'FAIL');
		Assert.match(result.detail, /the last event was not "data: \[DONE\]"/);
	} finally {
		await stop();
	}
});

void Test('streaming.headers fails when a streamed request is answered with one whole JSON body', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.streamingIgnored());
	try {
		const result = await streamingHeadersTest.run(context);
		Assert.equal(result.verdict, 'FAIL');
		Assert.match(result.detail, /expected text\/event-stream/);
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallVerdict, and the tools profile
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test("ToolCallVerdict maps ToolCallProber's five statuses onto the four conformance verdicts", () => {
	const outcome = { modelId: 'a-model', mode: 'nostream', ability: 'generates_a_call', observation: 'what was seen', answers: [] } as const;
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'supported' }, 'generates_a_call').verdict, 'PASS');
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'refused' }, 'generates_a_call').verdict, 'SKIP');
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'unsupported' }, 'generates_a_call').verdict, 'WARN');
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'inconclusive' }, 'generates_a_call').verdict, 'WARN');
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'failed' }, 'generates_a_call').verdict, 'FAIL');
	Assert.equal(ToolCallVerdict.fromOutcome({ ...outcome, status: 'supported' }, 'generates_a_call').detail, 'what was seen');
});

void Test('ToolCallVerdict fails, naming the ability, when the probe run produced no outcome for it', () => {
	const result = ToolCallVerdict.fromOutcome(undefined, 'fills_in_the_arguments');
	Assert.equal(result.verdict, 'FAIL');
	Assert.match(result.detail, /no outcome for "fills_in_the_arguments"/);
});

void Test('every tools profile test reports SKIP against a server that refuses tool declarations outright', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.refusesToolDeclarations());
	try {
		const records = await Runner.run(toolsProfile, context);
		const toolDeclaringRecords = records.filter((record) => record.test.id !== 'tools.answers_without_a_call_when_none_is_needed');
		Assert.deepEqual(
			toolDeclaringRecords.filter((record) => record.result.verdict !== 'SKIP').map((record) => `${record.test.id}: ${record.result.verdict} — ${record.result.detail}`),
			[],
		);
		Assert.equal(records.length, toolsProfile.length);
	} finally {
		await stop();
	}
});

void Test('the six tools profile tests share one ToolCallProber run rather than probing six times over', async () => {
	let chatCompletionRequestCount = 0;
	const { context, stop } = await TestFixtures.startServer((request, response) => {
		if (request.url === '/v1/chat/completions') {
			chatCompletionRequestCount += 1;
		}
		TestFixtures.refusesToolDeclarations()(request, response);
	});
	try {
		await Runner.run(toolsProfile, context);
		const oneRunRequestCount = chatCompletionRequestCount;
		Assert.ok(oneRunRequestCount > 0, 'the probe run sent no request at all');

		chatCompletionRequestCount = 0;
		await Runner.run([toolsProfile[0] as ConformanceTest], context);
		Assert.equal(chatCompletionRequestCount, 0, 'a second run re-probed instead of reusing the cached outcomes');
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonContentExtractor, and the structured output group
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('JsonContentExtractor parses bare JSON without reporting a fence', () => {
	const { parsed, wasFenced } = JsonContentExtractor.extract('{"greeting": "hello"}');
	Assert.deepEqual(parsed, { greeting: 'hello' });
	Assert.equal(wasFenced, false);
});

void Test('JsonContentExtractor recovers JSON from the markdown code fence milestone zero found live', () => {
	const triple = JsonContentExtractor.extract('```json\n{"greeting": "hello"}\n```');
	Assert.deepEqual(triple.parsed, { greeting: 'hello' });
	Assert.equal(triple.wasFenced, true);

	const single = JsonContentExtractor.extract('`{"greeting": "hello"}`');
	Assert.deepEqual(single.parsed, { greeting: 'hello' });
	Assert.equal(single.wasFenced, true);

	const untagged = JsonContentExtractor.extract('```\n{"greeting": "hello"}\n```');
	Assert.deepEqual(untagged.parsed, { greeting: 'hello' });
	Assert.equal(untagged.wasFenced, true);
});

void Test('JsonContentExtractor recovers nothing from content that is not JSON at all', () => {
	Assert.equal(JsonContentExtractor.extract('I cannot help with that.').parsed, undefined);
	Assert.equal(JsonContentExtractor.extract('').parsed, undefined);
	Assert.equal(JsonContentExtractor.extract('```json\nnot json\n```').parsed, undefined);
});

void Test('structured_output.json_object warns, rather than failing, when the JSON is wrapped in a code fence', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.answersWithFencedJson());
	try {
		const result = await structuredOutputJsonObjectTest.run(context);
		Assert.equal(result.verdict, 'WARN');
		Assert.match(result.detail, /wrapped in a markdown code fence/);
	} finally {
		await stop();
	}
});

void Test('structured_output.json_object skips, rather than failing, when the endpoint refuses the parameter with a bare-string error body', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.refusesJsonObjectWithBareStringError());
	try {
		const result = await structuredOutputJsonObjectTest.run(context);
		Assert.equal(result.verdict, 'SKIP');
		Assert.match(result.detail, /json_object is not supported/);
	} finally {
		await stop();
	}
});

void Test('structured_output.json_schema skips, rather than failing, when the endpoint refuses the parameter', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.refusesJsonSchema());
	try {
		const result = await structuredOutputJsonSchemaTest.run(context);
		Assert.equal(result.verdict, 'SKIP');
		Assert.match(result.detail, /json_schema is not supported/);
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlVerdict
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test("GenerationControlVerdict reads a control accepted and quietly ignored as FAIL, not WARN", () => {
	const outcome = { modelId: 'a-model', mode: 'nostream', control: 'temperature', observation: 'what was seen', answers: [] } as const;
	Assert.equal(GenerationControlVerdict.fromOutcome({ ...outcome, status: 'honoured' }, 'temperature').verdict, 'PASS');
	Assert.equal(GenerationControlVerdict.fromOutcome({ ...outcome, status: 'refused' }, 'temperature').verdict, 'SKIP');
	Assert.equal(GenerationControlVerdict.fromOutcome({ ...outcome, status: 'not_honoured' }, 'temperature').verdict, 'FAIL');
	Assert.equal(GenerationControlVerdict.fromOutcome({ ...outcome, status: 'inconclusive' }, 'temperature').verdict, 'WARN');
	Assert.equal(GenerationControlVerdict.fromOutcome({ ...outcome, status: 'failed' }, 'temperature').verdict, 'FAIL');
});

void Test('GenerationControlVerdict fails, naming the control, when the probe run produced no outcome for it', () => {
	const result = GenerationControlVerdict.fromOutcome(undefined, 'seed');
	Assert.equal(result.verdict, 'FAIL');
	Assert.match(result.detail, /no outcome for "seed"/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	sdkProfile — the same requests again, through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('every sdk profile test passes against a server the official openai Node.js package can read', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.wellBehavedAndStreaming());
	try {
		const records = await Runner.run(sdkProfile, context);
		const failing = records.filter((record) => record.result.verdict !== 'PASS');
		Assert.deepEqual(
			failing.map((record) => `${record.test.id}: ${record.result.verdict} — ${record.result.detail}`),
			[],
		);
		Assert.equal(records.length, sdkProfile.length);
	} finally {
		await stop();
	}
});

void Test('sdk.node.tools skips, rather than failing, when the endpoint refuses the tool declaration', async () => {
	const { context, stop } = await TestFixtures.startServer(TestFixtures.refusesToolDeclarations());
	try {
		const result = await sdkToolsTest.run(context);
		Assert.equal(result.verdict, 'SKIP');
		Assert.match(result.detail, /refused the tool declaration: HTTP 400/);
	} finally {
		await stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Runner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('Runner turns a request that never reaches a server into a FAIL result, not a thrown error', async () => {
	const target = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', timeoutMs: 500 };
	const openaiPackageClient = new OpenaiPackageClient(target);
	const context: TestContext = {
		rawHttpClient: new RawHttpClient(target),
		openaiPackageClient,
		modelId: TestFixtures.modelId,
		toolCallProbeCache: new ToolCallProbeCache(openaiPackageClient.client, TestFixtures.modelId, 1),
		generationControlProbeCache: new GenerationControlProbeCache(openaiPackageClient.client, TestFixtures.modelId, 1),
	};
	const records = await Runner.run([chatBasicTest], context);
	Assert.equal(records.length, 1);
	Assert.equal(records[0]?.result.verdict, 'FAIL');
	Assert.match(records[0]?.result.detail ?? '', /threw:/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TerminalReporter
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Builds a fake test, so a `TerminalReporter` test can build records without running a real test. */
class ReporterFixtures {
	/**
	 * @param id The test's stable identifier.
	 * @param name The line printed for this test.
	 * @param group Which group this test belongs to.
	 * @returns A `ConformanceTest` whose `run` method is never called.
	 */
	static test(id: string, name: string, group: string): ConformanceTest {
		return {
			id,
			name,
			group,
			run: async () => {
				throw new Error(`${id} should never run inside a TerminalReporter test`);
			},
		};
	}

	/**
	 * Builds one finished run record, naming the test after its own identifier, so a reporter test
	 * reads as a list of verdicts rather than as a wall of object literals.
	 *
	 * @param id The test's stable identifier, used as its printed name as well.
	 * @param group Which group this test belongs to.
	 * @param verdict The verdict this test reached.
	 * @param detail What the verdict says, empty by default.
	 * @returns The run record.
	 */
	static record(id: string, group: string, verdict: Verdict, detail = ''): TestRunRecord {
		return {
			test: ReporterFixtures.test(id, id, group),
			result: {
				verdict,
				detail,
			},
			durationMs: 1,
		};
	}
}

void Test('TerminalReporter groups tests under their headings and excludes SKIP from the compatibility percentage', () => {
	const records: TestRunRecord[] = [
		{ test: ReporterFixtures.test('models.list', 'GET /models lists the requested model', 'models'), result: { verdict: 'PASS', detail: '' }, durationMs: 1 },
		{ test: ReporterFixtures.test('chat.basic', 'basic completion', 'chat'), result: { verdict: 'FAIL', detail: 'broke' }, durationMs: 1 },
		{ test: ReporterFixtures.test('parameters.temperature', 'temperature parameter', 'parameters'), result: { verdict: 'SKIP', detail: 'unsupported' }, durationMs: 1 },
	];

	const report = TerminalReporter.render(records, { endpoint: 'http://example.test/v1', modelId: 'a-model' });

	Assert.match(report, /Models/);
	Assert.match(report, /Chat Completions/);
	Assert.match(report, /GET \/models lists the requested model/);
	Assert.match(report, /Passed: 1/);
	Assert.match(report, /Failed: 1/);
	Assert.match(report, /Skipped: 1/);
	Assert.match(report, /Compatibility: 50\.0%/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The profiles, and the reporters of milestone six
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('the full profile holds every test every other profile can reach, so it cannot fall behind', () => {
	const everyOtherProfile = [coreProfile, streamingProfile, toolsProfile, parametersProfile, structuredOutputProfile, sdkProfile, agentProfile];
	const missing = everyOtherProfile
		.flat()
		.filter((test) => fullProfile.includes(test) === false)
		.map((test) => test.id);
	Assert.deepEqual([...new Set(missing)], []);
});

void Test('every test file in a group folder is listed in that folder\'s group.ts, so a written test cannot go unrun', async () => {
	const testsDirectory = Path.join(__dirname, '..', 'src', 'tests');
	const groupFolderNames = Fs.readdirSync(testsDirectory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	Assert.ok(groupFolderNames.length > 0, 'no group folders found under src/tests');

	const unlisted: string[] = [];
	for (const groupFolderName of groupFolderNames) {
		const groupFolderPath = Path.join(testsDirectory, groupFolderName);
		const groupModule = (await import(Path.join(groupFolderPath, 'group.js'))) as Record<string, unknown>;
		const groupList = Object.values(groupModule).find((value) => Array.isArray(value)) as ConformanceTest[] | undefined;
		Assert.ok(groupList !== undefined, `${groupFolderName}/group.ts exports no array of tests`);

		const testFileNames = Fs.readdirSync(groupFolderPath).filter((fileName) => fileName.endsWith('.ts') && fileName !== 'group.ts');
		for (const testFileName of testFileNames) {
			const testModule = (await import(Path.join(groupFolderPath, testFileName.replace(/\.ts$/, '.js')))) as Record<string, unknown>;
			for (const exported of Object.values(testModule)) {
				const conformanceTest = exported as ConformanceTest;
				if (typeof conformanceTest?.id !== 'string') {
					continue;
				}
				if (groupList.includes(conformanceTest) === false) {
					unlisted.push(`${groupFolderName}/${testFileName} exports ${conformanceTest.id}, absent from ${groupFolderName}/group.ts`);
				}
			}
		}
	}
	Assert.deepEqual(unlisted, []);
});

void Test('every test identifier is unique, and every identifier begins with its own group name', () => {
	const identifiers = fullProfile.map((test) => test.id);
	Assert.equal(new Set(identifiers).size, identifiers.length, `duplicate identifiers in ${identifiers.join(', ')}`);
	const mismatched = fullProfile.filter((test) => test.id.startsWith(`${test.group}.`) === false).map((test) => `${test.id} is in group ${test.group}`);
	Assert.deepEqual(mismatched, []);
});

void Test('the agent profile is a selection from the other profiles, never a test of its own', () => {
	const notFromElsewhere = agentProfile.filter((test) => fullProfile.includes(test) === false).map((test) => test.id);
	Assert.deepEqual(notFromElsewhere, []);
	Assert.ok(agentProfile.length < fullProfile.length, 'the agent profile is meant to be narrower than full');
});

void Test('ReportSummary leaves SKIP out of the compatibility percentage and keeps WARN in it', () => {
	const summary = ReportSummary.of([
		ReporterFixtures.record('models.list', 'models', 'PASS'),
		ReporterFixtures.record('chat.basic', 'chat', 'WARN'),
		ReporterFixtures.record('parameters.temperature', 'parameters', 'SKIP'),
	]);
	Assert.equal(summary.passedCount, 1);
	Assert.equal(summary.warnedCount, 1);
	Assert.equal(summary.skippedCount, 1);
	Assert.equal(summary.compatibilityPercent, 50);
});

void Test('the feature matrix marks a group by its worst outcome, and every reporter shows the same counts', () => {
	const records: TestRunRecord[] = [
		ReporterFixtures.record('models.list', 'models', 'PASS'),
		ReporterFixtures.record('chat.basic', 'chat', 'PASS'),
		ReporterFixtures.record('chat.system_message', 'chat', 'WARN'),
		ReporterFixtures.record('errors.unknown_model', 'errors', 'FAIL'),
		ReporterFixtures.record('parameters.temperature', 'parameters', 'SKIP'),
	];
	const options = { endpoint: 'http://example.test/v1', modelId: 'a-model' };

	// The words the terminal reporter marks a group with are the same words it marks each test
	// with, so a reader learns one set of four rather than a set of words and a set of symbols.
	const terminal = TerminalReporter.render(records, options);
	Assert.match(terminal, /Capability\s+Status/);
	Assert.match(terminal, /Models\s+OK/);
	Assert.match(terminal, /Chat Completions\s+Warn/);
	Assert.match(terminal, /Errors\s+Failed/);
	Assert.match(terminal, /Parameters\s+Skipped/);

	const json = JSON.parse(JsonReporter.render(records, options)) as { summary: Record<string, number>; tests: { id: string }[] };
	Assert.deepEqual(json.summary, { passed: 2, failed: 1, skipped: 1, warned: 1, compatibilityPercent: 50 });
	Assert.equal(json.tests.length, 5);

	const markdown = MarkdownReporter.render(records, options);
	Assert.match(markdown, /- Passed: 2/);
	Assert.match(markdown, /Compatibility: 50\.0%/);

	const junit = JunitReporter.render(records, options);
	Assert.match(junit, /tests="5" failures="1" skipped="1"/);
});

void Test('the markdown reporter escapes a vertical bar and a newline, which would otherwise break its table', () => {
	const records = [ReporterFixtures.record('chat.basic', 'chat', 'FAIL', 'broke | badly\non two lines')];
	const markdown = MarkdownReporter.render(records, { endpoint: 'http://example.test/v1', modelId: 'a-model' });
	const row = markdown.split('\n').find((line) => line.includes('chat.basic'));
	Assert.equal(row?.includes('broke \\| badly on two lines'), true, `row was ${String(row)}`);
});

void Test('the junit reporter escapes the characters XML reserves, and writes WARN as a passing case', () => {
	const records = [
		ReporterFixtures.record('chat.basic', 'chat', 'FAIL', 'got <html> & "quotes"'),
		ReporterFixtures.record('streaming.timing', 'streaming', 'WARN', 'all chunks arrived at once'),
	];
	const junit = JunitReporter.render(records, { endpoint: 'http://example.test/v1', modelId: 'a-model' });
	Assert.match(junit, /&lt;html&gt; &amp; &quot;quotes&quot;/);
	Assert.equal(junit.includes('<html>'), false);
	Assert.match(junit, /<system-out>WARN: all chunks arrived at once<\/system-out>/);
	Assert.match(junit, /failures="1"/);
});

void Test('the terminal reporter prints a passing test\'s detail only when verbose is asked for', () => {
	const records = [ReporterFixtures.record('chat.basic', 'chat', 'PASS', 'the interesting measurement')];
	const options = { endpoint: 'http://example.test/v1', modelId: 'a-model' };
	Assert.equal(TerminalReporter.render(records, options).includes('the interesting measurement'), false);
	const verbose = TerminalReporter.render(records, { ...options, verbose: true });
	Assert.match(verbose, /the interesting measurement/);
	Assert.match(verbose, /\[chat\.basic, \d+ ms\]/);
});
