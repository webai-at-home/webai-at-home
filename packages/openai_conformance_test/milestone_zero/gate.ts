#!/usr/bin/env -S npx tsx

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gate — milestone zero of issue #182: is a conformance verdict stable across ten repeated requests?
//
//	This script is not the conformance runner. It exists to answer, with raw output rather than a
//	summary, whether a small set of candidate tests give the same verdict every time they are
//	asked, against two real endpoints. If a test flips between PASS and FAIL across ten identical
//	requests, it is not measuring the protocol, it is measuring the model's mood, and issue #181
//	forbids exactly that. Two traps are deliberately exercised here rather than left for later:
//
//	  1. This project's own `consumer_openai` server refuses a generation control the chosen model
//	     cannot honour, with HTTP 400 and the error code `unhonourable_generation_control`. A test
//	     that does not read that code reports FAIL where the true answer is SKIP.
//	  2. Whether a model calls a declared tool is a choice it makes afresh on every request. A test
//	     that reports FAIL the moment a model answers in words, instead of WARN, cannot tell "this
//	     server cannot call tools" apart from "this model chose not to, this time".
//
//	Run with:
//	  npx tsx milestone_zero/gate.ts
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The four statuses section 32 of issue #181 defines. */
type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';

/** One endpoint under test. */
type Endpoint = {
	/** A short name for this endpoint, printed in every line of output about it. */
	readonly name: string;
	/** The OpenAI-compatible base URL, without a trailing slash and without `/chat/completions`. */
	readonly baseUrl: string;
	/** The bearer token to send, `undefined` when this endpoint expects none. */
	readonly apiKey: string | undefined;
	/** The model identifier to request. */
	readonly model: string;
};

/** What one run of one candidate test found. */
type CandidateOutcome = {
	/** The verdict this run reached. */
	readonly verdict: Verdict;
	/** What was seen, in words, so a flip can be explained rather than just counted. */
	readonly detail: string;
};

/** One candidate test, run once per repetition. */
type CandidateTest = {
	/** A stable identifier, in the same `group.name` shape section 26 of issue #181 asks for. */
	readonly id: string;
	/**
	 * Runs this test once against one endpoint.
	 *
	 * @param endpoint The endpoint to send the request to.
	 * @returns The verdict this one run reached.
	 */
	readonly run: (endpoint: Endpoint) => Promise<CandidateOutcome>;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gate
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Runs every candidate test ten times against every endpoint, and reports which verdicts held. */
export class Gate {
	/** How many times each candidate test is asked, per endpoint. */
	static readonly repeatCount = 10;

	/** How long one request may take before it is given up on. */
	static readonly requestTimeoutMs = 60000;

	/** The two endpoints this gate proves stability against, chosen by the plan in issue #182. */
	static readonly endpoints: readonly Endpoint[] = [
		{
			name: 'lm_studio',
			baseUrl: 'http://localhost:1234/v1',
			apiKey: undefined,
			model: 'llama-3.2-3b-instruct',
		},
		{
			name: 'consumer_openai',
			baseUrl: 'http://localhost:8788/v1',
			apiKey: undefined,
			model: 'llm_llama3_2_1b_full',
		},
	];

	/** The tool every tool-calling candidate test declares. */
	private static readonly _weatherTool = {
		type: 'function',
		function: {
			name: 'get_current_weather',
			description: 'Reports the current weather in one city. Call this whenever the current weather somewhere is asked about.',
			parameters: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
						description: 'The name of the city to report the current weather in, such as Paris.',
					},
				},
				required: ['city'],
			},
		},
	};

	/**
	 * Runs every candidate test {@link Gate.repeatCount} times against every endpoint in
	 * {@link Gate.endpoints}, printing each run's verdict as it happens and a stability summary
	 * once a test has finished on one endpoint.
	 *
	 * @returns Nothing. Prints raw output only; this script draws no PASS/FAIL conclusion of its
	 * own about the gate, that reading belongs in the issue comment reporting this milestone.
	 */
	static async run(): Promise<void> {
		const candidateTests: readonly CandidateTest[] = [
			{ id: 'models.list', run: Gate._testModelsList },
			{ id: 'chat.basic', run: Gate._testChatBasic },
			{ id: 'chat.system_message', run: Gate._testChatSystemMessage },
			{ id: 'usage.total_is_sum', run: Gate._testUsageTotalIsSum },
			{ id: 'errors.unknown_model', run: Gate._testErrorsUnknownModel },
			{ id: 'parameters.temperature', run: Gate._testParametersTemperature },
			{ id: 'tools.tool_call_returned', run: Gate._testToolsToolCallReturned },
			{ id: 'structured_output.json_object', run: Gate._testStructuredOutputJsonObject },
		];

		const summaryRows: { endpointName: string; testId: string; verdicts: Verdict[] }[] = [];

		for (const endpoint of Gate.endpoints) {
			console.log(`\n==== ${endpoint.name}  (${endpoint.baseUrl}, model ${endpoint.model}) ====`);
			for (const candidateTest of candidateTests) {
				const verdicts: Verdict[] = [];
				for (let repetition = 1; repetition <= Gate.repeatCount; repetition++) {
					const outcome = await Gate._runOnce(candidateTest, endpoint);
					verdicts.push(outcome.verdict);
					console.log(`[${endpoint.name}] ${candidateTest.id} rep ${repetition}/${Gate.repeatCount}: ${outcome.verdict} — ${outcome.detail}`);
				}
				const distinctVerdicts = [...new Set(verdicts)];
				const stability = distinctVerdicts.length === 1 ? 'STABLE' : 'FLIPPED';
				console.log(`  -> ${candidateTest.id}: ${stability} (${verdicts.join(', ')})`);
				summaryRows.push({ endpointName: endpoint.name, testId: candidateTest.id, verdicts });
			}
		}

		console.log('\n==== summary ====');
		for (const row of summaryRows) {
			const distinctVerdicts = [...new Set(row.verdicts)];
			const stability = distinctVerdicts.length === 1 ? 'STABLE' : 'FLIPPED';
			console.log(`${stability.padEnd(7)} ${row.endpointName.padEnd(16)} ${row.testId.padEnd(28)} ${row.verdicts.join(',')}`);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one candidate test once, turning a thrown error (a timeout, a connection refusal) into
	 * a `FAIL` outcome instead of stopping the whole gate.
	 *
	 * @param candidateTest The candidate test to run.
	 * @param endpoint The endpoint to run it against.
	 * @returns The outcome the test reached, or a `FAIL` outcome carrying the thrown error's message.
	 */
	private static async _runOnce(candidateTest: CandidateTest, endpoint: Endpoint): Promise<CandidateOutcome> {
		try {
			return await candidateTest.run(endpoint);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { verdict: 'FAIL', detail: `threw: ${message}` };
		}
	}

	/**
	 * Sends one JSON request and reads back the HTTP status and the parsed body.
	 *
	 * @param url The full URL to request.
	 * @param init The request method, headers, and body.
	 * @param timeoutMs How long to wait before giving up on the request.
	 * @returns The HTTP status, and the parsed JSON body, `undefined` when the body was empty or
	 * was not valid JSON.
	 */
	private static async _fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json: unknown }> {
		const abortController = new AbortController();
		const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
		try {
			const response = await fetch(url, { ...init, signal: abortController.signal });
			const text = await response.text();
			let json: unknown = undefined;
			if (text.length > 0) {
				try {
					json = JSON.parse(text);
				} catch {
					json = undefined;
				}
			}
			return { status: response.status, json };
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	/**
	 * Sends one `POST /chat/completions` request.
	 *
	 * @param endpoint The endpoint to send the request to.
	 * @param body The request body.
	 * @returns The HTTP status, and the parsed JSON body.
	 */
	private static async _postChatCompletion(endpoint: Endpoint, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
		return Gate._fetchJson(
			`${endpoint.baseUrl}/chat/completions`,
			{
				method: 'POST',
				headers: Gate._headers(endpoint),
				body: JSON.stringify(body),
			},
			Gate.requestTimeoutMs,
		);
	}

	/**
	 * Builds the headers a request to one endpoint carries.
	 *
	 * @param endpoint The endpoint being requested.
	 * @returns The headers to send.
	 */
	private static _headers(endpoint: Endpoint): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (endpoint.apiKey !== undefined) {
			headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
		}
		return headers;
	}

	/**
	 * Narrows an unknown JSON value to a record, so a field can be read from it without `any`.
	 *
	 * @param value The value to narrow.
	 * @returns The value as a record, `undefined` when it is not a non-null object.
	 */
	private static _asRecord(value: unknown): Record<string, unknown> | undefined {
		if (typeof value === 'object' && value !== null) {
			return value as Record<string, unknown>;
		}
		return undefined;
	}

	/**
	 * Reads `choices[0]` out of a chat completion response body.
	 *
	 * @param json The parsed response body.
	 * @returns The first choice, `undefined` when `choices` is missing, empty, or not an array.
	 */
	private static _firstChoice(json: unknown): Record<string, unknown> | undefined {
		const choices = Gate._asRecord(json)?.['choices'];
		if (Array.isArray(choices) === false || choices.length === 0) {
			return undefined;
		}
		return Gate._asRecord(choices[0]);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Candidate Tests
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * `GET /models` returns `object: "list"`, `data` is an array, and the requested model appears
	 * in it.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testModelsList(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._fetchJson(`${endpoint.baseUrl}/models`, { method: 'GET', headers: Gate._headers(endpoint) }, Gate.requestTimeoutMs);
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}` };
		}
		const body = Gate._asRecord(json);
		const data = body?.['data'];
		if (body?.['object'] !== 'list' || Array.isArray(data) === false) {
			return { verdict: 'FAIL', detail: `unexpected body shape: ${JSON.stringify(json)}` };
		}
		const modelIds = data.map((entry) => Gate._asRecord(entry)?.['id']);
		if (modelIds.includes(endpoint.model) === false) {
			return { verdict: 'FAIL', detail: `"${endpoint.model}" not in ${JSON.stringify(modelIds)}` };
		}
		return { verdict: 'PASS', detail: `${modelIds.length} model(s) listed, including "${endpoint.model}"` };
	}

	/**
	 * A basic completion returns HTTP 200, non-empty `choices[0].message.content`, and a
	 * `finish_reason`.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testChatBasic(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const choice = Gate._firstChoice(json);
		const content = Gate._asRecord(choice?.['message'])?.['content'];
		const finishReason = choice?.['finish_reason'];
		if (typeof content !== 'string' || content.trim() === '') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		if (typeof finishReason !== 'string') {
			return { verdict: 'FAIL', detail: `no finish_reason: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `finish_reason=${finishReason}, content=${JSON.stringify(content)}` };
	}

	/**
	 * A `system` role message ahead of the `user` message is accepted, and a completion still
	 * comes back.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testChatSystemMessage(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [
				{ role: 'system', content: 'You are concise.' },
				{ role: 'user', content: 'Hello' },
			],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const choice = Gate._firstChoice(json);
		if (choice === undefined) {
			return { verdict: 'FAIL', detail: `no choices: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: 'system message accepted' };
	}

	/**
	 * `usage.total_tokens` equals `usage.prompt_tokens + usage.completion_tokens`.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testUsageTotalIsSum(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const usage = Gate._asRecord(Gate._asRecord(json)?.['usage']);
		const promptTokens = usage?.['prompt_tokens'];
		const completionTokens = usage?.['completion_tokens'];
		const totalTokens = usage?.['total_tokens'];
		if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number') {
			return { verdict: 'FAIL', detail: `usage missing or not numeric: ${JSON.stringify(usage)}` };
		}
		if (totalTokens !== promptTokens + completionTokens) {
			return { verdict: 'FAIL', detail: `${totalTokens} !== ${promptTokens} + ${completionTokens}` };
		}
		return { verdict: 'PASS', detail: `${promptTokens} + ${completionTokens} = ${totalTokens}` };
	}

	/**
	 * An unknown model identifier is refused with an HTTP error status and an `error` object in
	 * the body.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testErrorsUnknownModel(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: 'this-model-does-not-exist-conformance-gate',
			messages: [{ role: 'user', content: 'Hello' }],
		});
		if (status < 400) {
			return { verdict: 'FAIL', detail: `expected an error status, got HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const errorBody = Gate._asRecord(Gate._asRecord(json)?.['error']);
		if (errorBody === undefined) {
			return { verdict: 'FAIL', detail: `HTTP ${status} but no "error" object: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `HTTP ${status}, error.message=${JSON.stringify(errorBody['message'])}` };
	}

	/**
	 * Trap one: `temperature` is either honoured with HTTP 200, or refused with HTTP 400 and the
	 * error code `unhonourable_generation_control`, which is `SKIP`, not `FAIL`.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testParametersTemperature(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
			temperature: 0.1,
		});
		if (status === 200) {
			return { verdict: 'PASS', detail: 'temperature accepted' };
		}
		const errorBody = Gate._asRecord(Gate._asRecord(json)?.['error']);
		if (status === 400 && errorBody?.['code'] === 'unhonourable_generation_control') {
			return { verdict: 'SKIP', detail: `refused as unhonourable: ${String(errorBody['message'])}` };
		}
		return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
	}

	/**
	 * Trap two: a tool is declared and a prompt that calls for it is sent. A returned tool call is
	 * `PASS`; the model answering in words instead is `WARN`, never `FAIL`, because whether a model
	 * calls a tool is a choice it makes afresh on every request.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testToolsToolCallReturned(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [{ role: 'user', content: 'What is the current weather in Paris? Use the tool to find out.' }],
			tools: [Gate._weatherTool],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const choice = Gate._firstChoice(json);
		const toolCalls = Gate._asRecord(choice?.['message'])?.['tool_calls'];
		if (Array.isArray(toolCalls) && toolCalls.length > 0) {
			return { verdict: 'PASS', detail: `${toolCalls.length} tool call(s) returned` };
		}
		const content = Gate._asRecord(choice?.['message'])?.['content'];
		return { verdict: 'WARN', detail: `the model answered in words instead of calling the tool: ${JSON.stringify(content)}` };
	}

	/**
	 * `response_format: { type: "json_object" }` is honoured: the response is HTTP 200 and its
	 * message content parses as JSON.
	 *
	 * @param endpoint The endpoint to test.
	 * @returns The verdict this run reached.
	 */
	private static async _testStructuredOutputJsonObject(endpoint: Endpoint): Promise<CandidateOutcome> {
		const { status, json } = await Gate._postChatCompletion(endpoint, {
			model: endpoint.model,
			messages: [{ role: 'user', content: 'Reply with a JSON object holding one field, "greeting", set to "hello".' }],
			response_format: { type: 'json_object' },
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const choice = Gate._firstChoice(json);
		const content = Gate._asRecord(choice?.['message'])?.['content'];
		if (typeof content !== 'string') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		try {
			JSON.parse(content);
		} catch {
			return { verdict: 'FAIL', detail: `content is not valid JSON: ${content}` };
		}
		return { verdict: 'PASS', detail: `valid JSON: ${content}` };
	}
}

await Gate.run();
