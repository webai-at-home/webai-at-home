import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_gemma_4_e2b_full test — the OpenAI-compatible server against a real browser worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_gemma_4_e2b_full --workspace @webai/consumer-openai
// Or: npm run test:real:llm_gemma_4_e2b_full:headed --workspace @webai/consumer-openai, to watch the browser
// instead of running it headless.
// Add REAL_TEST_SLOW=<milliseconds> to slow every browser operation down, for better observability.
// Add REAL_TEST_DEVTOOLS=true to open Chrome DevTools for the debug page (forces a visible window).
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, the worker web page, and this package's own
// OpenAI-compatible server, opens the gateway's `/debug_iframe_llm_gemma_4_e2b_full` page in a dedicated Chrome
// process to set up the one worker browser tab the Gemma 4 E2B full-model stage needs, then submits a prompt
// through the `openai` package and checks the answer mentions the expected capital.
//
// What this test needs, beyond what the other real tests need:
//
// - **A WebGPU adapter with `shader-f16`.** This stage has no WebAssembly fallback at all. WebAssembly is far too
//   slow to carry the model this project means to make its default, and a WebAssembly answer would prove nothing
//   about the WebGPU path a real worker takes. `StageHelperLlmGemma4E2bFull.readiness` refuses the stage outright
//   without one, and this test then fails with no worker offering the stage rather than answering some other way.
// - **About 3111 megabytes of free origin storage.** That is the download: the merged decoder and the token
//   embedding graphs at `q4f16`, pinned to revision 9f4bef82ea6e296bc69f8a2f5939f73af81b07a6 of
//   onnx-community/gemma-4-E2B-it-ONNX. `readiness` asks for 3500 megabytes free before it will offer the stage.
// - **A real Chrome, not an embedded browser view.** Milestone 4 of
//   https://github.com/webai-at-home/webai-at-home/issues/211 found Claude Code's embedded browser pane caps an
//   origin at about 2900 megabytes and refuses `navigator.storage.persist()`, which is below this model's size, so
//   the stage is correctly never offered there. The same machine's real Chrome reported 10240 megabytes.
//
// This is several times the download of every other real test in this package, so its setup timeout is larger
// than theirs by the same order.
//
// No mock stands in for the download or for the browser's own WebGPU inference: this test exercises the actual
// Hugging Face download and the actual generation, through the real gateway, the real worker browser, and the
// real OpenAI-compatible consumer path.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long one answer may take, in milliseconds. */
const ANSWER_TIMEOUT_MS = 900_000;

const realTestHelper = new RealTestHelper({
	debugPath: '/debug_iframe_llm_gemma_4_e2b_full',
	expectedWorkerCount: 1,
	waitTimeoutMs: 1_200_000,
	headless: process.env.REAL_TEST_HEADED !== 'true',
	devtools: process.env.REAL_TEST_DEVTOOLS === 'true',
	...(process.env.REAL_TEST_SLOW !== undefined
		? {
			slowMoMs: Number(process.env.REAL_TEST_SLOW),
		}
		: {}),
});

/**
 * Builds a client pointed at the consumer this test started.
 *
 * @returns The client the tests below submit through.
 */
const openaiClient = (): OpenAI => new OpenAI({
	baseURL: `${realTestHelper.openaiUrl}/v1`,
	apiKey: 'no-key-required',
	maxRetries: 0,
	timeout: ANSWER_TIMEOUT_MS,
});

NodeTest.before(async () => {
	await realTestHelper.setup();
}, {
	timeout: 1_800_000,
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

NodeTest.test('answers with the capital of France in one stage assignment, through a real browser worker and the OpenAI-compatible server', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France? Answer in one short sentence.',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
});

NodeTest.test('streams the answer one piece at a time, through a real browser worker and the OpenAI-compatible server', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const stream = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France?',
		}],
		stream: true,
	});

	let answer = '';
	let pieceCount = 0;
	for await (const chunk of stream) {
		const piece = chunk.choices[0]?.delta.content ?? '';
		if (piece === '') {
			continue;
		}
		pieceCount += 1;
		answer += piece;
	}

	Assert.ok(pieceCount > 1, `expected the answer to arrive as more than one piece, got ${pieceCount}`);
	Assert.match(answer, /paris/i);
});

// This task type accepts a whole history, decided in milestone 1 of issue #211 because the model ships
// `chat_template.jinja` and a `chat_template` in `tokenizer_config.json`. That decision is only worth anything if
// the model really reads the earlier turns, which is what this asks: the fact is answerable from nowhere else.
NodeTest.test('reads a fact out of an earlier turn of the history, rather than answering the last message alone', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [
			{ role: 'user', content: 'My favourite colour is heliotrope. Remember it.' },
			{ role: 'assistant', content: 'Noted, your favourite colour is heliotrope.' },
			{ role: 'user', content: 'What is my favourite colour? Answer with the colour only.' },
		],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /heliotrope/i);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests — The Shape Of The Answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// This task type is the one entry of `StructuredOutputSupport` that is filled, and these tests are what filled
// it. See [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221). The worker browser tab makes
// the model write the shape by constraining generation with
// `@huggingface/transformers-response-constraint`, through the `logits_processor` and `stopping_criteria` the
// pipeline call already takes; nothing here parses an answer that was generated freely and hopes it is an
// object.
//
// The row is the intersection of what both kinds of worker keep, so the same shapes are asked of the native
// worker in `real_llm_gemma_4_e2b_full_native_worker.test.ts`. Neither suite alone is enough to fill the row.

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
	// The schema said one property and no other, so an answer carrying a second one would mean the schema was
	// read as advice rather than enforced.
	Assert.deepEqual(Object.keys(parsed), ['city']);
	Assert.match(String(parsed.city), /paris/i);
});

NodeTest.test('answers a json_schema of several kinds of field, including the string lengths the reverted compiler refused', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'Describe the weather in Paris today.' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'weather',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
							minLength: 3,
							maxLength: 20,
						},
						celsius: {
							type: 'integer',
						},
						isRaining: {
							type: 'boolean',
						},
						sky: {
							type: 'string',
							enum: ['clear', 'cloudy', 'stormy'],
						},
					},
					required: ['city', 'celsius', 'isRaining', 'sky'],
					additionalProperties: false,
				},
			},
		},
	});
	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as Record<string, unknown>;
	Assert.equal(typeof parsed.city, 'string');
	Assert.equal(String(parsed.city).length >= 3 && String(parsed.city).length <= 20, true);
	// A JSON Schema `integer` is a number with a zero fractional part, so the package allows `22.000`, which
	// `JSON.parse` reads back as 22. See the measurement folder's README for why the form is allowed at all.
	Assert.equal(Number.isInteger(parsed.celsius), true);
	Assert.equal(typeof parsed.isRaining, 'boolean');
	Assert.equal(['clear', 'cloudy', 'stormy'].includes(String(parsed.sky)), true);
});

NodeTest.test('answers a json_schema asking for an array of exactly three strings', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'Name three cities in France.' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'cities',
				schema: {
					type: 'object',
					properties: {
						cities: {
							type: 'array',
							items: {
								type: 'string',
							},
							minItems: 3,
							maxItems: 3,
						},
					},
					required: ['cities'],
					additionalProperties: false,
				},
			},
		},
	});
	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as { cities: string[] };
	Assert.equal(parsed.cities.length, 3);
});

NodeTest.test('answers a json_schema asking for an object inside an object', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'nested_weather',
				schema: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
						},
						weather: {
							type: 'object',
							properties: {
								sky: {
									type: 'string',
								},
								celsius: {
									type: 'integer',
								},
							},
							required: ['sky', 'celsius'],
							additionalProperties: false,
						},
					},
					required: ['city', 'weather'],
					additionalProperties: false,
				},
			},
		},
	});
	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as { city: string; weather: { sky: string; celsius: number } };
	Assert.equal(typeof parsed.weather.sky, 'string');
	Assert.equal(Number.isInteger(parsed.weather.celsius), true);
});

NodeTest.test('answers a json_object with an object', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'Describe the weather in Paris today, as a JSON object.' }],
		response_format: {
			type: 'json_object',
		},
	});
	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as unknown;
	Assert.equal(typeof parsed, 'object');
	Assert.notEqual(parsed, null);
	Assert.equal(Array.isArray(parsed), false);
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
	for await (const chunk of stream) {
		const piece = chunk.choices[0]?.delta.content ?? '';
		if (piece === '') {
			continue;
		}
		pieceCount += 1;
		answer += piece;
	}
	// A shaped answer is read back the same way an unshaped one is: one stage run per piece, each piece
	// constrained by where the grammar had reached when it was generated.
	Assert.equal(pieceCount > 1, true);
	const parsed = JSON.parse(answer) as Record<string, unknown>;
	Assert.match(String(parsed.city), /paris/i);
});

NodeTest.test('refuses a schema the constraint package cannot enforce, before any model is loaded', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	// The refusal milestone 5 added. It happens at submission, so the whole cluster is spared the work and the
	// caller is told which reference is at fault rather than receiving an answer enforced only in part.
	await Assert.rejects(
		async () => await openaiClient().chat.completions.create({
			model: 'llm_gemma_4_e2b_full',
			messages: [{ role: 'user', content: 'What is the capital of France?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'external',
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
	// A model made to write an object cannot write a tool call, and a model free to call a tool is not writing
	// the shape that was asked for. Asked for both at once, a local server wrote the object and invented the
	// reading the tool was declared to fetch.
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

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generation Controls
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// One test per control the row of this task type in `generation_control_support.ts` names, added by milestone 3 of
// https://github.com/webai-at-home/webai-at-home/issues/222. They are what makes that row permanent rather than a
// claim: a control that stops being acted on fails here, in a real browser tab, against the real model.
//
// The three were measured before they were declared. Milestone 0 of that issue ran this exact export on WebGPU and
// watched each of them act, and milestone 2 watched the native worker keep the same three, which is what makes the
// row the intersection of the two workers rather than the capability of one.

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

	// Three runs, and one of them differing is enough. A temperature that is read makes a different answer likely
	// rather than certain, and asking for all three to differ would make this test fail on the model agreeing with
	// itself, which is not what is being measured.
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
 * @param reasoningEffort The level to ask for, or `undefined` to ask for nothing.
 * @returns The answer text and the completion token count.
 */
const answerAtReasoningEffort = async (
	reasoningEffort: string | undefined,
): Promise<{ answer: string; completionTokenCount: number }> => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: SETTLED_PROMPT }],
		...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
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

	// The model really thought. Measured in milestone 0 of
	// https://github.com/webai-at-home/webai-at-home/issues/223: this question costs 8 completion tokens with
	// thinking off and 114 with it on, and the chat template renders 22 prompt tokens against 29. Three times is
	// far below that gap and far above anything two runs of one setting differ by.
	Assert.ok(
		withThinking.completionTokenCount > withoutThinking.completionTokenCount * 3,
		'reasoning_effort high must cost far more completion tokens than none, or the model did not think: '
		+ `${withThinking.completionTokenCount} against ${withoutThinking.completionTokenCount}`,
	);

	// And none of what it thought was reported as its answer. Before `ThoughtChannelCut`, milestone 1 of that issue
	// watched this exact request answered with 450 characters of "Thinking Process: 1. Analyze the Request ..."
	// followed by the sentence, where the native worker answered with the sentence alone. Two workers of one task
	// type must keep a control the same way, and an answer that carries the thinking is the control half kept.
	Assert.ok(
		withThinking.answer.length < withoutThinking.answer.length * 2,
		'an answer that thought must be about as long as one that did not, or the thinking reached the consumer: '
		+ `${JSON.stringify(withThinking.answer)}`,
	);
});

/** The tool the thinking-with-tools test declares, and the only one it declares. */
const WEATHER_TOOL = {
	type: 'function',
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
} as const;

/**
 * Asks for the weather of one city with {@link WEATHER_TOOL} declared, at one level of thinking.
 *
 * @param reasoningEffort The level to ask for.
 * @returns The tool calls reported, the finish reason, and the completion token count.
 */
const toolCallAtReasoningEffort = async (
	reasoningEffort: string,
): Promise<{
	toolCalls: { type: string; function: { name: string; arguments: string } }[];
	finishReason: string;
	completionTokenCount: number;
}> => {
	const completion = await openaiClient().chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{ role: 'user', content: 'What is the weather in Paris right now?' }],
		reasoning_effort: reasoningEffort,
		tools: [WEATHER_TOOL],
	} as never);
	return {
		toolCalls: (completion.choices[0]?.message.tool_calls ?? []) as never,
		finishReason: completion.choices[0]?.finish_reason ?? '',
		completionTokenCount: completion.usage?.completion_tokens ?? 0,
	};
};

NodeTest.test('asks for the same tool whether it thought first or not, and never asks for one it only thought about', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	// Neither conformance run reaches this combination. `--thinking off` sends `reasoning_effort: "none"` and
	// `--thinking on` sends no thinking field at all, so both leave thinking off on this model, and a tool call made
	// by a model that thought first had no live cover at all before this test.
	//
	// A run that declared tools keeps every special token in the text `Gemma4E2bToolCallReader` scans, and the
	// model's thinking is where it works out which tool to call and with what. A call written there is not a call the
	// model decided on, and a calling program runs whatever call it receives on its own machine, so the reader is
	// given the same cut text the answer is decoded from rather than the whole generation.
	const withoutThinking = await toolCallAtReasoningEffort('none');
	const withThinking = await toolCallAtReasoningEffort('high');

	// The model really thought, so the cut really had something to cut. Without this the test would pass on a run
	// where thinking silently stopped happening on the tools path, and would then be measuring nothing.
	Assert.ok(
		withThinking.completionTokenCount > withoutThinking.completionTokenCount * 2,
		'reasoning_effort high must cost far more completion tokens than none, or the model did not think: '
		+ `${withThinking.completionTokenCount} against ${withoutThinking.completionTokenCount}`,
	);

	for (const [levelName, result] of [['none', withoutThinking], ['high', withThinking]] as const) {
		Assert.equal(
			result.toolCalls.length,
			1,
			`at reasoning_effort ${levelName}, exactly one tool call must be reported, not one per time the model `
			+ `wrote one: ${JSON.stringify(result.toolCalls)}`,
		);
		const [toolCall] = result.toolCalls;
		Assert.equal(toolCall?.type, 'function');
		Assert.equal(toolCall?.function.name, 'get_current_weather');
		Assert.deepEqual(JSON.parse(toolCall?.function.arguments ?? '{}'), {
			city: 'Paris',
		});
		Assert.equal(result.finishReason, 'tool_calls');
	}
});

NodeTest.test('refuses top_p and seed, which this task type does not honour, rather than ignoring them', {
	timeout: ANSWER_TIMEOUT_MS,
}, async () => {
	for (const [controlName, body] of [
		['top_p', { top_p: 0.01 }],
		['seed', { seed: 42 }],
	] as [string, Record<string, unknown>][]) {
		await Assert.rejects(
			() => openaiClient().chat.completions.create({
				model: 'llm_gemma_4_e2b_full',
				messages: [{ role: 'user', content: OPEN_ENDED_PROMPT }],
				...body,
			} as never),
			(error: unknown) => {
				const apiError = error as { status?: number; error?: { code?: string; param?: string } };
				Assert.equal(apiError.status, 400);
				Assert.equal(apiError.error?.code, 'unhonourable_generation_control');
				Assert.equal(apiError.error?.param, controlName);
				return true;
			},
		);
	}
});
