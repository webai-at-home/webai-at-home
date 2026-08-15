// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { OpenaiPackageClient } from '../src/clients/openai_package_client.js';
import { RawHttpClient } from '../src/clients/raw_http_client.js';
import { coreProfile } from '../src/profiles/core.js';
import { TerminalReporter } from '../src/reporter/terminal.js';
import { Runner, type TestRunRecord } from '../src/runner.js';
import { chatBasicTest } from '../src/tests/chat/basic.js';
import { errorsUnknownModelTest } from '../src/tests/errors/unknown_model.js';
import { usageTotalIsSumTest } from '../src/tests/usage/total_is_sum.js';
import type { ConformanceTest, TestContext } from '../src/types.js';

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
		const context: TestContext = {
			rawHttpClient: new RawHttpClient(target),
			openaiPackageClient: new OpenaiPackageClient(target),
			modelId: TestFixtures.modelId,
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

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
//	Runner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

void Test('Runner turns a request that never reaches a server into a FAIL result, not a thrown error', async () => {
	const target = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', timeoutMs: 500 };
	const context: TestContext = {
		rawHttpClient: new RawHttpClient(target),
		openaiPackageClient: new OpenaiPackageClient(target),
		modelId: TestFixtures.modelId,
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
