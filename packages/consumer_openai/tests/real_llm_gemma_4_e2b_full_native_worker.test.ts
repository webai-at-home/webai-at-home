import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_gemma_4_e2b_full test — response_format through a real native worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_gemma_4_e2b_full_native_worker --workspace @webai/consumer-openai
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, this package's own OpenAI-compatible server,
// and one worker process from @webai/worker-openai, then asks for a shaped answer through the `openai` package.
//
// This is one half of what fills the `task_type_llm_gemma_4_e2b_full` row of
// `packages/protocol/src/task/structured_output_support.ts`. That row is the intersection of what both kinds of
// worker keep, so the same shapes are asked of the worker browser tab in `real_llm_gemma_4_e2b_full.test.ts`,
// and neither suite alone is enough to fill it. See
// [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221).
//
// What this half proves is that the native worker sends `response_format` in the chat completion body it
// builds, measured through the whole cluster rather than against the local server directly.
//
// Both shapes a consumer may ask for are sent to the local server as a `json_schema`, because that is the one
// spelling both local servers accept: LM Studio 0.4.20 answers OpenAI's own `{"type":"json_object"}` with HTTP
// 400 and `'response_format.type' must be 'json_schema' or 'text'`, while Ollama accepts both. See
// `OpenaiApiClient.responseFormatFieldOf`.
//
// It needs a server speaking the OpenAI-compatible API running locally with the model already downloaded. By
// default that is Ollama serving `gemma4:e2b`, started with:
//
//   ollama serve
//
// Set WEBAI_LOCAL_MODEL_BASE_URL to point at a different local server, and WEBAI_LOCAL_MODEL to ask for a
// different model — LM Studio serves the same model as `google/gemma-4-e2b`. Both must agree with each other:
// the worker refuses to advertise its stage unless the server named actually holds the model named.
//
// No mock stands in for the local server or for its inference: this test exercises the real gateway, the real
// worker process, the real local model server, and the real OpenAI-compatible consumer path.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The local server the worker forwards prompts to, and the model it asks that server for. */
const localModelBaseUrl = process.env.WEBAI_LOCAL_MODEL_BASE_URL ?? 'http://localhost:11434/v1';
const localModelId = process.env.WEBAI_LOCAL_MODEL ?? 'gemma4:e2b';

/** How long one shaped answer may take, in milliseconds. */
const ANSWER_TIMEOUT_MS = 600_000;

const realTestHelper = new RealTestHelper({
	expectedWorkerCount: 1,
	waitTimeoutMs: 120_000,
	nativeWorkerArgs: [
		'--import', 'tsx', 'packages/worker_openai/src/cli.ts',
		'--worker_name', 'real-test-openai-worker',
		'--gateway-url', 'ws://localhost:8787',
		'--openai-base-url', localModelBaseUrl,
		'--openai-model', localModelId,
		'--stage-names', 'stage_llm_gemma_4_e2b_full',
	],
});

/**
 * Checks that the local server is running and holds the model, before the cluster is started.
 *
 * Without this the worker would simply decline to advertise its stage, the helper would wait for a worker that
 * never becomes ready, and the run would end in a timeout that says nothing about the actual cause.
 *
 * @throws If the local server cannot be reached, or does not offer the model this test asks for.
 */
const assertLocalModelIsAvailable = async (): Promise<void> => {
	const response = await fetch(`${localModelBaseUrl}/models`, {
		signal: AbortSignal.timeout(10_000),
	}).catch((error: unknown) => {
		throw new Error(`This test needs a server speaking the OpenAI-compatible API at ${localModelBaseUrl}, which could not be reached: ${error instanceof Error ? error.message : String(error)}. Start Ollama with "ollama serve", or set WEBAI_LOCAL_MODEL_BASE_URL to another one.`);
	});
	if (response.ok === false) {
		throw new Error(`The server at ${localModelBaseUrl} answered its model list with status ${response.status}.`);
	}
	const body = await response.json() as { data?: { id: string }[] };
	const modelIds = (body.data ?? []).map((entry) => entry.id);
	if (modelIds.includes(localModelId) === false) {
		throw new Error(`The server at ${localModelBaseUrl} does not offer ${localModelId}. Download it first, for example with "ollama pull ${localModelId}", or set WEBAI_LOCAL_MODEL to one it has. The models it offers are: ${modelIds.length === 0 ? 'none' : modelIds.join(', ')}.`);
	}
};

/**
 * Builds a client pointed at the consumer this test started.
 *
 * @returns The client every test below submits through.
 */
const openaiClient = (): OpenAI => new OpenAI({
	baseURL: `${realTestHelper.openaiUrl}/v1`,
	apiKey: 'no-key-required',
	maxRetries: 0,
	timeout: ANSWER_TIMEOUT_MS,
});

NodeTest.before(async () => {
	await assertLocalModelIsAvailable();
	await realTestHelper.setup();
}, {
	timeout: 300_000,
});

NodeTest.after(async () => {
	await realTestHelper.teardown();
}, {
	timeout: 30_000,
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

NodeTest.test('answers a json_schema with an object satisfying it', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the capital of France?' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'capital',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
					},
					required: ['city'],
					additionalProperties: false,
				},
			},
		},
	});
	const answer = completion.choices[0]?.message.content ?? '';
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.deepEqual(Object.keys(parsed), ['city']);
	Assert.equal(typeof parsed.city, 'string');
});

NodeTest.test('answers a json_schema of several kinds of field', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the weather in Paris right now?' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'weather',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
						celsius: {
							type: 'integer',
						},
						isRaining: {
							type: 'boolean',
						},
						sky: {
							type: 'string',
							enum: ['clear', 'cloudy', 'rain', 'snow'],
						},
					},
					required: ['city', 'celsius', 'isRaining', 'sky'],
					additionalProperties: false,
				},
			},
		},
	});
	const answer = completion.choices[0]?.message.content ?? '';
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.equal(typeof parsed.city, 'string');
	Assert.equal(Number.isInteger(parsed.celsius), true);
	Assert.equal(typeof parsed.isRaining, 'boolean');
	Assert.equal(['clear', 'cloudy', 'rain', 'snow'].includes(parsed.sky as string), true);
});

NodeTest.test('answers a json_object with an object, through the json_schema spelling both local servers accept', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'Describe the weather in Paris as a JSON object.' }],
		response_format: {
			type: 'json_object',
		},
	});
	const answer = completion.choices[0]?.message.content ?? '';
	const parsed = JSON.parse(answer) as unknown;
	Assert.equal(typeof parsed, 'object');
	Assert.notEqual(parsed, null);
	Assert.equal(Array.isArray(parsed), false);
});

NodeTest.test('a request that asked for no shape still answers in prose', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the capital of France? Answer in one short sentence.' }],
	});
	const answer = completion.choices[0]?.message.content ?? '';
	Assert.notEqual(answer, '');
	Assert.equal(answer.trim().startsWith('{'), false);
});

NodeTest.test('streams a json_schema answer one piece at a time', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const stream = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the capital of France?' }],
		stream: true,
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'capital',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
					},
					required: ['city'],
					additionalProperties: false,
				},
			},
		},
	});
	let answer = '';
	let pieceCount = 0;
	for await (const piece of stream) {
		const text = piece.choices[0]?.delta.content ?? '';
		if (text !== '') {
			answer += text;
			pieceCount += 1;
		}
	}
	Assert.equal(pieceCount > 1, true);
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.equal(typeof parsed.city, 'string');
});

NodeTest.test('refuses a schema it cannot enforce, rather than enforcing the part of it it understands', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	// Milestone 5 of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221). The
	// refusal is the constraint package's own, asked at submission, so no model is ever loaded and
	// no token is ever generated for this request.
	await Assert.rejects(
		async () => await openaiClient().chat.completions.create({
			model: 'llm_gemma_4_e2b_full',
			messages: [{ role: 'user', content: 'What is the capital of France?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'capital',
					schema: {
						type: 'object',
						properties: {
							city: {
								$ref: 'https://example.invalid/city.schema.json',
							},
						},
						required: ['city'],
					},
				},
			},
		}),
		(error: unknown) => {
			const apiError = error as { status?: number; error?: { code?: string; param?: string; message?: string } };
			Assert.equal(apiError.status, 400);
			Assert.equal(apiError.error?.code, 'unenforceable_schema');
			Assert.equal(apiError.error?.param, 'response_format.json_schema.schema');
			Assert.match(apiError.error?.message ?? '', /External JSON Schema reference/);
			return true;
		},
	);
});

NodeTest.test('refuses a shape asked for beside declared tools, which cannot both be honoured', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	// Asked for both at once, LM Studio 0.4.20 wrote no tool call and answered
	// `{"city": "Paris", "weather": "Sunny"}` — inventing the very reading the tool was declared to
	// fetch, and saying nothing had gone wrong.
	await Assert.rejects(
		async () => await openaiClient().chat.completions.create({
			model: 'llm_gemma_4_e2b_full',
			messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
			tools: [
				{
					type: 'function',
					function: {
						name: 'get_weather',
						description: 'Reads the current weather of one city.',
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
			],
			response_format: {
				type: 'json_object',
			},
		}),
		(error: unknown) => {
			const apiError = error as { status?: number; error?: { code?: string; param?: string } };
			Assert.equal(apiError.status, 400);
			Assert.equal(apiError.error?.code, 'response_format_with_tools');
			Assert.equal(apiError.error?.param, 'response_format');
			return true;
		},
	);
});

NodeTest.test('still answers a shape asked for beside tool_choice "none", which declares no tool at all', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	// The refusal above is about the tools the model is really told about, not about the `tools`
	// field. `tool_choice: "none"` declares nothing, so there is nothing for the shape to fight with.
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the capital of France?' }],
		tool_choice: 'none',
		tools: [
			{
				type: 'function',
				function: {
					name: 'get_weather',
					description: 'Reads the current weather of one city.',
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
		],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'capital',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
					},
					required: ['city'],
					additionalProperties: false,
				},
			},
		},
	});
	const answer = completion.choices[0]?.message.content ?? '';
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.equal(typeof parsed.city, 'string');
});
