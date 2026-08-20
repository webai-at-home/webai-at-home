import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Test from 'node:test';
import Express from 'express';
import { protocolVersion, type GenerationSettings } from '@webai/protocol';
import type { TaskSocket, TaskTypeName } from '@webai/consumer-cli';
import { ClusterTaskRunner, type ClusterTaskRunnerOptions } from '../src/libs/cluster_task_runner.js';
import { CurlStyleTransactionLogger } from '../src/http/curl_style_transaction_logger.js';
import { ModelCatalog } from '../src/api/model_catalog.js';
import { OpenaiError } from '../src/api/openai_error.js';
import { OpenaiRoutes } from '../src/http/openai_routes.js';
import { HistoryBuilder } from '../src/api/history_builder.js';
import { GenerationSettingsBuilder } from '../src/api/generation_settings_builder.js';
import { ChatCompletionRequestSchema, type ChatCompletionResponse } from '../src/api/openai_types.js';
import { FinishReasonTranslator } from '../src/api/finish_reason_translator.js';
import { PromptFlattener } from '../src/api/prompt_flattener.js';
import { ResponseFormatReader } from '../src/api/response_format_reader.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for the OpenAI-compatible server package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Reading A Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('sends a single message unchanged, so a model that takes a number can be used', () => {
	Assert.equal(PromptFlattener.flatten([{ role: 'user', content: '5' }]), '5');
	Assert.equal(PromptFlattener.flatten([{ role: 'user', content: 'What is the capital of France?' }]), 'What is the capital of France?');
});

Test('labels several messages with their roles and invites the answer', () => {
	const prompt = PromptFlattener.flatten([
		{ role: 'system', content: 'Answer in one short sentence.' },
		{ role: 'user', content: 'What is the capital of France?' },
	]);
	Assert.equal(prompt, 'system: Answer in one short sentence.\nuser: What is the capital of France?\nassistant:');
});

Test('builds a history that keeps each message as its own turn, rather than flattening it into one piece of text', () => {
	const history = HistoryBuilder.build([
		{ role: 'system', content: 'Answer in one short sentence.' },
		{ role: 'user', content: 'What is the capital of France?' },
		{ role: 'assistant', content: 'Paris.' },
		{ role: 'user', content: 'And of Germany?' },
	]);
	Assert.deepEqual(history, {
		messages: [
			{ role: 'system', content: 'Answer in one short sentence.' },
			{ role: 'user', content: 'What is the capital of France?' },
			{ role: 'assistant', content: 'Paris.' },
			{ role: 'user', content: 'And of Germany?' },
		],
	});
});

Test('carries a developer message as a system message, since no worker chat template has a fourth slot for it', () => {
	const history = HistoryBuilder.build([{ role: 'developer', content: 'Answer in one short sentence.' }]);
	Assert.deepEqual(history, { messages: [{ role: 'system', content: 'Answer in one short sentence.' }] });
});

Test('reads the five generation controls, and ignores every other field of the request', () => {
	const parsed = ChatCompletionRequestSchema.safeParse({
		model: 'llm_qwen3_5_0_8b_full',
		messages: [{ role: 'user', content: 'hello' }],
		temperature: 0.7,
		top_p: 0.9,
		max_tokens: 64,
		stop: ['\nUser:'],
		seed: 42,
		n: 3,
		logprobs: true,
	});
	Assert.equal(parsed.success, true);
	Assert.deepEqual(parsed.success === true ? parsed.data : undefined, {
		model: 'llm_qwen3_5_0_8b_full',
		messages: [{ role: 'user', content: 'hello' }],
		temperature: 0.7,
		top_p: 0.9,
		max_tokens: 64,
		stop: ['\nUser:'],
		seed: 42,
	});
});

Test('refuses a body it cannot read', () => {
	Assert.equal(ChatCompletionRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hello' }] }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [] }).success, false);
	// A content part list, which a request carrying an image sends, is refused rather than
	// having its parts joined together.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }).success, false);
	// The tool role is accepted since issue #115: a history carrying a tool's answer can now be
	// continued, because a worker that can ask for a tool can also read the answer of one back.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'tool', content: 'hello' }] }).success, true);
	// An assistant message that asked for a tool carries no content, because a model that asks for a
	// tool writes no text at all, and an OpenAI client hands that message straight back.
	Assert.equal(ChatCompletionRequestSchema.safeParse({
		model: 'dev_formula',
		messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }],
	}).success, true);
	// A tool declaration with no function at all is refused rather than read as declaring nothing.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] }).success, false);
});

Test('reads whether the request asks for the answer to be streamed', () => {
	const parsed = ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }], stream: true });
	Assert.equal(parsed.success === true ? parsed.data.stream : undefined, true);
});

Test('refuses a generation control whose value is outside the range this interface states for it', () => {
	const messages = [{ role: 'user', content: 'hello' }];
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'llm_qwen3_5_0_8b_full', messages, temperature: 2.5 }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'llm_qwen3_5_0_8b_full', messages, top_p: 1.5 }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'llm_qwen3_5_0_8b_full', messages, max_tokens: 0 }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'llm_qwen3_5_0_8b_full', messages, stop: ['a', 'b', 'c', 'd', 'e'] }).success, false);
	// A client holding no value for a control commonly sends the field set to `null` rather than
	// leaving it out, and both mean the same thing.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'llm_qwen3_5_0_8b_full', messages, temperature: null, top_p: null, max_tokens: null, stop: null, seed: null }).success, true);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Generation Controls Of A Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds the generation settings for one request body, reading it through the request schema
 * first so the test exercises exactly what a real request goes through.
 *
 * @param body The request body a client would send.
 * @param taskTypeName The task type the request's model names.
 * @param isStreaming Whether the caller asked for the answer in pieces.
 * @returns The settings the request would submit its task with.
 */
const generationSettingsOf = (body: Record<string, unknown>, taskTypeName: TaskTypeName, isStreaming = false): GenerationSettings | undefined => {
	const parsed = ChatCompletionRequestSchema.parse(body);
	return GenerationSettingsBuilder.build(parsed, taskTypeName, isStreaming, ResponseFormatReader.read(parsed, taskTypeName));
};

// `GenerationSettingsBuilder.build`'s honouring branch is exercised against
// `llm_llama3_2_1b_full`, which honours `temperature`, `max_completion_tokens`, and `stop` — proved
// live in a real browser tab by the de-risk gate of
// [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196). It is the first task
// type to honour anything since `task_type_llm_llama3_2_3b_full` was retired by issue #154, and it
// deliberately honours three of the five rather than all five: `@huggingface/transformers` acts on
// neither `top_p` nor a seed, so both stay refused.

Test('carries a control the model honours through to the cluster, untranslated', () => {
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages: [{ role: 'user', content: 'hello' }], temperature: 0, max_completion_tokens: 20, stop: ['\nUser:'] }, 'llm_llama3_2_1b_full'),
		{
			temperature: 0,
			maximumOutputTokenCount: 20,
			stopSequences: ['\nUser:'],
		},
	);
	// `stop` is one piece of text or a list of them on this interface, and one piece of text
	// becomes a list of one rather than being carried as text.
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages: [{ role: 'user', content: 'hello' }], stop: '\nUser:' }, 'llm_llama3_2_1b_full'),
		{
			stopSequences: ['\nUser:'],
		},
	);
	// `max_completion_tokens` is the newer spelling, and wins when a request sends both.
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 20, max_tokens: 99 }, 'llm_llama3_2_1b_full'),
		{
			maximumOutputTokenCount: 20,
		},
	);
});

Test('still refuses the two controls the model cannot honour, while honouring the three it can', () => {
	// Both models run on `@huggingface/transformers`, which acts on neither `top_p` nor a seed, so
	// both refuse exactly those two and honour exactly the other three.
	for (const model of ['llm_llama3_2_1b_full', 'llm_qwen3_5_0_8b_full'] as const) {
		for (const [field, value] of [['top_p', 0.9], ['seed', 42]] as const) {
			const refusal = refusalOf({ model, messages: [{ role: 'user', content: 'hello' }], [field]: value }, model);
			Assert.equal(refusal.status, 400);
			Assert.equal(refusal.code, 'unhonourable_generation_control');
			Assert.equal(refusal.param, field);
			// The refusal names what this model does honour, so the sender learns what to send
			// instead rather than only what not to send.
			Assert.match(refusal.message, /temperature, max_completion_tokens, stop/);
		}
		Assert.deepEqual(
			generationSettingsOf({ model, messages: [{ role: 'user', content: 'hello' }], temperature: 0, max_completion_tokens: 20, stop: ['\nUser:'] }, model),
			{
				temperature: 0,
				maximumOutputTokenCount: 20,
				stopSequences: ['\nUser:'],
			},
		);
	}
});

Test('carries reasoning_effort for the one model that thinks, and refuses it for the one that does not', () => {
	// `llm_qwen3_5_0_8b_full` is the only model here that thinks before it answers on both of its
	// workers, and the only one that honours this control. Both seams were proved live by the gates
	// of [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192): `reasoning_effort`
	// on the request to LM Studio 0.4.20, and `enable_thinking` on the chat template in a real
	// browser tab.
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'none' }, 'llm_qwen3_5_0_8b_full'),
		{
			reasoningEffort: 'none',
		},
	);
	// Every level is carried untranslated, including the ones the worker browser tab can only read
	// as "think at all". Reading a level coarsely is that stage helper's business, not this one's.
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'xhigh' }, 'llm_qwen3_5_0_8b_full'),
		{
			reasoningEffort: 'xhigh',
		},
	);
	// `llama-3.2-1b-instruct` never thought, so there is no thinking to budget, and asking for one
	// is refused rather than accepted and dropped.
	const refusal = refusalOf({ model: 'llm_llama3_2_1b_full', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'none' }, 'llm_llama3_2_1b_full');
	Assert.equal(refusal.status, 400);
	Assert.equal(refusal.code, 'unhonourable_generation_control');
	Assert.equal(refusal.param, 'reasoning_effort');
});

Test('reads reasoning_effort as something asked for at every level, having no default of its own', () => {
	// `temperature: 1` and `top_p: 1` are this interface's own defaults and ask for nothing.
	// `reasoning_effort` has no such default, so `"none"` is a request not to think rather than a way
	// of saying nothing, and a model that cannot honour it is refused for it.
	Assert.equal(refusalOf({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'none' }, 'llm_gemma_nano_chrome_full').param, 'reasoning_effort');
	// `null` still says the client holds no value, exactly as it does for the other five.
	Assert.equal(generationSettingsOf({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: null }, 'llm_gemma_nano_chrome_full'), undefined);
});

Test('carries all five controls for the one model that honours all five', () => {
	// `llm_qwen3_0_6b_sharded` is the only model here whose sampler is written by hand, and the only
	// one whose `top_p` and `seed` do anything. Proved live in a real browser tab by the de-risk gate
	// of [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196).
	Assert.deepEqual(
		generationSettingsOf({ model: 'llm_qwen3_0_6b_sharded', messages: [{ role: 'user', content: 'hello' }], temperature: 0.7, top_p: 0.5, max_completion_tokens: 20, stop: ['\nUser:'], seed: 42 }, 'llm_qwen3_0_6b_sharded'),
		{
			temperature: 0.7,
			topP: 0.5,
			maximumOutputTokenCount: 20,
			stopSequences: ['\nUser:'],
			randomSeed: 42,
		},
	);
});

Test('submits no settings block at all for a request that asked for nothing', () => {
	Assert.equal(generationSettingsOf({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }] }, 'llm_gemma_nano_chrome_full'), undefined);
	// This interface's own defaults are `1` for both `temperature` and `top_p`, an empty `stop`
	// names no text to stop at, and `null` says a client holds no value. None of the four asks a
	// model for anything, so none of the four is refused by a model that honours nothing.
	Assert.equal(generationSettingsOf({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }], temperature: 1, top_p: 1, stop: [], seed: null }, 'llm_gemma_nano_chrome_full'), undefined);
	// A model that does honour controls is asked for nothing by those same defaults either.
	Assert.equal(generationSettingsOf({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'hello' }], temperature: 1, top_p: 1, stop: [], seed: null }, 'llm_qwen3_5_0_8b_full'), undefined);
});

/**
 * Runs {@link generationSettingsOf} and returns the refusal it raised.
 *
 * @param body The request body a client would send.
 * @param taskTypeName The task type the request's model names.
 * @returns The refusal, so the test can read its status, code, and field.
 * @throws If the request was accepted rather than refused.
 */
const refusalOf = (body: Record<string, unknown>, taskTypeName: TaskTypeName): OpenaiError => {
	try {
		generationSettingsOf(body, taskTypeName);
	} catch (error: unknown) {
		if (error instanceof OpenaiError) {
			return error;
		}
		throw error;
	}
	throw new Error('The request was accepted, where it should have been refused.');
};

Test('refuses a generation control the model named cannot honour, rather than dropping it', () => {
	// Every control is refused by `llm_gemma_nano_chrome_full`, the one model here whose engine no
	// de-risk gate could reach, so nothing about it is claimed rather than observed.
	for (const [field, value] of [['temperature', 0], ['top_p', 0.9], ['max_tokens', 20], ['stop', ['\nUser:']], ['seed', 42]] as const) {
		const refusal = refusalOf({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'hello' }], [field]: value }, 'llm_gemma_nano_chrome_full');
		Assert.equal(refusal.status, 400);
		Assert.equal(refusal.code, 'unhonourable_generation_control');
		// `max_tokens` is refused under the newer name of the same control, which is the name the
		// sender should use when it sends the request again.
		Assert.equal(refusal.param, field === 'max_tokens' ? 'max_completion_tokens' : field);
		Assert.match(refusal.message, /honours are none/);
	}
	// The refusal names the model and the control in words, so the sender learns what went wrong
	// without having to read a code.
	Assert.match(refusalOf({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }], seed: 42 }, 'dev_formula').message, /The model dev_formula cannot honour seed/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Models On Offer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('offers one model for each task type the cluster runs', () => {
	Assert.deepEqual(ModelCatalog.modelIds, ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full', 'llm_qwen3_5_0_8b_full', 'llm_llama3_2_1b_full', 'llm_gemma_4_e2b_full']);
	Assert.equal(ModelCatalog.taskTypeNameOf('dev_formula'), 'dev_formula');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_qwen3_0_6b_sharded'), 'llm_qwen3_0_6b_sharded');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_gemma_nano_chrome_full'), 'llm_gemma_nano_chrome_full');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_qwen3_5_0_8b_full'), 'llm_qwen3_5_0_8b_full');
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_llama3_2_1b_full'), 'llm_llama3_2_1b_full');
	// This one is here without `model_catalog.ts` having been touched: `ModelCatalog.modelIds` is
	// `taskTypeNames` itself, so a task type added in `@webai/consumer-cli` reaches `GET /v1/models`
	// and the check on a request's `model` field at the same moment, and the two cannot drift apart.
	Assert.equal(ModelCatalog.taskTypeNameOf('llm_gemma_4_e2b_full'), 'llm_gemma_4_e2b_full');
	// The task type name itself is not a model identifier, and neither is a name nobody offers.
	Assert.equal(ModelCatalog.taskTypeNameOf('task_type_dev_formula'), undefined);
	Assert.equal(ModelCatalog.taskTypeNameOf('gpt-4o'), undefined);
});

Test('lists the models in the shape an OpenAI client reads', () => {
	const list = ModelCatalog.list(1_700_000_000);
	Assert.equal(list.object, 'list');
	Assert.equal(list.data.length, 6);
	Assert.deepEqual(list.data[0], { id: 'dev_formula', object: 'model', created: 1_700_000_000, owned_by: 'webai-at-home' });
});

// `GET /v1/models` lists what the cluster can run right now, not the whole catalogue: a model
// nobody is connected to run is a model every request for would be given up on. See issue #177.
Test('lists only the models it is given, so a task type with no worker behind it is left out', () => {
	const list = ModelCatalog.list(1_700_000_000, ['dev_formula', 'llm_llama3_2_1b_full']);
	Assert.equal(list.data.length, 2);
	Assert.deepEqual(list.data.map((model) => model.id), ['dev_formula', 'llm_llama3_2_1b_full']);
	// Nobody connected at all is an empty list, which is a legal answer an OpenAI client reads.
	Assert.deepEqual(ModelCatalog.list(1_700_000_000, []).data, []);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Failures
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('answers each kind of failure with the status an OpenAI client expects', () => {
	Assert.equal(OpenaiError.invalidRequest('bad body').status, 400);
	Assert.equal(OpenaiError.unusableMessages('not a number').status, 400);
	Assert.equal(OpenaiError.authenticationFailed().status, 401);
	Assert.equal(OpenaiError.unknownModel('gpt-4o', ModelCatalog.modelIds).status, 404);
	Assert.equal(OpenaiError.tooManyTasksInFlight(20).status, 429);
	Assert.equal(OpenaiError.gatewayRateLimited('too many').status, 429);
	Assert.equal(OpenaiError.taskFailed('a stage failed').status, 502);
	Assert.equal(OpenaiError.answerUnreadable('task_type_dev_formula').status, 502);
	Assert.equal(OpenaiError.unexpected().status, 500);
	Assert.equal(OpenaiError.gatewayUnavailable('not connected').status, 503);
	Assert.equal(OpenaiError.noVolunteerAvailable('dev_formula').status, 503);
	Assert.equal(OpenaiError.modelHasNoConnectedWorker('dev_formula', ['stage_dev_formula_add']).status, 503);
	Assert.equal(OpenaiError.requestTimedOut(600_000).status, 504);
});

Test('names the field at fault and the failure kind in the body', () => {
	const unknownModel = OpenaiError.unknownModel('gpt-4o', ModelCatalog.modelIds).body;
	Assert.equal(unknownModel.error.param, 'model');
	Assert.equal(unknownModel.error.code, 'model_not_found');
	// Every model on offer is named, so the caller can correct the request without asking.
	Assert.match(unknownModel.error.message, /dev_formula, llm_qwen3_0_6b_sharded, llm_gemma_nano_chrome_full, llm_qwen3_5_0_8b_full, llm_llama3_2_1b_full/);
	// `param` and `code` are always present, holding null when they say nothing.
	const rateLimited = OpenaiError.tooManyTasksInFlight(20).body;
	Assert.equal(rateLimited.error.type, 'rate_limit_error');
	Assert.equal(rateLimited.error.param, null);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Translating A Stop Reason Into An OpenAI Value
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('translates a worker\'s own stop reason into the OpenAI value under Rule 2 of issue #150', () => {
	Assert.equal(FinishReasonTranslator.translate(undefined), 'stop');
	Assert.equal(FinishReasonTranslator.translate('end_of_sequence'), 'stop');
	Assert.equal(FinishReasonTranslator.translate('max_new_tokens'), 'length');
	// There is no OpenAI value for an answer the cluster gave up on producing, so it is refused
	// rather than invented.
	Assert.throws(() => FinishReasonTranslator.translate('interrupted'), OpenaiError);
});

Test('reports an answer that ended on a consumer\'s stop sequence as stop, never as length', () => {
	// A stop sequence stops generation the same way a cancelled task does, and the two mean
	// opposite things to the consumer: one is a finished answer, the other is an abandoned one.
	// Before `stop_sequence` existed, such an answer was reported as `interrupted` and refused
	// with HTTP 502, which is what the de-risk gate of step 2 of issue #196 observed live.
	Assert.equal(FinishReasonTranslator.translate('stop_sequence'), 'stop');
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Running A Cluster Task
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One frame sent by the runner, as the gateway would receive it. */
type SentFrame = { v: number; id: string; ts: string; body: Record<string, unknown> };

/** A stand-in connection, and the runner that speaks to the gateway through it. */
type StandInCluster = {
	runner: ClusterTaskRunner;
	socket: TaskSocket;
	/** Every frame the runner sent, most recent last. */
	sentFrames: () => SentFrame[];
	/** The body of the most recent frame the runner sent. */
	lastSentBody: () => Record<string, unknown>;
	/** Hands the runner one message, wrapped the way the gateway wraps it. */
	receive: (body: unknown) => void;
};

/** Lets every already-scheduled promise settle before the test looks at the result. */
const settlePromises = async (): Promise<void> => await new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Waits until a condition becomes true, checking again after each macrotask.
 *
 * A request sent over a real HTTP connection, unlike the stand-in `TaskSocket` used
 * elsewhere in this file, reaches this process through the network stack rather than
 * synchronously, so a single `settlePromises` does not reliably wait long enough for it to
 * have been read and turned into a `task.submit` frame.
 *
 * @param condition Checked repeatedly until it returns `true`.
 * @throws Error when the condition has not become true after 1 second.
 */
const waitUntil = async (condition: () => boolean): Promise<void> => {
	const deadline = Date.now() + 1_000;
	while (condition() === false) {
		if (Date.now() > deadline) throw new Error('Condition did not become true in time');
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
};

/**
 * Builds a runner whose connection is a stand-in the test drives itself, and takes it as far
 * as being registered, which is the state a request needs it in.
 *
 * @param overrides Options to use instead of the defaults.
 * @returns The runner, its stand-in connection, and the means to read and feed messages.
 */
const registeredStandInCluster = async (overrides: Partial<ClusterTaskRunnerOptions> = {}): Promise<StandInCluster> => {
	const sent: string[] = [];
	const socket: TaskSocket = {
		readyState: 1,
		OPEN: 1,
		send: (data) => sent.push(data),
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	const sentFrames = (): SentFrame[] => sent.map((raw) => JSON.parse(raw) as SentFrame);
	const receive = (body: unknown): void => {
		socket.onmessage?.({ data: JSON.stringify({ v: protocolVersion, id: `message-${sent.length}`, ts: new Date().toISOString(), body }) });
	};
	const runner = new ClusterTaskRunner({
		gatewayUrl: 'ws://stand-in',
		authToken: 'development-token',
		name: 'consumer_openai server',
		requestTimeoutMs: 60_000,
		connectionWaitMs: 50,
		maximumTasksInFlight: 20,
		...overrides,
	}, () => socket);
	socket.onopen?.();
	// One hour ahead, which is what the gateway's own --session-ms defaults to. A far-future
	// expiry would ask Node for a timer longer than it can hold.
	const sessionExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
	receive({ type: 'deviceAuthenticated', authIdentity: 'authIdentity-development', expiresAt: sessionExpiresAt });
	receive({ type: 'deviceRegistered', deviceId: 'device-openai-1' });
	await settlePromises();
	return { runner, socket, sentFrames, lastSentBody: () => sentFrames()[sent.length - 1]?.body ?? {}, receive };
};

Test('submits one task per request and answers with the text it generated', async () => {
	const cluster = await registeredStandInCluster();
	Assert.equal(cluster.runner.isGatewayConnected, true);

	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const submitted = cluster.lastSentBody();
	Assert.equal(submitted['type'], 'task.submit');
	Assert.deepEqual(submitted['input'], { taskType: 'task_type_dev_formula', input: 5 });
	const taskRequestId = submitted['taskRequestId'];
	Assert.equal(typeof taskRequestId, 'string');
	Assert.equal(cluster.runner.tasksInFlight, 1);

	// The accepted task carries back the identifier the submission was sent under, which is what
	// joins every later revision of that task to this request.
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-1', taskRequestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-1', taskRevision: 3, state: 'running', completedStageCount: 1, currentStageAttempts: 1 } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-1', taskRevision: 4, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: 17 } });

	// A development formula task carries a plain number, so its answer is that number written out.
	Assert.equal((await answer).text, '17');
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('answers with the generated text of a language-model task', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_llm_gemma_nano_chrome_full', input: 'What is the capital of France?' }, 'llm_gemma_nano_chrome_full');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-2', taskRequestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-2', taskRevision: 9, state: 'completed', completedStageCount: 4, currentStageAttempts: 0, result: { text: 'Paris is the capital of France.', done: true } } });
	Assert.equal((await answer).text, 'Paris is the capital of France.');
	cluster.runner.close();
});

Test('carries the usage and stop reason a worker reports on its result', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: 'What is the capital of France?' }, 'llm_qwen3_5_0_8b_full');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-usage-1', taskRequestId, state: 'queued' } });
	cluster.receive({
		type: 'task.updated',
		update: {
			taskId: 'task-usage-1',
			taskRevision: 2,
			state: 'completed',
			completedStageCount: 1,
			currentStageAttempts: 0,
			result: { text: 'Paris.', done: true, promptTokenCount: 8, completionTokenCount: 3, stopReason: 'end_of_sequence' },
		},
	});
	const resolved = await answer;
	Assert.equal(resolved.text, 'Paris.');
	Assert.equal(resolved.promptTokenCount, 8);
	Assert.equal(resolved.completionTokenCount, 3);
	Assert.equal(resolved.stopReason, 'end_of_sequence');
	cluster.runner.close();
});

Test('reports that no volunteer browser offered the work when the task waited too long', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-3', taskRequestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-3', taskRevision: 2, state: 'failed', completedStageCount: 0, currentStageAttempts: 0, error: 'SUBMISSION_DEADLINE_EXPIRED' } });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(failure.code, 'no_volunteer_available');
	Assert.match(failure.message, /dev_formula/);
	cluster.runner.close();
});

Test('reports a task the cluster ran and failed as a fault of the cluster', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-4', taskRequestId, state: 'queued' } });
	cluster.receive({ type: 'task.updated', update: { taskId: 'task-4', taskRevision: 5, state: 'failed', completedStageCount: 1, currentStageAttempts: 3, error: 'the assignment attempts were used up' } });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 502);
	Assert.match(failure.message, /the assignment attempts were used up/);
	cluster.runner.close();
});

Test('passes on the gateway refusing a submission it has no room for', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'error', code: 'RATE_LIMITED', message: 'The authIdentity has reached its active-task limit', taskRequestId, retryable: true });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 429);
	cluster.runner.close();
});

Test('names the model and the stages nobody runs when the gateway refuses the task for want of a worker', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_llm_qwen3_5_0_8b_full', input: { prompt: 'What is the capital of France?' } }, 'llm_qwen3_5_0_8b_full');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({
		type: 'error', code: 'CAPACITY_EXHAUSTED', message: 'One or more stages this task requires have no connected worker',
		taskRequestId, retryable: true, details: { missingStageNames: ['stage_llm_qwen3_5_0_8b_full'] },
	});
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(failure.code, 'model_has_no_connected_worker');
	// The model asked for and the stage nobody runs are both named, which is what the gateway's
	// own "one or more stages this task requires" sentence leaves out.
	Assert.match(failure.message, /llm_qwen3_5_0_8b_full/);
	Assert.match(failure.message, /stage_llm_qwen3_5_0_8b_full/);
	cluster.runner.close();
});

Test('still names the model when the gateway sends no list of stages nobody runs', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	// An older gateway sends the code and no details at all, which must not cost the caller the
	// model name as well.
	cluster.receive({ type: 'error', code: 'CAPACITY_EXHAUSTED', message: 'One or more stages this task requires have no connected worker', taskRequestId, retryable: true });
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.match(failure.message, /dev_formula/);
	Assert.match(failure.message, /one or more of the stages it needs/);
	cluster.runner.close();
});

Test('gives up on every request still waiting when the connection is lost', async () => {
	const cluster = await registeredStandInCluster();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	cluster.socket.onclose?.();
	const failure = await answer.then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(cluster.runner.isGatewayConnected, false);
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('cancels the task when whoever sent the request goes away', async () => {
	const cluster = await registeredStandInCluster();
	const abortController = new AbortController();
	const answer = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula', abortController.signal);
	await settlePromises();
	const taskRequestId = cluster.lastSentBody()['taskRequestId'];
	cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-5', taskRequestId, state: 'queued' } });
	abortController.abort();
	const cancelled = cluster.lastSentBody();
	Assert.equal(cancelled['type'], 'task.cancel');
	Assert.equal(cancelled['taskId'], 'task-5');
	await answer.then(() => undefined, () => undefined);
	Assert.equal(cluster.runner.tasksInFlight, 0);
	cluster.runner.close();
});

Test('refuses a request that arrives while the gateway is not connected, rather than holding it', async () => {
	const socket: TaskSocket = {
		readyState: 0,
		OPEN: 1,
		send: () => undefined,
		close: () => undefined,
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
	};
	const runner = new ClusterTaskRunner({
		gatewayUrl: 'ws://stand-in',
		authToken: 'development-token',
		name: 'consumer_openai server',
		requestTimeoutMs: 60_000,
		connectionWaitMs: 20,
		maximumTasksInFlight: 20,
	}, () => socket);
	const failure = await runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula').then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 503);
	Assert.equal(failure.code, 'gateway_unavailable');
	runner.close();
});

Test('holds no more tasks in flight than it was told to', async () => {
	const cluster = await registeredStandInCluster({ maximumTasksInFlight: 1 });
	const first = cluster.runner.run({ taskType: 'task_type_dev_formula', input: 5 }, 'dev_formula');
	await settlePromises();
	const failure = await cluster.runner.run({ taskType: 'task_type_dev_formula', input: 6 }, 'dev_formula').then(() => undefined, (error: unknown) => error);
	Assert.ok(failure instanceof OpenaiError);
	Assert.equal(failure.status, 429);
	Assert.equal(failure.code, 'too_many_tasks_in_flight');
	cluster.runner.close();
	await first.then(() => undefined, () => undefined);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Streaming And Tool Support, Through The Full Request Flow
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The line `CurlStyleTransactionLogger` prints between one transaction and the next. */
const transactionSeparator = '='.repeat(50);

/**
 * Reads one field this logger prints outside the `>`/`<` blocks, such as `Outcome: completed`.
 *
 * @param block One transaction's text, as read back from the log file.
 * @param name The field's name, as printed before its colon.
 * @returns The field's value, or `undefined` when the block does not print it.
 */
const fieldOf = (block: string, name: string): string | undefined => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1];

/**
 * Starts the actual Express routes on an ephemeral port, in front of a stand-in gateway
 * connection, so a test can send it a real HTTP request the way an OpenAI client would.
 *
 * @param overrides Cluster task runner options to use instead of the defaults.
 * @param apiKey The key the routes require, when a test needs to exercise the key check.
 * @returns The stand-in cluster to drive the gateway side, `url` to send requests to, and
 * `transactions` to read the text blocks written to this run's transaction log once the
 * response each one describes has closed.
 */
const listeningServer = async (overrides: Partial<ClusterTaskRunnerOptions> = {}, apiKey?: string): Promise<{ cluster: Awaited<ReturnType<typeof registeredStandInCluster>>; url: string; close: () => void; transactions: () => string[] }> => {
	const cluster = await registeredStandInCluster(overrides);
	const logDirectoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(logDirectoryPath, 'transactions.log_http.txt');
	const transactionLogger = new CurlStyleTransactionLogger(logFilePath);
	// The models route asks the central gateway which models the connected workers can run, which
	// this stand-in has no observer connection for; no test here sends a request to that route.
	const routes = new OpenaiRoutes(cluster.runner, apiKey, Math.floor(Date.now() / 1000), transactionLogger, 'test-commit-sha', {
		gatewayUrl: 'ws://127.0.0.1:1',
		authToken: 'development-token',
		timeoutMs: 1000,
	});
	const app = Express();
	app.use(routes.router());
	const httpServer = app.listen(0);
	await new Promise<void>((resolve) => httpServer.once('listening', resolve));
	const address = httpServer.address();
	if (address === null || typeof address === 'string') throw new Error('Expected the stand-in server to listen on a TCP port');
	const transactions = (): string[] => (Fs.existsSync(logFilePath) ? Fs.readFileSync(logFilePath, 'utf8').split(transactionSeparator).map((block) => block.trim()).filter((block) => block.length > 0) : []);
	return {
		cluster,
		url: `http://127.0.0.1:${address.port}`,
		close: () => {
			httpServer.close();
			Fs.rmSync(logDirectoryPath, { recursive: true, force: true });
		},
		transactions,
	};
};

/**
 * Reads a server-sent event stream to its end and returns the `data:` lines it carried.
 *
 * @param response The streamed response.
 * @returns Each `data:` line's text, in the order it arrived, including the closing `[DONE]`.
 */
const streamedDataLines = async (response: Response): Promise<string[]> => {
	const text = await response.text();
	return text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice('data: '.length));
};

Test('answers a streamed request as the answer is written, and asks the cluster for the pieces', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});

		// Asking for a stream is what makes the cluster report pieces at all, so the submission
		// has to carry that request. Without it the task would be answered in one piece and this
		// server would have nothing to send until the answer was finished.
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const submitted = server.cluster.lastSentBody();
		Assert.deepEqual((submitted['input'] as { generationSettings: unknown }).generationSettings, { isStreaming: true });
		const taskRequestId = submitted['taskRequestId'] as string;

		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-stream-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-stream-1', taskRevision: 2, state: 'running', completedStageCount: 1, currentStageAttempts: 1, newText: 'The ' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-stream-1', taskRevision: 3, state: 'running', completedStageCount: 2, currentStageAttempts: 1, newText: 'capital.' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-stream-1', taskRevision: 4, state: 'completed', completedStageCount: 3, currentStageAttempts: 0, result: { text: 'The capital.', done: true } } });

		const response = await responsePromise;
		Assert.equal(response.status, 200);
		Assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
		// The total generation time is not known when a streamed response's headers must be
		// sent, so this header carries the one generation-time fact that is: how long the
		// cluster took to produce the first piece.
		Assert.match(response.headers.get('x-webai-time-to-first-piece-ms') ?? '', /^\d+$/);

		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as { object: string; id: string; choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[] });
		// Every chunk says what it is and belongs to the same answer, which is how a reader tells
		// one answer's chunks from another's.
		Assert.deepEqual([...new Set(chunks.map((chunk) => chunk.object))], ['chat.completion.chunk']);
		Assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, 1);
		// The role is stated once, before any text; the answer stops once, after all of it.
		Assert.deepEqual(chunks.map((chunk) => chunk.choices[0]?.delta.role ?? null), ['assistant', null, null, null]);
		Assert.deepEqual(chunks.map((chunk) => chunk.choices[0]?.finish_reason ?? null), [null, null, null, 'stop']);
		// Joining the pieces gives the answer, which is the whole point of sending them.
		Assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join(''), 'The capital.');
	} finally {
		server.close();
	}
});

Test('sends a final usage chunk after the finish_reason chunk when the request asks for it, with usage: null on every chunk before it', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_qwen3_5_0_8b_full',
				messages: [{ role: 'user', content: 'What is the capital of France?' }],
				stream: true,
				stream_options: { include_usage: true },
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-stream-usage-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-stream-usage-1', taskRevision: 2, state: 'running', completedStageCount: 1, currentStageAttempts: 1, newText: 'Paris.' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-stream-usage-1',
				taskRevision: 3,
				state: 'completed',
				completedStageCount: 2,
				currentStageAttempts: 0,
				result: { text: 'Paris.', done: true, promptTokenCount: 8, completionTokenCount: 3, stopReason: 'end_of_sequence' },
			},
		});

		const response = await responsePromise;
		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const chunks = lines.slice(0, -1).map(
			(line) => JSON.parse(line) as { choices: { finish_reason: string | null }[]; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null },
		);
		// Every chunk before the last carries one choice and `usage: null`.
		Assert.deepEqual(chunks.slice(0, -1).map((chunk) => chunk.usage), chunks.slice(0, -1).map(() => null));
		Assert.deepEqual(chunks.slice(0, -1).map((chunk) => chunk.choices.length), chunks.slice(0, -1).map(() => 1));
		// The finish_reason chunk is the one right before the usage chunk.
		Assert.equal(chunks.at(-2)?.choices[0]?.finish_reason, 'stop');
		// The final chunk carries the usage object and no choices at all.
		const usageChunk = chunks.at(-1);
		Assert.deepEqual(usageChunk?.choices, []);
		Assert.deepEqual(usageChunk?.usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
	} finally {
		server.close();
	}
});

Test('sends no final usage chunk when the request does not ask for one, even though the worker reported usage', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-stream-nousage-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-stream-nousage-1',
				taskRevision: 2,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				result: { text: 'Paris.', done: true, promptTokenCount: 8, completionTokenCount: 3, stopReason: 'end_of_sequence' },
			},
		});

		const response = await responsePromise;
		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as { choices: { finish_reason: string | null }[] });
		// The finish_reason chunk is the last answer chunk sent; nothing follows it but [DONE].
		Assert.equal(chunks.at(-1)?.choices[0]?.finish_reason, 'stop');
	} finally {
		server.close();
	}
});

Test('a request that asks for no stream asks the cluster for no pieces, and is answered in one piece', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'What is the capital of France?' }] }),
		});

		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const submitted = server.cluster.lastSentBody();
		// The submission is exactly what it was before pieces existed: no settings field at all.
		Assert.equal('generationSettings' in (submitted['input'] as object), false);
		const taskRequestId = submitted['taskRequestId'] as string;

		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-whole-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-whole-1', taskRevision: 2, state: 'completed', completedStageCount: 1, currentStageAttempts: 0, result: { text: 'The capital.', done: true } } });

		const response = await responsePromise;
		Assert.equal(response.status, 200);
		Assert.match(response.headers.get('content-type') ?? '', /application\/json/);
		// The whole answer is ready before this response's headers are sent, so this header can
		// carry the total time the cluster spent generating it, under Rule 3 of this project's
		// OpenAI compatibility requirement.
		Assert.match(response.headers.get('x-webai-generation-time-ms') ?? '', /^\d+$/);
		const body = await response.json() as { object: string; choices: { message: { content: string } }[] };
		Assert.equal(body.object, 'chat.completion');
		Assert.equal(body.choices[0]?.message.content, 'The capital.');
	} finally {
		server.close();
	}
});

Test('a streamed answer whose task reported no pieces is still sent, rather than arriving empty', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});

		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'] as string;
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-nopieces-1', taskRequestId, state: 'queued' } });
		// A worker built before pieces existed produces its whole answer in one run and reports
		// none, so the answer has to be sent as one piece rather than the caller being told it
		// was empty.
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-nopieces-1', taskRevision: 2, state: 'completed', completedStageCount: 1, currentStageAttempts: 0, result: { text: 'The capital.', done: true } } });

		const lines = await streamedDataLines(await responsePromise);
		const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as { choices: { delta: { content?: string } }[] });
		Assert.equal(chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join(''), 'The capital.');
		Assert.equal(lines.at(-1), '[DONE]');
	} finally {
		server.close();
	}
});

Test('a failure after the stream has begun is written into the stream, since the status is already gone', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});

		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'] as string;
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-fail-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-fail-1', taskRevision: 2, state: 'running', completedStageCount: 1, currentStageAttempts: 1, newText: 'The ' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-fail-1', taskRevision: 3, state: 'failed', completedStageCount: 1, currentStageAttempts: 1, error: 'a stage failed' } });

		const response = await responsePromise;
		// The answer began, so the status says the answer began. There is no way to take that back.
		Assert.equal(response.status, 200);
		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const last = JSON.parse(lines.at(-2)!) as { error?: { message: string } };
		Assert.equal(last.error === undefined, false);
		Assert.match(last.error!.message, /a stage failed/);
	} finally {
		server.close();
	}
});

Test('refuses tool declarations sent to a model that cannot read them, rather than dropping them', async () => {
	const server = await listeningServer();
	try {
		// Accepting these and answering as though nothing had been declared is the worst of the
		// possible answers: the caller would wait for a tool call that was never going to come, and
		// would be told nothing went wrong. This is the same refusal an unhonourable generation
		// control gets, for the same reason.
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'dev_formula',
				messages: [{ role: 'user', content: '5' }],
				tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
			}),
		});
		Assert.equal(response.status, 400);
		const body = await response.json() as { error: { code: string; param: string } };
		Assert.equal(body.error.code, 'unsupported_tool_declarations');
		Assert.equal(body.error.param, 'tools');
	} finally {
		server.close();
	}
});

Test('refuses a tool_choice it cannot enforce, which is the failure that closed issue #78', async () => {
	const server = await listeningServer();
	try {
		// The de-risk gate of issue #78 failed on exactly this shape: a server accepted
		// tool_choice "required", did not enforce it, and the model's answering in words read as
		// "this model cannot call tools" when nothing had ever made it try. Refusing is what stops
		// this server from producing that same false finding for someone else.
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_qwen3_5_0_8b_full',
				messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
				tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
				tool_choice: 'required',
			}),
		});
		Assert.equal(response.status, 400);
		const body = await response.json() as { error: { code: string; param: string } };
		Assert.equal(body.error.code, 'unenforceable_tool_choice');
		Assert.equal(body.error.param, 'tool_choice');
	} finally {
		server.close();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Response Format Of A Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// No task type produces a shape today, measured by the milestone 0 gate of
// [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191): the one engine in reach
// that honours `json_schema` is a local server behind `@webai/worker-openai`, and the worker browser
// tab that can serve the same task type generates through `@huggingface/transformers`, which offers
// no way to ask for a schema at all. A task type's contract is the intersection of what all of its
// workers honour, so every entry of `StructuredOutputSupport` is empty and every shape is refused.

Test('reads the three response_format values this interface defines, and refuses a shape it does not', () => {
	const messages = [{ role: 'user', content: 'hello' }];
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages, response_format: { type: 'text' } }).success, true);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages, response_format: { type: 'json_object' } }).success, true);
	Assert.equal(ChatCompletionRequestSchema.safeParse({
		model: 'dev_formula',
		messages,
		response_format: { type: 'json_schema', json_schema: { name: 'greeting_object', strict: true, schema: { type: 'object', properties: { greeting: { type: 'string' } } } } },
	}).success, true);
	// A client holding no value for the field commonly sends it as `null` rather than leaving it
	// out, and both mean the same thing.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages, response_format: null }).success, true);
	// A type this interface does not define is refused by the schema, and so is a `json_schema`
	// carrying no schema block at all.
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages, response_format: { type: 'yaml' } }).success, false);
	Assert.equal(ChatCompletionRequestSchema.safeParse({ model: 'dev_formula', messages, response_format: { type: 'json_schema' } }).success, false);
});

Test('asks for nothing when the request asks for this interface own default shape', () => {
	const messages = [{ role: 'user', content: 'hello' }];
	// All three of an absent field, a `null` field, and `text` mean the same thing: nothing unusual
	// was asked for. A client that always sends `response_format: { "type": "text" }` must be
	// answered, not refused.
	for (const body of [
		{ model: 'llm_llama3_2_1b_full', messages },
		{ model: 'llm_llama3_2_1b_full', messages, response_format: null },
		{ model: 'llm_llama3_2_1b_full', messages, response_format: { type: 'text' } },
	]) {
		Assert.equal(ResponseFormatReader.read(ChatCompletionRequestSchema.parse(body), 'llm_llama3_2_1b_full'), undefined);
	}
});

Test('carries a response format the task type honours, in the same block the controls travel in', () => {
	// Milestone 2 of [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) wrote
	// this path, and until then `ResponseFormatReader.read` refused what could not be produced and
	// its caller threw away what it returned. The builder is given the shape rather than reading it,
	// because a response format is refused against `StructuredOutputSupport` and a generation
	// control against `GenerationControlSupport`, and the two tables are separate.
	const messages = [{ role: 'user', content: 'Reply with a greeting object.' }];
	const parsed = ChatCompletionRequestSchema.parse({ model: 'llm_llama3_2_1b_full', messages, temperature: 0 });

	Assert.deepEqual(GenerationSettingsBuilder.build(parsed, 'llm_llama3_2_1b_full', false, 'json_object'), {
		temperature: 0,
		responseFormat: 'json_object',
	});
	Assert.deepEqual(GenerationSettingsBuilder.build(parsed, 'llm_llama3_2_1b_full', true, 'json_schema'), {
		isStreaming: true,
		temperature: 0,
		responseFormat: 'json_schema',
	});
});

Test('submits no settings block at all for a request that asked for no shape and no control', () => {
	// The whole block stays absent rather than becoming an empty object, so a request written before
	// response formats existed submits byte for byte what it always did.
	const messages = [{ role: 'user', content: 'What is the capital of France?' }];

	Assert.equal(generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages }, 'llm_llama3_2_1b_full'), undefined);
	Assert.equal(generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages, response_format: { type: 'text' } }, 'llm_llama3_2_1b_full'), undefined);
	Assert.equal(generationSettingsOf({ model: 'llm_llama3_2_1b_full', messages, response_format: null }, 'llm_llama3_2_1b_full'), undefined);
});

Test('refuses a response_format the model cannot produce, rather than answering it in prose', async () => {
	const server = await listeningServer();
	try {
		// This is the defect issue #191 records: the field was accepted, dropped, and answered with
		// ordinary prose, so a caller that asked for JSON called `JSON.parse` on an English
		// sentence and was told nothing had gone wrong.
		for (const responseFormat of [
			{ type: 'json_object' },
			{ type: 'json_schema', json_schema: { name: 'greeting_object', strict: true, schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'], additionalProperties: false } } },
		]) {
			const response = await fetch(`${server.url}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					model: 'llm_llama3_2_1b_full',
					messages: [{ role: 'user', content: 'Reply with a greeting object whose greeting is "hello".' }],
					response_format: responseFormat,
				}),
			});
			Assert.equal(response.status, 400);
			const body = await response.json() as { error: { code: string; param: string; message: string } };
			Assert.equal(body.error.code, 'unhonourable_response_format');
			Assert.equal(body.error.param, 'response_format');
			// The refusal names the shape that was asked for and what this model does produce, so
			// the sender learns what to send instead rather than only what not to send.
			Assert.match(body.error.message, new RegExp(responseFormat.type));
			Assert.match(body.error.message, /text only/);
		}
	} finally {
		server.close();
	}
});

Test('declares the tools to a model that reads them, and answers a tool call with finish_reason tool_calls', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_qwen3_5_0_8b_full',
				messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
				tools: [{
					type: 'function',
					function: {
						name: 'get_current_weather',
						description: 'Reports the current weather in one city.',
						parameters: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } } },
					},
				}],
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const submitted = server.cluster.lastSentBody();
		const taskRequestId = submitted['taskRequestId'];
		// The declarations reach the cluster in this project's own naming, not the OpenAI spelling.
		Assert.deepEqual((submitted['input'] as { input: { tools: unknown } }).input.tools, [{
			name: 'get_current_weather',
			description: 'Reports the current weather in one city.',
			parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } } },
		}]);

		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-tools-2', taskRequestId, state: 'queued' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-tools-2',
				taskRevision: 2,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				result: { text: '', done: true, toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Paris', days: '3' } }] },
			},
		});

		const response = await responsePromise;
		Assert.equal(response.status, 200);
		const body = await response.json() as ChatCompletionResponse;
		Assert.equal(body.choices[0]?.finish_reason, 'tool_calls');
		// A model that asks for a tool writes no text, and the empty string says so, rather than null.
		Assert.equal(body.choices[0]?.message.content, '');
		const toolCall = body.choices[0]?.message.tool_calls?.[0];
		Assert.equal(toolCall?.function.name, 'get_current_weather');
		// The identifier is minted here, because no model this cluster runs generates one.
		Assert.match(String(toolCall?.id), /^call_/);
		// The worker reported both values as text, because the format the model writes carries no
		// types. `days` becomes a number here because the tool declared it as one, and `city` stays
		// text because it was declared as text.
		Assert.deepEqual(JSON.parse(String(toolCall?.function.arguments)), { city: 'Paris', days: 3 });
	} finally {
		server.close();
	}
});

Test('answers a streamed tool call with a tool_calls chunk and finish_reason tool_calls, rather than failing the task', async () => {
	// The failure this covers was found by running `openai_api_tool tool_calls` against a real
	// cluster: every streamed probe that ended in a tool call was answered `task_failed`, while the
	// same probe not streamed was answered correctly. A worker stops the moment a tool call is
	// complete, so it reports `interrupted`, and the streamed path translated that stop reason
	// instead of reading the tool calls beside it.
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_qwen3_5_0_8b_full',
				messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
				stream: true,
				tools: [{
					type: 'function',
					function: {
						name: 'get_current_weather',
						description: 'Reports the current weather in one city.',
						parameters: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } } },
					},
				}],
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];

		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-stream-tools-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-stream-tools-1',
				taskRevision: 2,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				// No piece was ever reported, and the stop reason is `interrupted`, which is exactly
				// what a real worker sends: a history that declared tools is generated whole, and
				// generation is stopped as soon as the closing marker of the tool call arrives.
				result: {
					text: '',
					done: true,
					stopReason: 'interrupted',
					toolCalls: [{ name: 'get_current_weather', argumentValues: { city: 'Paris', days: '3' } }],
				},
			},
		});

		const response = await responsePromise;
		Assert.equal(response.status, 200);
		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as {
			choices: {
				delta: {
					role?: string;
					tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string } }[];
				};
				finish_reason: string | null;
			}[];
		});
		// The role once, then the tool calls, then the reason the answer stopped.
		Assert.deepEqual(chunks.map((chunk) => chunk.choices[0]?.delta.role ?? null), ['assistant', null, null]);
		Assert.deepEqual(chunks.map((chunk) => chunk.choices[0]?.finish_reason ?? null), [null, null, 'tool_calls']);
		const toolCall = chunks[1]?.choices[0]?.delta.tool_calls?.[0];
		// The index says which tool call of the answer this is, since this interface allows a
		// tool call to arrive in pieces. This server never sends one in pieces.
		Assert.equal(toolCall?.index, 0);
		Assert.equal(toolCall?.type, 'function');
		Assert.equal(toolCall?.function.name, 'get_current_weather');
		Assert.match(String(toolCall?.id), /^call_/);
		// Typed the same way as in a whole answer: `days` becomes a number because the tool declared
		// it as one, and `city` stays text because it was declared as text.
		Assert.deepEqual(JSON.parse(String(toolCall?.function.arguments)), { city: 'Paris', days: 3 });
	} finally {
		server.close();
	}
});

Test('submits the real history for a model that accepts one, instead of a flattened transcript', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_qwen3_5_0_8b_full',
				messages: [
					{ role: 'system', content: 'Answer in one short sentence.' },
					{ role: 'user', content: 'What is the capital of France?' },
				],
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const submitted = server.cluster.lastSentBody();
		Assert.deepEqual(submitted['input'], {
			taskType: 'task_type_llm_qwen3_5_0_8b_full',
			input: {
				messages: [
					{ role: 'system', content: 'Answer in one short sentence.' },
					{ role: 'user', content: 'What is the capital of France?' },
				],
			},
		});
		const taskRequestId = submitted['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-history-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-history-1', taskRevision: 2, state: 'completed', completedStageCount: 1, currentStageAttempts: 0, result: { text: 'Paris.', done: true } } });
		Assert.equal((await responsePromise).status, 200);
	} finally {
		server.close();
	}
});

Test('reports usage and a translated finish_reason when the worker\'s result carries them', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'What is the capital of France?' }] }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-usage-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-usage-1',
				taskRevision: 2,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				result: { text: 'Paris.', done: true, promptTokenCount: 8, completionTokenCount: 3, stopReason: 'max_new_tokens' },
			},
		});
		const response = await responsePromise;
		Assert.equal(response.status, 200);
		const body = await response.json() as ChatCompletionResponse;
		Assert.equal(body.choices[0]?.finish_reason, 'length');
		Assert.deepEqual(body.usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
	} finally {
		server.close();
	}
});

Test('answers with no usage field when the worker reports no counts, exactly as before milestone 2 of issue #150', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-nousage-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-nousage-1', taskRevision: 2, state: 'completed', completedStageCount: 1, currentStageAttempts: 0, result: 17 } });
		const response = await responsePromise;
		const body = await response.json() as Record<string, unknown>;
		Assert.equal('usage' in body, false);
	} finally {
		server.close();
	}
});

Test('answers a whole-answer request with an error when the cluster gave up before finishing', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'What is the capital of France?' }] }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-interrupted-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-interrupted-1',
				taskRevision: 2,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				result: { text: 'Par', done: true, stopReason: 'interrupted' },
			},
		});
		const response = await responsePromise;
		Assert.equal(response.status, 502);
		const body = await response.json() as { error: { code: string | null } };
		Assert.equal(body.error.code, 'task_failed');
	} finally {
		server.close();
	}
});

Test('writes an error into a streamed answer when the cluster gave up before finishing', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_qwen3_5_0_8b_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-interrupted-stream-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-interrupted-stream-1', taskRevision: 2, state: 'running', completedStageCount: 1, currentStageAttempts: 1, newText: 'Par' } });
		server.cluster.receive({
			type: 'task.updated',
			update: {
				taskId: 'task-interrupted-stream-1',
				taskRevision: 3,
				state: 'completed',
				completedStageCount: 2,
				currentStageAttempts: 0,
				result: { text: 'Par', done: true, stopReason: 'interrupted' },
			},
		});
		const response = await responsePromise;
		Assert.equal(response.status, 200);
		const lines = await streamedDataLines(response);
		Assert.equal(lines.at(-1), '[DONE]');
		const last = JSON.parse(lines.at(-2)!) as { error?: { code: string | null } };
		Assert.equal(last.error?.code, 'task_failed');
	} finally {
		server.close();
	}
});

Test('still flattens the history for a model that only takes one prompt', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'llm_gemma_nano_chrome_full',
				messages: [
					{ role: 'system', content: 'Answer in one short sentence.' },
					{ role: 'user', content: 'What is the capital of France?' },
				],
			}),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const submitted = server.cluster.lastSentBody();
		Assert.deepEqual(submitted['input'], {
			taskType: 'task_type_llm_gemma_nano_chrome_full',
			input: 'system: Answer in one short sentence.\nuser: What is the capital of France?\nassistant:',
		});
		const taskRequestId = submitted['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-flatten-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-flatten-1', taskRevision: 2, state: 'completed', completedStageCount: 1, currentStageAttempts: 0, result: { text: 'Paris.', done: true } } });
		Assert.equal((await responsePromise).status, 200);
	} finally {
		server.close();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Auditing HTTP Transactions
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('never throws when the log directory cannot be created or the log cannot be written to, so a caller is always answered', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	// A file where a directory is expected, so both creating the log's parent directory and
	// appending to it fail every time.
	const blockingFilePath = Path.join(directoryPath, 'blocking-file');
	Fs.writeFileSync(blockingFilePath, 'not a directory');
	const logger = new CurlStyleTransactionLogger(Path.join(blockingFilePath, 'nested', 'transactions.log_http.txt'));
	Fs.rmSync(directoryPath, { recursive: true, force: true });

	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayTaskRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: 'hello' } }] }, elapsedMs: 5, isCallerDisconnected: false,
	});
});

Test('a no-op logger, built from no log file path, writes nothing and never throws', () => {
	const logger = new CurlStyleTransactionLogger(undefined);
	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayTaskRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: 'hello' } }] }, elapsedMs: 5, isCallerDisconnected: false,
	});
});

Test('writes one curl-style block per transaction, with both bodies and every header exactly as they went over the connection', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(directoryPath, 'transactions.log_http.txt');
	const logger = new CurlStyleTransactionLogger(logFilePath);

	logger.log({
		id: 'request-1',
		receivedAt: new Date('2026-07-30T13:40:00.000Z'),
		method: 'POST',
		path: '/v1/chat/completions',
		httpVersion: 'HTTP/1.1',
		requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer the-key', cookie: 'session=abc' },
		requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: 'What is the capital of France?' }] },
		model: 'dev_formula',
		authOutcome: 'ok',
		gatewayTaskRequestId: 'gateway-request-1',
		gatewayTaskId: 'task-1',
		outcome: 'completed',
		status: 200,
		responseType: 'chat.completion',
		responseBody: { choices: [{ message: { role: 'assistant', content: 'Paris is the capital of France.' } }] },
		elapsedMs: 18,
		isCallerDisconnected: false,
	});

	const blocks = Fs.readFileSync(logFilePath, 'utf8').split(transactionSeparator).map((block) => block.trim()).filter((block) => block.length > 0);
	Fs.rmSync(directoryPath, { recursive: true, force: true });
	// One transaction is one block: the whole exchange, not a block for its start and another
	// for its end.
	Assert.equal(blocks.length, 1);
	const [block] = blocks;

	Assert.match(block, /^> POST \/v1\/chat\/completions HTTP\/1\.1$/m);
	// Nothing is redacted: every header is written as it was received, the key included.
	Assert.match(block, /^> authorization: Bearer the-key$/m);
	Assert.match(block, /^> cookie: session=abc$/m);
	Assert.match(block, /^> content-type: application\/json$/m);
	// The request body is written as sent, so the log says what the cluster was actually asked.
	Assert.match(block, /^>\s+"content": "What is the capital of France\?"$/m);
	Assert.match(block, /^< HTTP\/1\.1 200 OK$/m);
	// The answer is written in full too, so the log says what the caller actually received.
	Assert.match(block, /^<\s+"content": "Paris is the capital of France\."$/m);
	Assert.equal(fieldOf(block, 'Transaction'), 'request-1');
	Assert.equal(fieldOf(block, 'Duration'), '18 ms');
	Assert.equal(fieldOf(block, 'Model'), 'dev_formula');
	Assert.equal(fieldOf(block, 'Auth'), 'ok');
	Assert.equal(fieldOf(block, 'Gateway request'), 'gateway-request-1');
	Assert.equal(fieldOf(block, 'Gateway task'), 'task-1');
	Assert.equal(fieldOf(block, 'Outcome'), 'completed');
});

Test('cuts a body short once it runs longer than this logger prints, and says how much was left out', () => {
	const directoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'http-transaction-'));
	const logFilePath = Path.join(directoryPath, 'transactions.log_http.txt');
	const logger = new CurlStyleTransactionLogger(logFilePath);
	const longAnswer = 'a'.repeat(10_000);

	logger.log({
		id: 'request-1', receivedAt: new Date(), method: 'POST', path: '/v1/chat/completions', httpVersion: 'HTTP/1.1',
		requestHeaders: {}, requestBody: { model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }, model: 'dev_formula', authOutcome: 'not_required',
		gatewayTaskRequestId: undefined, gatewayTaskId: undefined, outcome: 'completed', status: 200, responseType: 'chat.completion',
		responseBody: { choices: [{ message: { content: longAnswer } }] }, elapsedMs: 5, isCallerDisconnected: false,
	});

	const block = Fs.readFileSync(logFilePath, 'utf8');
	Fs.rmSync(directoryPath, { recursive: true, force: true });

	Assert.match(block, /^< Body truncated \(\d+ characters omitted of \d+\)$/m);
	// The short request body next to it is untouched, so only what is actually long is cut.
	Assert.match(block, /^>\s+"content": "5"$/m);
});

Test('audits a successful chat completion as one transaction, with the gateway identifiers it was submitted under', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
		});
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'] as string;
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-audit-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-audit-1', taskRevision: 2, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: 17 } });
		Assert.equal((await responsePromise).status, 200);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.match(block, /^> POST \/v1\/chat\/completions HTTP\/1\.1$/m);
		// What was asked and what was answered are both in the block, read back off the real
		// connection this test sent the request over.
		Assert.match(block, /^>\s+"content": "5"$/m);
		Assert.match(block, /^< HTTP\/1\.1 200 OK$/m);
		Assert.match(block, /^<\s+"content": "17"$/m);
		Assert.equal(fieldOf(block, 'Model'), 'dev_formula');
		Assert.equal(fieldOf(block, 'Auth'), 'not_required');
		Assert.equal(fieldOf(block, 'Gateway request'), taskRequestId);
		Assert.equal(fieldOf(block, 'Gateway task'), 'task-audit-1');
		Assert.equal(fieldOf(block, 'Outcome'), 'completed');
	} finally {
		server.close();
	}
});

Test('audits a validation failure with the exact status and error code the caller received, and no gateway identifiers', async () => {
	const server = await listeningServer();
	try {
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: '5' }] }),
		});
		Assert.equal(response.status, 404);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Outcome'), 'failed');
		Assert.match(block, /^< HTTP\/1\.1 404 Not Found$/m);
		Assert.equal(fieldOf(block, 'Gateway request'), undefined);
		Assert.match(block, /^<\s+"code": "model_not_found"$/m);
	} finally {
		server.close();
	}
});

Test('audits a streamed answer as one transaction, naming the task it ran', async () => {
	const server = await listeningServer();
	try {
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true }),
		});

		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'] as string;
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-audit-stream-1', taskRequestId, state: 'queued' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-audit-stream-1', taskRevision: 2, state: 'running', completedStageCount: 1, currentStageAttempts: 1, newText: 'The capital.' } });
		server.cluster.receive({ type: 'task.updated', update: { taskId: 'task-audit-stream-1', taskRevision: 3, state: 'completed', completedStageCount: 2, currentStageAttempts: 0, result: { text: 'The capital.', done: true } } });
		await responsePromise;

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Outcome'), 'completed');
		Assert.equal(fieldOf(block, 'Gateway task'), 'task-audit-stream-1');
		Assert.match(block, /^< HTTP\/1\.1 200 OK$/m);
		// A streamed answer was sent as server-sent events, not as one JSON body, so the log
		// records the content type that was actually sent rather than the one every other
		// response here carries.
		Assert.match(block, /^< content-type: text\/event-stream/m);
	} finally {
		server.close();
	}
});

Test('audits a key that did not match, recording the key that was actually presented', async () => {
	const server = await listeningServer({}, 'the-right-key');
	try {
		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer the-wrong-key' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
		});
		Assert.equal(response.status, 401);

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Auth'), 'failed');
		Assert.match(block, /^< HTTP\/1\.1 401 Unauthorized$/m);
		// The key the caller presented is written as received, so a refused call can be told
		// apart from a call that presented no key at all.
		Assert.match(block, /^> authorization: Bearer the-wrong-key$/m);
	} finally {
		server.close();
	}
});

Test('audits a caller that disconnects before an answer arrives as cancelled, not failed', async () => {
	const server = await listeningServer();
	try {
		const abortController = new AbortController();
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'dev_formula', messages: [{ role: 'user', content: '5' }] }),
			signal: abortController.signal,
		}).catch(() => undefined);
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		abortController.abort();
		await responsePromise;

		await waitUntil(() => server.transactions().length >= 1);
		const [block] = server.transactions();
		Assert.equal(fieldOf(block, 'Outcome'), 'cancelled');
		Assert.match(block, /^< \(no response: the caller disconnected before one was sent\)$/m);
	} finally {
		server.close();
	}
});

// The same disconnection over a real HTTP connection, checked at the gateway rather than in the
// transaction log. The test above passes whether or not the task is ever cancelled, because the
// transaction log is written from the response either way, and the test of the runner's own
// cancelling aborts a signal it was handed directly. Between the two sat the wiring that decides
// when that signal is aborted, which was listening for the request's `close` event: a request
// emits that as soon as its body has been read, so every request aborted its own signal on
// arrival, before the runner had attached a listener to it, and no caller going away ever
// cancelled anything.
Test('cancels the task at the gateway when a caller hangs up over a real connection', async () => {
	const server = await listeningServer();
	try {
		const abortController = new AbortController();
		const responsePromise = fetch(`${server.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'llm_gemma_nano_chrome_full', messages: [{ role: 'user', content: 'Tell me about rain.' }] }),
			signal: abortController.signal,
		}).catch(() => undefined);
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.submit');
		const taskRequestId = server.cluster.lastSentBody()['taskRequestId'];
		server.cluster.receive({ type: 'task.accepted', taskRequestId, task: { taskId: 'task-hung-up-1', taskRequestId, state: 'queued' } });

		// Nothing has been cancelled while the caller is still waiting for its answer.
		await settlePromises();
		Assert.notEqual(server.cluster.lastSentBody()['type'], 'task.cancel');

		abortController.abort();
		await responsePromise;
		await waitUntil(() => server.cluster.lastSentBody()['type'] === 'task.cancel');
		Assert.equal(server.cluster.lastSentBody()['taskId'], 'task-hung-up-1');
		Assert.equal(server.cluster.runner.tasksInFlight, 0);
	} finally {
		server.close();
	}
});
