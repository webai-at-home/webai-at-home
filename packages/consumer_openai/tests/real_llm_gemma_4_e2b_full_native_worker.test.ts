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

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generation Controls
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// One test per control the row of this task type in `generation_control_support.ts` names, added by milestone 3 of
// https://github.com/webai-at-home/webai-at-home/issues/222. The same three tests run against the worker browser tab
// in `real_llm_gemma_4_e2b_full.test.ts`, because the row is the intersection of the two workers: a control both
// keep. If either side stops keeping one, one of the two files fails.
//
// One difference from that file, and it is the model rather than the control. This model thinks, and these two
// workers disagree about whether it may: the browser tab passes `enable_thinking: false` and answers the settled
// question in 8 completion tokens, while this worker lets the local server think and answers it in about 120. So the
// sampling tests here ask for no token budget at all. A budget small enough to keep them quick would be spent on
// thinking, and the run would fail with an answer that never began rather than with a control that was not kept —
// which is what the first run of milestone 2's measurement did, six times. Budgeting thinking is
// https://github.com/webai-at-home/webai-at-home/issues/223.

/** The question the sampling tests repeat, chosen because it has many acceptable answers. */
const OPEN_ENDED_PROMPT = 'Write one sentence about the sea.';

/**
 * The question the token limit and stop sequence tests use, chosen because its shape is known before it is
 * generated.
 */
const COUNTING_PROMPT = 'Count from 1 to 9, separated by spaces. Answer with the numbers only.';

/**
 * Submits {@link OPEN_ENDED_PROMPT} at one temperature and returns the answer.
 *
 * @param temperature The temperature to ask for.
 * @returns The answer text.
 */
const answerAtTemperature = async (temperature: number): Promise<string> => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: OPEN_ENDED_PROMPT }],
		temperature: temperature,
	});
	return completion.choices[0]?.message.content ?? '';
};

NodeTest.test('honours temperature: it answers the same way twice at 0, and answers differently at 1.6', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const firstColdAnswer = await answerAtTemperature(0);
	const secondColdAnswer = await answerAtTemperature(0);
	Assert.equal(secondColdAnswer, firstColdAnswer, 'two answers at temperature 0 must be the same answer');

	// Three runs, and one of them differing is enough, for the same reason the browser tab's copy of this test says:
	// a temperature that is read makes a different answer likely rather than certain.
	const hotAnswers = [await answerAtTemperature(1.6), await answerAtTemperature(1.6), await answerAtTemperature(1.6)];
	Assert.ok(
		hotAnswers.some((hotAnswer) => hotAnswer !== firstColdAnswer),
		`expected at least one answer at temperature 1.6 to differ from the greedy one, got ${JSON.stringify(hotAnswers)}`,
	);
});

NodeTest.test('honours max_completion_tokens: it stops on the budget and says so, and finishes on its own when the budget is generous', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const cutCompletion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: COUNTING_PROMPT }],
		max_completion_tokens: 8,
	});
	Assert.equal(cutCompletion.choices[0]?.finish_reason, 'length');
	Assert.ok(
		(cutCompletion.usage?.completion_tokens ?? 0) <= 8,
		`expected at most 8 completion tokens, got ${cutCompletion.usage?.completion_tokens}`,
	);

	const wholeCompletion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: COUNTING_PROMPT }],
		max_completion_tokens: 32,
	});
	Assert.equal(wholeCompletion.choices[0]?.finish_reason, 'stop');
	Assert.ok(
		(wholeCompletion.usage?.completion_tokens ?? 0) > (cutCompletion.usage?.completion_tokens ?? 0),
		'a generous budget must produce more tokens than a budget of 8',
	);
});

NodeTest.test('honours stop: the answer ends where the stop sequence began, and never carries it', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const unstoppedCompletion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: COUNTING_PROMPT }],
		max_completion_tokens: 32,
	});
	const unstoppedAnswer = unstoppedCompletion.choices[0]?.message.content ?? '';
	Assert.match(unstoppedAnswer, /5/, 'the answer with no stop sequence must reach the character the next one stops at');

	const stoppedCompletion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: COUNTING_PROMPT }],
		max_completion_tokens: 32,
		stop: ['5'],
	});
	const stoppedAnswer = stoppedCompletion.choices[0]?.message.content ?? '';
	Assert.doesNotMatch(
		stoppedAnswer,
		/5/,
		`the stop sequence must never be forwarded, got ${JSON.stringify(stoppedAnswer)}`,
	);
	Assert.equal(stoppedCompletion.choices[0]?.finish_reason, 'stop');
	Assert.ok(
		(stoppedCompletion.usage?.completion_tokens ?? 0) < (unstoppedCompletion.usage?.completion_tokens ?? 0),
		'a stopped answer must cost fewer tokens than the same answer generated whole',
	);
});
/**
 * The question the thinking test asks, chosen because its answer is settled and short whether the model thinks
 * about it or not, so the completion token count is the only thing that moves.
 */
const SETTLED_PROMPT = 'What is the capital of France? Answer in one short sentence.';

/**
 * Submits {@link SETTLED_PROMPT} at one level of thinking and returns the answer beside what it cost.
 *
 * @param reasoningEffort The level to ask for.
 * @returns The answer text and the completion token count.
 */
const answerAtReasoningEffort = async (
	reasoningEffort: string,
): Promise<{ answer: string; completionTokenCount: number }> => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: SETTLED_PROMPT }],
		reasoning_effort: reasoningEffort,
	} as never);
	return {
		answer: completion.choices[0]?.message.content ?? '',
		completionTokenCount: completion.usage?.completion_tokens ?? 0,
	};
};

NodeTest.test('honours reasoning_effort: none does not think, high does, and the thinking never reaches the consumer', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const withoutThinking = await answerAtReasoningEffort('none');
	const withThinking = await answerAtReasoningEffort('high');

	Assert.match(withoutThinking.answer, /Paris/i, 'the answer asked to think least must still be an answer');
	Assert.match(withThinking.answer, /Paris/i, 'the answer asked to think most must still be an answer');

	// The local server really acted on the field. Measured through this cluster in milestone 2 of
	// https://github.com/webai-at-home/webai-at-home/issues/223: this question costs 8 completion tokens at `none`
	// and between 115 and 131 at every level above it, the spread being the server's own sampling rather than the
	// level. The worker browser tab spends the same 8 against 114, which is what makes this control the
	// intersection of the two workers rather than the capability of one.
	Assert.ok(
		withThinking.completionTokenCount > withoutThinking.completionTokenCount * 3,
		'reasoning_effort high must cost far more completion tokens than none, or the model did not think: '
		+ `${withThinking.completionTokenCount} against ${withoutThinking.completionTokenCount}`,
	);

	// And none of what it thought was reported as its answer. This server reports thinking in a `reasoning` field
	// of its own, which `OpenaiApiClient` never reads, so the answer arrives clean without anything being cut out
	// of it. The worker browser tab has to cut it out, through `ThoughtChannelCut`. The assertion is written the
	// same way on both so that either worker failing it fails for the same stated reason.
	Assert.ok(
		withThinking.answer.length < withoutThinking.answer.length * 2,
		'an answer that thought must be about as long as one that did not, or the thinking reached the consumer: '
		+ `${JSON.stringify(withThinking.answer)}`,
	);
});
