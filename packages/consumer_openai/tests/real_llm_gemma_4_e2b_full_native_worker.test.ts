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
// and one worker process from @webai/worker-openai, then sends chat completions through the `openai` package.
//
// This is the end-to-end proof for milestones 5 and 6 of
// [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219), which entered `json_object` and then
// `json_schema` into the `task_type_llm_gemma_4_e2b_full` row of `structured_output_support.ts`. Until that row
// was widened, every request below was refused at submission and none of the code it exercises could be reached
// from a consumer at all. What this test proves is that the promise the row now makes is kept by the whole path —
// the OpenAI-compatible server, the central gateway, the native worker, and the local model server behind it —
// rather than only by the parts of it that were measured one at a time.
//
// It needs a server speaking the OpenAI-compatible API running locally with the model already downloaded. By
// default that is LM Studio, whose local server is started from the LM Studio application or with:
//
//   lms server start
//
// Set WEBAI_LOCAL_MODEL_BASE_URL to point at a different local server, and WEBAI_LOCAL_MODEL to ask for a
// different model. Both must agree with each other: the worker refuses to advertise its stage unless the
// server named actually holds the model named. Against Ollama, that is:
//
//   WEBAI_LOCAL_MODEL_BASE_URL=http://localhost:11434/v1 WEBAI_LOCAL_MODEL=gemma4:e2b
//
// No mock stands in for the local server or for its inference: this test exercises the real gateway, the real
// worker process, the real local model server, and the real OpenAI-compatible consumer path.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The local server the worker forwards prompts to, and the model it asks that server for. */
const localModelBaseUrl = process.env.WEBAI_LOCAL_MODEL_BASE_URL ?? 'http://localhost:1234/v1';
const localModelId = process.env.WEBAI_LOCAL_MODEL ?? 'google/gemma-4-e2b';

/** The question every test below asks, which names the keys so the model has an object to write. */
const questionNamingTwoKeys = 'Give the capital of France and its population. Answer with the keys capital and population.';

/** The question the schema tests ask, which names no key at all, because the schema names them. */
const questionUnderTheSchema = 'Give the capital of France, its population, and whether it is on the coast.';

/** The schema the answer to {@link questionUnderTheSchema} has to satisfy. */
const capitalSchema = {
	type: 'object',
	properties: {
		capital: {
			type: 'string',
		},
		population: {
			type: 'integer',
		},
		isCoastal: {
			type: 'boolean',
		},
	},
	required: ['capital', 'population', 'isCoastal'],
	additionalProperties: false,
};

/** A schema whose one property may hold three texts and nothing else. */
const sentimentSchema = {
	type: 'object',
	properties: {
		sentiment: {
			type: 'string',
			enum: ['positive', 'negative', 'neutral'],
		},
	},
	required: ['sentiment'],
	additionalProperties: false,
};

/** One tool declaration, for the request that asks for a shape and declares a tool in the same call. */
const weatherTool = {
	type: 'function' as const,
	function: {
		name: 'get_current_weather',
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
};

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
 * Builds a client for the OpenAI-compatible server this test started.
 *
 * @returns The client, pointed at that server and told not to retry, so a refusal is seen once.
 */
const clientForTheCluster = (): OpenAI => new OpenAI({
	baseURL: `${realTestHelper.openaiUrl}/v1`,
	apiKey: 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
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
		throw new Error(`This test needs a server speaking the OpenAI-compatible API at ${localModelBaseUrl}, which could not be reached: ${error instanceof Error ? error.message : String(error)}. Start LM Studio's local server, for example with "lms server start", or set WEBAI_LOCAL_MODEL_BASE_URL to another one.`);
	});
	if (response.ok === false) {
		throw new Error(`The server at ${localModelBaseUrl} answered its model list with status ${response.status}.`);
	}
	const body = await response.json() as { data?: { id: string }[] };
	const modelIds = (body.data ?? []).map((entry) => entry.id);
	if (modelIds.includes(localModelId) === false) {
		throw new Error(`The server at ${localModelBaseUrl} does not offer ${localModelId}. Download it first, or set WEBAI_LOCAL_MODEL to one it has. The models it offers are: ${modelIds.length === 0 ? 'none' : modelIds.join(', ')}.`);
	}
};

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

NodeTest.test('answers with a JSON object when the consumer asks for one', {
	timeout: 600_000,
}, async () => {
	const completion = await clientForTheCluster().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: questionNamingTwoKeys }],
		response_format: { type: 'json_object' },
	});

	const answer = completion.choices[0]?.message.content ?? '';
	// The answer is parsed rather than pattern-matched, because reading it with `JSON.parse` is the
	// one thing a client asking for `json_object` is going to do with it.
	const parsed = JSON.parse(answer) as unknown;
	Assert.equal(typeof parsed, 'object');
	Assert.notEqual(parsed, null);
	Assert.equal(Array.isArray(parsed), false);
});

NodeTest.test('answers with a JSON object asked for in pieces as well, joined back to exactly what it sent', {
	timeout: 600_000,
}, async () => {
	const stream = await clientForTheCluster().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: questionNamingTwoKeys }],
		response_format: { type: 'json_object' },
		stream: true,
	});
	let joined = '';
	for await (const piece of stream) {
		joined += piece.choices[0]?.delta.content ?? '';
	}

	// A shape that only survives being read whole is no use: a client asking for pieces reads the
	// pieces, and the object it builds out of them has to be the object the model wrote.
	const parsed = JSON.parse(joined) as unknown;
	Assert.equal(typeof parsed, 'object');
	Assert.notEqual(parsed, null);
	Assert.equal(Array.isArray(parsed), false);
});

NodeTest.test('answers with an object the schema accepts, key by key and type by type', {
	timeout: 600_000,
}, async () => {
	// A schema is a promise about keys and types, and `json_object` is not: the same question under
	// `json_object` answered `"population": "Approximately 2,141,000 (city proper)"`, which is an
	// object and is not a number. What is checked here is the promise a schema makes and the other
	// shape does not.
	const completion = await clientForTheCluster().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: questionUnderTheSchema }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'capital_object',
				strict: true,
				schema: capitalSchema,
			},
		},
	});

	const answer = completion.choices[0]?.message.content ?? '';
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.deepEqual(Object.keys(parsed).sort(), ['capital', 'isCoastal', 'population']);
	Assert.equal(typeof parsed.capital, 'string');
	Assert.equal(typeof parsed.population, 'number');
	Assert.equal(Number.isInteger(parsed.population), true);
	Assert.equal(typeof parsed.isCoastal, 'boolean');
});

NodeTest.test('answers with a value the enumeration names, and not one of its own', {
	timeout: 600_000,
}, async () => {
	// An enumeration is the part of a schema a prompt cannot stand in for: a model told to answer
	// `positive`, `negative`, or `neutral` writes `Positive.` often enough that a client has to
	// forgive it, and a client that forgives it is a client parsing prose again.
	const completion = await clientForTheCluster().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'The film was wonderful from start to finish. What is the sentiment?' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'sentiment_object',
				strict: true,
				schema: sentimentSchema,
			},
		},
	});

	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as Record<string, unknown>;
	Assert.equal(['positive', 'negative', 'neutral'].includes(parsed.sentiment as string), true, String(parsed.sentiment));
});

NodeTest.test('refuses a schema no worker of this project could hold a model to, rather than enforcing part of it', {
	timeout: 300_000,
}, async () => {
	// The row promises `json_schema`, and this is the boundary of that promise. A keyword left
	// unenforced would come back reported as though the whole schema had been kept, which is the
	// failure `structured_output_support.ts` exists to prevent, one level further down.
	await Assert.rejects(
		async () => await clientForTheCluster().chat.completions.create({
			model: 'llm_gemma_4_e2b_full',
			messages: [{ role: 'user', content: questionNamingTwoKeys }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'capital_object',
					strict: true,
					schema: {
						type: 'object',
						properties: {
							capital: {
								type: 'string',
								minLength: 3,
							},
						},
						required: ['capital'],
						additionalProperties: false,
					},
				},
			},
		}),
		(error: unknown) => {
			const message = (error as Error).message;
			// The refusal names the keyword it could not enforce, which is the half of a refusal that
			// tells its reader what to do next.
			Assert.match(message, /minLength/);
			return true;
		},
	);
});

NodeTest.test('refuses a shape asked for beside a declared tool, rather than dropping one of the two', {
	timeout: 300_000,
}, async () => {
	// A shape is held to by allowing only the tokens it permits, and every marker that opens a tool
	// call is a token no shape permits. Measured on both workers: the worker browser tab refuses the
	// pair outright, and of the two local servers this native worker can sit in front of, one kept
	// the tool call and the other asked for no tool at all and invented the reading the tool existed
	// to fetch.
	await Assert.rejects(
		async () => await clientForTheCluster().chat.completions.create({
			model: 'llm_gemma_4_e2b_full',
			messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
			tools: [weatherTool],
			response_format: { type: 'json_object' },
		}),
		(error: unknown) => {
			Assert.match((error as Error).message, /either the tools or the response_format, not both/);
			return true;
		},
	);
});

NodeTest.test('answers a request that asked for no shape exactly as it always did', {
	timeout: 600_000,
}, async () => {
	// The whole point of the field being absent rather than present and empty. A request written
	// before this cluster carried any shape must reach the local server as the request it always was.
	const completion = await clientForTheCluster().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: questionNamingTwoKeys }],
	});

	Assert.notEqual(completion.choices[0]?.message.content ?? '', '');
});
