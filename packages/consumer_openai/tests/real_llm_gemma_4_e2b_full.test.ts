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
	timeout: 900_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 900_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France? Answer in one short sentence.',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
});

NodeTest.test('streams the answer one piece at a time, through a real browser worker and the OpenAI-compatible server', {
	timeout: 900_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 900_000,
	});
	const stream = await client.chat.completions.create({
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
	timeout: 900_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 900_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [
			{ role: 'user', content: 'My favourite colour is heliotrope. Remember it.' },
			{ role: 'assistant', content: 'Noted, your favourite colour is heliotrope.' },
			{ role: 'user', content: 'What is my favourite colour? Answer with the colour only.' },
		],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /heliotrope/i);
});

NodeTest.test('holds the model to a schema, key by key and type by type, by masking every token that would break it', {
	timeout: 900_000,
}, async () => {
	// The whole of milestone 6 of [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219)
	// in one request. `@huggingface/transformers` offers no way to ask for a shape, so this stage
	// enforces one between the logits and the choice of token: at every step the mask leaves legal
	// only the entries that could continue an answer the schema still accepts. A required property
	// left out, a value of the wrong type, and a text outside an enumeration are each a token the
	// model is not able to write, rather than a mistake read back afterwards.
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 900_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{
			role: 'user',
			content: 'Give the capital of France, its population, and whether it is on the coast.',
		}],
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
				},
			},
		},
	});

	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as Record<string, unknown>;
	Assert.deepEqual(Object.keys(parsed).sort(), ['capital', 'isCoastal', 'population']);
	Assert.match(String(parsed.capital), /paris/i);
	Assert.equal(Number.isInteger(parsed.population), true);
	Assert.equal(typeof parsed.isCoastal, 'boolean');
});

NodeTest.test('answers with a JSON object when one is asked for, which is the same masking with the loosest schema', {
	timeout: 900_000,
}, async () => {
	// `json_object` is a request for any object at all, and `{ "type": "object" }` is the schema that
	// says so, so both shapes reach the mask as a schema and there is one path rather than two.
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 900_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
		messages: [{
			role: 'user',
			content: 'Give the capital of France and its population. Answer with the keys capital and population.',
		}],
		response_format: { type: 'json_object' },
	});

	const parsed = JSON.parse(completion.choices[0]?.message.content ?? '') as unknown;
	Assert.equal(typeof parsed, 'object');
	Assert.notEqual(parsed, null);
	Assert.equal(Array.isArray(parsed), false);
});
