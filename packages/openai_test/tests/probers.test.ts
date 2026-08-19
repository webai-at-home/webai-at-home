// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { CompletionSender } from '../src/clients/completion_sender.js';
import type { GenerationControlOutcome, ToolCallOutcome } from '../src/completion_types.js';
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
	await new Promise<void>((resolve) => server.listen(0, () => resolve()));
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
 * Probes one stand-in endpoint and returns what each control's probe concluded.
 *
 * @param baseUrl The stand-in endpoint's base URL.
 * @returns The status of each of the five probes, keyed by the control's request field name.
 */
async function probeStatuses(baseUrl: string): Promise<Record<string, string>> {
	const client = CompletionSender.createClient({
		baseUrl: `${baseUrl}/v1`,
		apiKey: 'insecure-benchmark-key',
		timeoutMs: 5_000,
	});
	const outcomes = await GenerationControlProber.probeAll({
		client,
		modelId: 'stand-in',
		streamSetting: 'off',
		repeats: 3,
	});
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
		timeoutMs: 5_000,
	});
	const outcomes = await ToolCallProber.probeAll({
		client,
		modelId: 'stand-in',
		streamSetting,
		repeats: 3,
	});
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
			timeoutMs: 5_000,
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


