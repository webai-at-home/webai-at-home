import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_llama3_2_1b_full test — the OpenAI-compatible server against a real browser worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_llama3_2_1b_full --workspace @webai/consumer-openai
// Or: npm run test:real:llm_llama3_2_1b_full:headed --workspace @webai/consumer-openai, to watch the browser
// instead of running it headless.
// Add REAL_TEST_SLOW=<milliseconds> to slow every browser operation down, for better observability.
// Add REAL_TEST_DEVTOOLS=true to open Chrome DevTools for the debug page (forces a visible window).
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, the worker web page, and this package's own
// OpenAI-compatible server, opens the gateway's `/debug_iframe_llm_llama3_2_1b_full` page in a dedicated Chrome
// process to set up the one worker browser tab the Llama 3.2 1B Instruct full-model stage needs, then submits a
// prompt through the `openai` package and checks the answer mentions the expected capital. It needs macOS with
// Google Chrome installed, the same as README.md asks of the whole repository's real browser tests, a Chrome
// build with WebGPU and 16-bit float shader support, and a network connection: the worker tab downloads the
// complete model — about 1050 megabytes of weights plus an 11 megabyte tokenizer, pinned to revision
// 14007543b6dc92de88daf96a9aa85d2f95ace6ef of onnx-community/Llama-3.2-1B-Instruct-ONNX — the first time it
// runs, which is why setup here is given as long a timeout as the Qwen3.5-0.8B full-model test's.
//
// No mock stands in for the download or for the browser's own WebGPU inference: this test exercises the actual
// Hugging Face download and the actual generation, through the real gateway, the real worker browser, and the
// real OpenAI-compatible consumer path, the same three real components every other test in this file exercises.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Setup
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const realTestHelper = new RealTestHelper({
	debugPath: '/debug_iframe_llm_llama3_2_1b_full',
	expectedWorkerCount: 1,
	waitTimeoutMs: 600_000,
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
	timeout: 900_000,
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
	timeout: 600_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 600_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_llama3_2_1b_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France? Answer in one short sentence.',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
});

NodeTest.test('streams the answer one piece at a time, through a real browser worker and the OpenAI-compatible server', {
	timeout: 600_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 600_000,
	});
	const stream = await client.chat.completions.create({
		model: 'llm_llama3_2_1b_full',
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
