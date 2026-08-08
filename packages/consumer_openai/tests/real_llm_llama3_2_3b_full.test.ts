import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_llama3_2_3b_full test — the OpenAI-compatible server against a real native worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_llama3_2_3b_full --workspace @webai/consumer-openai
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, this package's own OpenAI-compatible server,
// and one worker process from @webai/worker-openai, then submits a prompt through the `openai` package and
// checks the answer mentions the expected capital.
//
// This is the one real test with no browser in it, and so no headed variant either: `llm_llama3_2_3b_full` is
// carried out by a Node.js command line process that forwards the prompt to a language-model server running on
// the same device, rather than by a worker browser tab. There is no debug page to open and nothing to watch.
//
// It needs a server speaking the OpenAI-compatible API running locally with the model already downloaded. By
// default that is LM Studio, whose local server is started from the LM Studio application or with:
//
//   lms server start
//
// Set WEBAI_LOCAL_MODEL_BASE_URL to point at a different local server, and WEBAI_LOCAL_MODEL to ask for a
// different model. Both must agree with each other: the worker refuses to advertise its stage unless the
// server named actually holds the model named.
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
const localModelId = process.env.WEBAI_LOCAL_MODEL ?? 'llama-3.2-3b-instruct';

const realTestHelper = new RealTestHelper({
	expectedWorkerCount: 1,
	waitTimeoutMs: 120_000,
	nativeWorkerArgs: [
		'--import', 'tsx', 'packages/worker_openai/src/cli.ts',
		'--worker_name', 'real-test-openai-worker',
		'--base-url', localModelBaseUrl,
		'--model', localModelId,
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
		throw new Error(`This test needs a server speaking the OpenAI-compatible API at ${localModelBaseUrl}, which could not be reached: ${error instanceof Error ? error.message : String(error)}. Start LM Studio's local server, for example with "lms server start", or set WEBAI_LOCAL_MODEL_BASE_URL to another one.`);
	});
	if (response.ok === false) {
		throw new Error(`The server at ${localModelBaseUrl} answered its model list with status ${response.status}.`);
	}
	const body = await response.json() as { data?: { id: string }[] };
	const modelIds = (body.data ?? []).map((entry) => entry.id);
	if (modelIds.includes(localModelId) === false) {
		throw new Error(`The server at ${localModelBaseUrl} does not offer ${localModelId}. Download it first, for example with "lms get ${localModelId}", or set WEBAI_LOCAL_MODEL to one it has. The models it offers are: ${modelIds.length === 0 ? 'none' : modelIds.join(', ')}.`);
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

NodeTest.test('answers with the capital of France in one stage assignment, through a real worker process and the OpenAI-compatible server', {
	timeout: 300_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 300_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_llama3_2_3b_full',
		messages: [{
			role: 'user',
			content: 'What is the capital of France? Answer in one short sentence.',
		}],
	});

	Assert.match(completion.choices[0]?.message.content ?? '', /paris/i);
});

NodeTest.test('streams the answer one piece at a time, through a real worker process and the OpenAI-compatible server', {
	timeout: 300_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 300_000,
	});
	const stream = await client.chat.completions.create({
		model: 'llm_llama3_2_3b_full',
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
