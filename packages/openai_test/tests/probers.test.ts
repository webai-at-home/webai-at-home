// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { CompletionSender } from '../src/clients/completion_sender.js';
import type { GenerationControlOutcome, ToolCallOutcome } from '../src/completion_types.js';
import { AnswerLengthCap } from '../src/probers/answer_length_cap.js';
import { GenerationControlProber } from '../src/probers/generation_control_prober.js';
import { ToolCallProber } from '../src/probers/tool_call_prober.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The probers: what the model behind an endpoint can actually do
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Starts a local HTTP server on a free port, so a test can measure a real streamed connection
 * rather than a stand-in for one.
 *
 * @param handler What the server answers with.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startTestServer(handler: Http.RequestListener): Promise<{ baseUrl: string; stop: () => Promise<void>; }> {
	const server = Http.createServer(handler);
	// Bound to 127.0.0.1 rather than to every interface, because 127.0.0.1 is the address the
	// client below is given. `listen(0)` with no host binds `::`, which macOS lets sit beside an
	// unrelated process already holding `127.0.0.1` on the same port — and the client then reaches
	// that process instead of this server. Measured: a run answered `400 WebSockets request was
	// expected` and another `404 <!DOCTYPE html>`, neither of which this handler can write. Naming
	// the address makes the port exclusive, because the kernel refuses a second bind on it. See
	// [issue #227](https://github.com/webai-at-home/webai-at-home/issues/227).
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The test server did not report a port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		stop: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}



//	GenerationControlProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The generation controls one request to the stand-in endpoint below asked for. */
type ReceivedControls = {
	temperature?: number;
	top_p?: number;
	max_completion_tokens?: number;
	max_tokens?: number;
	stop?: string[];
	seed?: number;
	messages: { content: string }[];
};

/**
 * Answers a chat completion request the way an endpoint that really honours every generation
 * control would, so the prober can be checked against a known-good endpoint without a language
 * model anywhere.
 *
 * @param body The request body received.
 * @returns The answer text and the finish reason to answer with.
 */
function honouringAnswer(body: ReceivedControls): { text: string; finishReason: string } {
	const prompt = body.messages[0]?.content ?? '';
	let text = 'a fixed answer about a cat';
	if (prompt.startsWith('Count from 1 to 9') === true) {
		text = '1 2 3 4 5 6 7 8 9';
	} else if (prompt.startsWith('Count from one to fifty') === true) {
		text = 'one two three four five six seven eight nine ten eleven twelve';
	} else if ((body.temperature ?? 0) > 0 && (body.top_p ?? 1) > 0.05) {
		// Varies exactly as sampling would: by the seed when one was given, and freely when none was.
		text = body.seed === undefined ? `a cat answer ${randomAnswerCounter += 1}` : `a cat answer for seed ${body.seed}`;
	}
	for (const sequence of body.stop ?? []) {
		const cutAt = text.indexOf(sequence);
		if (cutAt !== -1) {
			return { text: text.slice(0, cutAt), finishReason: 'stop' };
		}
	}
	const budget = body.max_completion_tokens ?? body.max_tokens;
	if (budget !== undefined) {
		return { text: text.split(' ').slice(0, budget).join(' '), finishReason: 'length' };
	}
	return { text, finishReason: 'stop' };
}

/** Counts the answers an endpoint that samples freely has produced, so each one differs. */
let randomAnswerCounter = 0;

/**
 * Starts a stand-in endpoint that answers every chat completion request through one function.
 *
 * @param answerOf Builds the answer for one received request body.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startCompletionServer(answerOf: (body: ReceivedControls) => { text: string; finishReason: string }): Promise<{ baseUrl: string; stop: () => Promise<void>; }> {
	return await startTestServer((request, response) => {
		let received = '';
		request.on('data', (piece: Buffer) => {
			received += piece.toString();
		});
		request.on('end', () => {
			const body = JSON.parse(received) as ReceivedControls;
			const answer = answerOf(body);
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({
				id: 'chatcmpl-test',
				object: 'chat.completion',
				created: 0,
				model: 'stand-in',
				choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, logprobs: null, finish_reason: answer.finishReason }],
			}));
		});
	});
}

/**
 * How long a request to a stand-in endpoint in this same process may take before it is given up on.
 *
 * Not the patience a real endpoint deserves, which is what the 5000 ms these tests used to pass was:
 * that number was chosen for a language model on the other side of a socket, where five seconds of
 * silence really does mean something is wrong. Here the endpoint is the server `startTestServer` above starts,
 * running on the same event loop as the client measuring it, so five seconds of silence never means
 * the endpoint is unwell — it means this one process was not given a core for five seconds, and every
 * probe then reports `failed` for a stand-in that was working perfectly. That is
 * [issue #227](https://github.com/webai-at-home/webai-at-home/issues/227), reproduced by blocking
 * this event loop for longer than the timeout and watching all five probes time out in turn.
 *
 * Kept finite rather than removed because it is the only thing that ends a genuinely hung request:
 * `node --test` sets no timeout of its own, so a test with no client timeout hangs until the runner
 * is killed. A minute is far longer than any stall observed and far shorter than a person's patience.
 */
const STAND_IN_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Refuses an outcome whose probe never reached the stand-in endpoint, naming what the request said.
 *
 * No test in this file expects `failed`. It is the status a probe reports when the request itself
 * did not come back, so against a stand-in endpoint it always means the transport between this
 * process's client and this process's own server fell over, never that a prober concluded
 * something. Raised here, a red run names the error the request raised; left to the assertions
 * below, the same run arrives as five or six identical `failed` strings that say nothing at all
 * about why. See [issue #227](https://github.com/webai-at-home/webai-at-home/issues/227).
 *
 * @param outcomes The outcomes one probe run produced.
 * @returns Nothing.
 * @throws {Error} If any probe reports `failed`, naming every one that did and what it observed.
 */
function refuseProbesThatNeverReachedTheEndpoint(outcomes: readonly (GenerationControlOutcome | ToolCallOutcome)[]): void {
	const unreached = outcomes.filter((outcome) => outcome.status === 'failed');
	if (unreached.length === 0) {
		return;
	}
	const named = unreached.map((outcome) => {
		const probeName = 'control' in outcome ? outcome.control : outcome.ability;
		return `${probeName}: ${outcome.observation}`;
	});
	throw new Error(`${unreached.length} of ${outcomes.length} probes never reached the stand-in endpoint, so nothing was measured. ${named.join(' | ')}`);
}

/**
 * Probes one stand-in endpoint and returns what each control's probe concluded.
 *
 * @param baseUrl The stand-in endpoint's base URL.
 * @returns The status of each of the five probes, keyed by the control's request field name.
 */
async function probeStatuses(baseUrl: string): Promise<Record<string, string>> {
	const client = CompletionSender.createClient({
		baseUrl: `${baseUrl}/v1`,
		apiKey: 'insecure-benchmark-key',
		timeoutMs: STAND_IN_REQUEST_TIMEOUT_MS,
	});
	const outcomes = await GenerationControlProber.probeAll({
		client,
		modelId: 'stand-in',
		streamSetting: 'off',
		repeats: 3,
	});
	refuseProbesThatNeverReachedTheEndpoint(outcomes);
	return Object.fromEntries(outcomes.map((outcome) => [outcome.control, outcome.status]));
}

Test('finds every control honoured against an endpoint that really honours all five', async () => {
	const server = await startCompletionServer(honouringAnswer);
	try {
		Assert.deepEqual(await probeStatuses(server.baseUrl), {
			temperature: 'honoured',
			top_p: 'honoured',
			max_completion_tokens: 'honoured',
			stop: 'honoured',
			seed: 'honoured',
		});
	} finally {
		await server.stop();
	}
});

Test('finds a control accepted and then ignored, which is the fault this probe exists to catch', async () => {
	// This endpoint accepts every control without complaining and answers the same way whatever
	// it was asked for, which is exactly what a control that works looks like until it is measured.
	const server = await startCompletionServer((body) => ({
		text: (body.messages[0]?.content ?? '').startsWith('Count from 1 to 9') === true ? '1 2 3 4 5 6 7 8 9' : 'the same answer every time',
		finishReason: 'stop',
	}));
	try {
		const statuses = await probeStatuses(server.baseUrl);
		Assert.equal(statuses.temperature, 'not_honoured');
		Assert.equal(statuses.max_completion_tokens, 'not_honoured');
		Assert.equal(statuses.stop, 'not_honoured');
		// A model answering identically whatever seed it is given is what an ignored seed and a
		// deterministic model both look like, so nothing is claimed either way.
		Assert.equal(statuses.seed, 'inconclusive');
	} finally {
		await server.stop();
	}
});

Test('reports a control the endpoint says the model cannot honour as refused, not as a failure', async () => {
	const server = await startTestServer((request, response) => {
		request.on('data', () => undefined);
		request.on('end', () => {
			response.writeHead(400, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({
				error: {
					message: 'The model stand-in cannot honour this control.',
					type: 'invalid_request_error',
					param: 'temperature',
					code: 'unhonourable_generation_control',
				},
			}));
		});
	});
	try {
		Assert.deepEqual(await probeStatuses(server.baseUrl), {
			temperature: 'refused',
			top_p: 'refused',
			max_completion_tokens: 'refused',
			stop: 'refused',
			seed: 'refused',
		});
	} finally {
		await server.stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////


//	ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The parts of one chat completion request the tool call stand-in endpoints below read. */
type ReceivedToolRequest = {
	max_completion_tokens?: number;
	tools?: { function: { name: string } }[];
	tool_choice?: string;
	stream?: boolean;
	messages: { role: string; content: string | null }[];
};

/** What a tool call stand-in endpoint answers with: words, or the tool calls the model asked for. */
type StandInAnswer = {
	/** The answer text, empty when the model asked for a tool instead. */
	text: string;
	/** The tool calls the model asked for, empty when it answered in words. */
	toolCalls: { name: string; argumentsJson: string }[];
};

/**
 * Reads the question a stand-in endpoint was asked, which is the first message of every probe that
 * sends one prompt.
 *
 * @param body The request body received.
 * @returns The question text.
 */
function questionOf(body: ReceivedToolRequest): string {
	return body.messages[0]?.content ?? '';
}

/**
 * Reports whether the history received already carries a tool's result, which is what the
 * `reads_a_tool_result_back` probe sends and no other probe does.
 *
 * @param body The request body received.
 * @returns `true` when a message whose role is `tool` is present.
 */
function carriesAToolResult(body: ReceivedToolRequest): boolean {
	return body.messages.some((message) => message.role === 'tool');
}

/**
 * Starts a stand-in endpoint that answers every chat completion request through one function, in
 * whichever stream setting the request asked for.
 *
 * A streamed answer sends its tool calls the way this interface really does — the name once, then
 * the arguments a fragment at a time, each carrying the index of the call it belongs to — so that
 * assembling them back together is exercised rather than assumed.
 *
 * @param answerOf Builds the answer for one received request body.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startToolCallServer(answerOf: (body: ReceivedToolRequest) => StandInAnswer): Promise<{ baseUrl: string; stop: () => Promise<void>; }> {
	return await startTestServer((request, response) => {
		let received = '';
		request.on('data', (piece: Buffer) => {
			received += piece.toString();
		});
		request.on('end', () => {
			const body = JSON.parse(received) as ReceivedToolRequest;
			const answer = answerOf(body);
			const finishReason = answer.toolCalls.length > 0 ? 'tool_calls' : 'stop';
			if (body.stream === true) {
				response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
				answer.toolCalls.forEach((toolCall, index) => {
					const opening = { choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: toolCall.name, arguments: '' } }] } }] };
					response.write(`data: ${JSON.stringify(opening)}\n\n`);
					const halfway = Math.floor(toolCall.argumentsJson.length / 2);
					for (const fragment of [toolCall.argumentsJson.slice(0, halfway), toolCall.argumentsJson.slice(halfway)]) {
						const piece = { choices: [{ delta: { tool_calls: [{ index, function: { arguments: fragment } }] } }] };
						response.write(`data: ${JSON.stringify(piece)}\n\n`);
					}
				});
				if (answer.text !== '') {
					response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.text } }] })}\n\n`);
				}
				response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
				response.write('data: [DONE]\n\n');
				response.end();
				return;
			}
			const toolCalls = answer.toolCalls.map((toolCall, index) => ({
				id: `call_${index}`,
				type: 'function',
				function: { name: toolCall.name, arguments: toolCall.argumentsJson },
			}));
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({
				id: 'chatcmpl-test',
				object: 'chat.completion',
				created: 0,
				model: 'stand-in',
				choices: [{
					index: 0,
					message: {
						role: 'assistant',
						content: answer.text === '' ? null : answer.text,
						...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
					},
					logprobs: null,
					finish_reason: finishReason,
				}],
			}));
		});
	});
}

/**
 * Answers the way a model that really calls tools would: it asks for the tool that answers the
 * question, fills in the city the question named, answers in words once the tool's result is in the
 * history, and leaves the tool alone for a question that needs none.
 *
 * @param body The request body received.
 * @returns What to answer with.
 */
function callsToolsAnswer(body: ReceivedToolRequest): StandInAnswer {
	if (carriesAToolResult(body) === true) {
		return {
			text: 'It is 31 degrees celsius and clear in Paris.',
			toolCalls: [],
		};
	}
	const question = questionOf(body);
	if (question.includes('weather') === false && question.includes('time') === false) {
		return {
			text: 'hello',
			toolCalls: [],
		};
	}
	return {
		text: '',
		toolCalls: [{
			name: question.includes('time') === true ? 'get_current_time' : 'get_current_weather',
			argumentsJson: '{"city":"Paris"}',
		}],
	};
}

/**
 * Probes one stand-in endpoint and returns what each ability's probe concluded.
 *
 * @param baseUrl The stand-in endpoint's base URL.
 * @param streamSetting Whether to ask for the answer as it is written, or in one piece.
 * @returns The status of each of the six probes, keyed by the ability's name.
 */
async function probeToolCallStatuses(baseUrl: string, streamSetting: 'off' | 'on'): Promise<Record<string, string>> {
	const client = CompletionSender.createClient({
		baseUrl: `${baseUrl}/v1`,
		apiKey: 'insecure-benchmark-key',
		timeoutMs: STAND_IN_REQUEST_TIMEOUT_MS,
	});
	const outcomes = await ToolCallProber.probeAll({
		client,
		modelId: 'stand-in',
		streamSetting,
		repeats: 3,
	});
	refuseProbesThatNeverReachedTheEndpoint(outcomes);
	return Object.fromEntries(outcomes.map((outcome) => [outcome.ability, outcome.status]));
}

Test('finds every ability supported against a model that really calls tools', async () => {
	const server = await startToolCallServer(callsToolsAnswer);
	try {
		Assert.deepEqual(await probeToolCallStatuses(server.baseUrl, 'off'), {
			generates_a_call: 'supported',
			generates_a_call_when_forced: 'supported',
			fills_in_the_arguments: 'supported',
			chooses_among_several_tools: 'supported',
			reads_a_tool_result_back: 'supported',
			answers_without_a_call_when_none_is_needed: 'supported',
		});
	} finally {
		await server.stop();
	}
});

Test('assembles a tool call streamed a fragment at a time, so streaming reaches the same conclusions', async () => {
	const server = await startToolCallServer(callsToolsAnswer);
	try {
		Assert.deepEqual(await probeToolCallStatuses(server.baseUrl, 'on'), {
			generates_a_call: 'supported',
			generates_a_call_when_forced: 'supported',
			fills_in_the_arguments: 'supported',
			chooses_among_several_tools: 'supported',
			reads_a_tool_result_back: 'supported',
			answers_without_a_call_when_none_is_needed: 'supported',
		});
	} finally {
		await server.stop();
	}
});

Test('reads a streamed tool call back as one call, with its name and its whole arguments', async () => {
	const server = await startToolCallServer(callsToolsAnswer);
	try {
		const client = CompletionSender.createClient({
			baseUrl: `${server.baseUrl}/v1`,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: STAND_IN_REQUEST_TIMEOUT_MS,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'stand-in',
			messages: [{ role: 'user', content: 'What is the current weather in Paris?' }],
			streamSetting: 'on',
			tools: [{
				type: 'function',
				function: {
					name: 'get_current_weather',
					description: 'Reports the current weather in one city.',
					parameters: { type: 'object', properties: {}, required: [] },
				},
			}],
			toolChoice: 'auto',
		});
		// The stand-in split the arguments in half across two chunks, so reading them back whole is
		// what proves the fragments were assembled rather than the last one having won.
		Assert.deepEqual(result.toolCalls, [{ id: 'call_0', name: 'get_current_weather', argumentsJson: '{"city":"Paris"}' }]);
		Assert.equal(result.answer, '');
		Assert.equal(result.finishReason, 'tool_calls');
	} finally {
		await server.stop();
	}
});

Test('finds tool calling unsupported against an endpoint that accepts the declarations and never calls a tool', async () => {
	// This is the shape the de-risk gate of issue #78 found, and the reason this subcommand exists:
	// the tool wire format is read without complaint, tool_choice required is accepted, and the model
	// still answers in words every time. The two abilities that do not need the model to generate a
	// call are unaffected, which is what tells this apart from an endpoint that refuses tools.
	const server = await startToolCallServer((body) => ({
		text: carriesAToolResult(body) === true ? 'It is 31 degrees celsius and clear in Paris.' : 'I cannot look that up for you.',
		toolCalls: [],
	}));
	try {
		Assert.deepEqual(await probeToolCallStatuses(server.baseUrl, 'off'), {
			generates_a_call: 'unsupported',
			generates_a_call_when_forced: 'unsupported',
			fills_in_the_arguments: 'inconclusive',
			chooses_among_several_tools: 'inconclusive',
			reads_a_tool_result_back: 'supported',
			answers_without_a_call_when_none_is_needed: 'supported',
		});
	} finally {
		await server.stop();
	}
});

Test('finds the wrong tool, unusable arguments, and a call nobody asked for, each on its own', async () => {
	// A model that always asks for one particular tool, filled in with something that is not JSON.
	// Generating a call is not the same as generating a useful one, and every probe after the first
	// two exists to tell those apart.
	const server = await startToolCallServer(() => ({
		text: '',
		toolCalls: [{ name: 'get_stock_price', argumentsJson: 'city=Paris' }],
	}));
	try {
		Assert.deepEqual(await probeToolCallStatuses(server.baseUrl, 'off'), {
			generates_a_call: 'supported',
			generates_a_call_when_forced: 'supported',
			fills_in_the_arguments: 'unsupported',
			chooses_among_several_tools: 'unsupported',
			reads_a_tool_result_back: 'unsupported',
			answers_without_a_call_when_none_is_needed: 'unsupported',
		});
	} finally {
		await server.stop();
	}
});

Test('reports an endpoint that will not take tool declarations at all as refused, not as a failure', async () => {
	const server = await startTestServer((request, response) => {
		request.on('data', () => undefined);
		request.on('end', () => {
			response.writeHead(400, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({
				error: {
					message: 'This server does not accept tool declarations.',
					type: 'invalid_request_error',
					param: 'tools',
					code: 'unsupported_parameter',
				},
			}));
		});
	});
	try {
		Assert.deepEqual(await probeToolCallStatuses(server.baseUrl, 'off'), {
			generates_a_call: 'refused',
			generates_a_call_when_forced: 'refused',
			fills_in_the_arguments: 'refused',
			chooses_among_several_tools: 'refused',
			reads_a_tool_result_back: 'refused',
			answers_without_a_call_when_none_is_needed: 'refused',
		});
	} finally {
		await server.stop();
	}
});



///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AnswerLengthCap
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every generation control a probe request may carry, so a test can read which ones one request carried. */
const controlFieldNames = ['temperature', 'top_p', 'max_completion_tokens', 'max_tokens', 'stop', 'seed'] as const;

/**
 * Reads which generation controls one received request carried.
 *
 * @param body The request body received.
 * @returns The control field names, sorted, so two requests carrying the same controls compare equal.
 */
function controlsOf(body: object): string[] {
	return Object.keys(body).filter((key) => (controlFieldNames as readonly string[]).includes(key)).sort();
}

/**
 * Builds the cap the tests below hand to a prober.
 *
 * @param baseUrl The stand-in endpoint's base URL.
 * @param streamSetting Whether to ask for the answer as it is written, or in one piece.
 * @returns The client to probe with, and the cap to probe with.
 */
function clientAndCap(baseUrl: string, streamSetting: 'off' | 'on'): { client: ReturnType<typeof CompletionSender.createClient>; answerLengthCap: AnswerLengthCap } {
	const client = CompletionSender.createClient({
		baseUrl: `${baseUrl}/v1`,
		apiKey: 'insecure-benchmark-key',
		timeoutMs: STAND_IN_REQUEST_TIMEOUT_MS,
	});
	return {
		client,
		answerLengthCap: new AnswerLengthCap({
			client,
			modelId: 'stand-in',
			streamSetting,
			thinkingSetting: 'off',
		}),
	};
}

Test('the output budget reaches the probes that compare whole answers, and none of the requests a budget would change', async () => {
	const bodies: ReceivedControls[] = [];
	const server = await startCompletionServer((body) => {
		bodies.push(body);
		return honouringAnswer(body);
	});
	try {
		const { client, answerLengthCap } = clientAndCap(server.baseUrl, 'off');
		const outcomes = await GenerationControlProber.probeAll({
			client,
			modelId: 'stand-in',
			streamSetting: 'off',
			repeats: 3,
			thinkingSetting: 'off',
			answerLengthCap,
		});
		refuseProbesThatNeverReachedTheEndpoint(outcomes);
		// A budget large enough to change nothing changes nothing: the same five verdicts as without one.
		Assert.deepEqual(outcomes.map((outcome) => outcome.status), ['honoured', 'honoured', 'honoured', 'honoured', 'honoured']);

		// Every control is still asked about on its own, with the budget kept out of that one request,
		// so an endpoint refusing more than one control still names the control being probed.
		for (const control of ['temperature', 'top_p', 'max_completion_tokens', 'stop', 'seed']) {
			Assert.equal(bodies.some((body) => controlsOf(body).join() === control), true, `no request asked about ${control} on its own`);
		}

		// The stop sequence probe never carries a budget, which could cut the answer short before the
		// stop sequence was ever written and report a stop sequence that was never honoured.
		Assert.equal(bodies.some((body) => body.stop !== undefined && body.max_completion_tokens !== undefined), false);

		// The three comparison probes carry it on every request: three at temperature 0, three at the
		// high temperature, three narrowing top_p, and three seeded, after the one request that found
		// out the endpoint carries a budget at all.
		const capped = bodies.filter((body) => body.max_completion_tokens === AnswerLengthCap.tokenCount);
		Assert.equal(capped.length, 1 + 12);
	} finally {
		await server.stop();
	}
});

Test('an endpoint that answers a budgeted request with no text is probed with no budget at all, and reaches the same verdicts', async () => {
	const bodies: ReceivedControls[] = [];
	// A thinking model spends the whole budget on reasoning and writes no answer, which is what
	// `google/gemma-4-e2b` did on LM Studio 0.4.20 and what this endpoint reproduces.
	const server = await startCompletionServer((body) => {
		bodies.push(body);
		if (body.max_completion_tokens === AnswerLengthCap.tokenCount) {
			return { text: '', finishReason: 'length' };
		}
		return honouringAnswer(body);
	});
	try {
		const { client, answerLengthCap } = clientAndCap(server.baseUrl, 'off');
		const outcomes = await GenerationControlProber.probeAll({
			client,
			modelId: 'stand-in',
			streamSetting: 'off',
			repeats: 3,
			thinkingSetting: 'off',
			answerLengthCap,
		});
		refuseProbesThatNeverReachedTheEndpoint(outcomes);
		Assert.deepEqual(outcomes.map((outcome) => outcome.status), ['honoured', 'honoured', 'honoured', 'honoured', 'honoured']);
		// The one request carrying the budget is the one that found out it cannot be carried.
		Assert.equal(bodies.filter((body) => body.max_completion_tokens === AnswerLengthCap.tokenCount).length, 1);
	} finally {
		await server.stop();
	}
});

Test('every tool call probe request carries the output budget once the endpoint has answered a budgeted one', async () => {
	const bodies: ReceivedToolRequest[] = [];
	const server = await startToolCallServer((body) => {
		bodies.push(body);
		return callsToolsAnswer(body);
	});
	try {
		const { client, answerLengthCap } = clientAndCap(server.baseUrl, 'off');
		const outcomes = await ToolCallProber.probeAll({
			client,
			modelId: 'stand-in',
			streamSetting: 'off',
			repeats: 3,
			thinkingSetting: 'off',
			answerLengthCap,
		});
		refuseProbesThatNeverReachedTheEndpoint(outcomes);
		Assert.deepEqual(new Set(outcomes.map((outcome) => outcome.status)), new Set(['supported']));
		Assert.equal(bodies.length > 1, true);
		Assert.equal(bodies.every((body) => body.max_completion_tokens === AnswerLengthCap.tokenCount), true);
	} finally {
		await server.stop();
	}
});
