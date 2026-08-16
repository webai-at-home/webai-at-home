import Assert from 'node:assert/strict';
import NodeTest from 'node:test';
import OpenAI from 'openai';
import { RealTestHelper } from './real_test_helper.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Real llm_qwen3_5_0_8b_full test — reasoning_effort through a real native worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run test:real:llm_qwen3_5_0_8b_full_native_worker --workspace @webai/consumer-openai
//
// Unlike tests/index.test.ts, this test is not part of the default `npm run test --workspaces`. It builds the
// protocol and consumer CLI packages, starts the central gateway, this package's own OpenAI-compatible server,
// and one worker process from @webai/worker-openai, then submits a two-turn history through the `openai`
// package.
//
// This is the end-to-end proof for [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192).
// Qwen3.5-0.8B thinks before it answers, and on the history below it thinks until its whole output budget is
// gone without ever writing an answer: LM Studio 0.4.20 reported 8153 completion tokens, all 8153 of them
// reasoning tokens, `finish_reason: length`, and `content: ""`. Raising the context window to 32768 only bought
// a longer runaway, 32731 reasoning tokens and the same empty answer, and `chat_template_kwargs` is dropped by
// that server entirely. `reasoning_effort` is the one lever that works, so the test below asks for it through
// the whole cluster rather than against the local server alone.
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
const localModelId = process.env.WEBAI_LOCAL_MODEL ?? 'qwen_qwen3.5-0.8b';

/**
 * The history that provokes the runaway, which is the one
 * `packages/openai_conformance_test/src/tests/chat/multi_turn.ts` sends.
 */
const runawayHistory = [
	{
		role: 'user' as const,
		content: 'Remember the number 42.',
	},
	{
		role: 'assistant' as const,
		content: 'Okay.',
	},
	{
		role: 'user' as const,
		content: 'Repeat the number I just gave you, and nothing else.',
	},
];

const realTestHelper = new RealTestHelper({
	expectedWorkerCount: 1,
	waitTimeoutMs: 120_000,
	nativeWorkerArgs: [
		'--import', 'tsx', 'packages/worker_openai/src/cli.ts',
		'--worker_name', 'real-test-openai-worker',
		'--gateway-url', 'ws://localhost:8787',
		'--openai-base-url', localModelBaseUrl,
		'--openai-model', localModelId,
		'--stage-names', 'stage_llm_qwen3_5_0_8b_full',
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

NodeTest.test('answers a history that otherwise runs away, once the consumer asks for no thinking', {
	timeout: 600_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 600_000,
	});
	const completion = await client.chat.completions.create({
		model: 'llm_qwen3_5_0_8b_full',
		messages: runawayHistory,
		reasoning_effort: 'none',
	});

	// The defect this fixes is an empty answer, not a wrong one. A 0.8-billion-parameter model that is not
	// allowed to think is often wrong about which number it was given — it answered "Fourteen." four times out
	// of five against the local server alone — so this test asserts that an answer arrived at all, and
	// deliberately does not grade it, exactly as `chat.multi_turn` does not.
	Assert.notEqual(completion.choices[0]?.message.content ?? '', '');
	Assert.notEqual(completion.choices[0]?.finish_reason, 'length');
});

NodeTest.test('refuses a thinking budget for a model that never thinks, rather than accepting it and dropping it', {
	timeout: 300_000,
}, async () => {
	const client = new OpenAI({
		baseURL: `${realTestHelper.openaiUrl}/v1`,
		apiKey: 'no-key-required',
		maxRetries: 0,
		timeout: 300_000,
	});
	// `llm_llama3_2_1b_full` does not honour this control, so asking it for one is an HTTP 400 naming the field
	// at fault. Being told is better than receiving an answer generated some other way and being told nothing.
	await Assert.rejects(
		async () => await client.chat.completions.create({
			model: 'llm_llama3_2_1b_full',
			messages: runawayHistory,
			reasoning_effort: 'none',
		}),
		(error: unknown) => {
			const apiError = error as { status?: number; error?: { code?: string; param?: string } };
			Assert.equal(apiError.status, 400);
			Assert.equal(apiError.error?.code, 'unhonourable_generation_control');
			Assert.equal(apiError.error?.param, 'reasoning_effort');
			return true;
		},
	);
});
