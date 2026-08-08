// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { BenchmarkRunner, type BenchmarkOptions } from '../src/benchmark_runner.js';
import { CompletionSender } from '../src/completion_sender.js';
import type { CompletionResult, CompletionTarget, UsageOutcome } from '../src/completion_types.js';
import { GenerationControlProber } from '../src/generation_control_prober.js';
import { ModelSweeper } from '../src/model_sweeper.js';
import { ReportRenderer } from '../src/report_renderer.js';
import { StatisticsCalculator } from '../src/statistics_calculator.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const target: CompletionTarget = {
	baseUrl: 'http://direct.test/v1',
	apiKey: 'insecure-benchmark-key',
	timeoutMs: 1_000,
};

const options: BenchmarkOptions = {
	target,
	modelIds: ['a-model'],
	prompt: 'same prompt',
	runs: 2,
	warmupRuns: 1,
};

/**
 * Builds a `CompletionResult` a mock requester can return, so a test states an answer and its
 * Time to First and Time to Last Character without repeating the object shape every time.
 *
 * @param answer The assistant answer text the mock requester returns.
 * @param timeToFirstCharacterMs When the first character arrived, in milliseconds.
 * @param timeToLastCharacterMs When the final character arrived, in milliseconds.
 * @returns The completion result.
 */
function completionResult(answer: string, timeToFirstCharacterMs: number, timeToLastCharacterMs: number): CompletionResult {
	return {
		answer,
		timeToFirstCharacterMs,
		timeToLastCharacterMs,
		clusterGenerationTimeMs: undefined,
		clusterTimeToFirstPieceMs: undefined,
		usage: undefined,
		finishReason: undefined,
	};
}

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

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StatisticsCalculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('calculates the average, median, minimum, and maximum of measured values', () => {
	const statistics = StatisticsCalculator.of([30, 10, 20]);
	Assert.equal(statistics.average, 20);
	Assert.equal(statistics.median, 20);
	Assert.equal(statistics.minimum, 10);
	Assert.equal(statistics.maximum, 30);
});

Test('takes the median of an even number of values as the mean of the two middle ones', () => {
	Assert.equal(StatisticsCalculator.of([10, 20, 30, 50]).median, 25);
});

Test('refuses to calculate statistics when nothing was measured', () => {
	Assert.throws(() => StatisticsCalculator.of([]), /No values were measured/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelSweeper
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const universe = ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_llama3_2_1b_full'];

Test('expands all into every model identifier the subcommand knows about', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('all', universe, 'reject'), universe);
});

Test('expands a pattern into the identifiers it matches, in the order they are declared', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llm_*', universe, 'reject'), ['llm_qwen3_0_6b_sharded', 'llm_llama3_2_1b_full']);
});

Test('expands a comma-separated list without repeating an identifier matched twice', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llm_*,llm_llama3_2_1b_full', universe, 'reject'), ['llm_qwen3_0_6b_sharded', 'llm_llama3_2_1b_full']);
});

Test('rejects a name outside the list when the subcommand can only reach this cluster', () => {
	Assert.throws(() => ModelSweeper.resolveModelIds('llama-3.2-3b-instruct', universe, 'reject'), /No model matches "llama-3\.2-3b-instruct"/);
});

Test('passes a name outside the list through unchanged when the subcommand can reach any endpoint', () => {
	Assert.deepEqual(ModelSweeper.resolveModelIds('llama-3.2-3b-instruct', universe, 'accept'), ['llama-3.2-3b-instruct']);
});

Test('mixes known identifiers and an outside name in one comma-separated list', () => {
	Assert.deepEqual(
		ModelSweeper.resolveModelIds('dev_formula,llama-3.2-3b-instruct', universe, 'accept'),
		['dev_formula', 'llama-3.2-3b-instruct'],
	);
});

Test('rejects a pattern that matches nothing even when an outside name would be accepted', () => {
	Assert.throws(() => ModelSweeper.resolveModelIds('nothing_*', universe, 'accept'), /No model matches "nothing_\*"/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkRunner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('summarizes every metric from measured samples', () => {
	const summary = BenchmarkRunner.summarizeSamples(target.baseUrl, 'a-model', [
		{
			run: 1,
			timeToFirstCharacterMs: 10,
			timeToLastCharacterMs: 110,
			outputCharactersPerSecond: 200,
			inputCharacters: 12,
			outputCharacters: 20,
		},
		{
			run: 2,
			timeToFirstCharacterMs: 30,
			timeToLastCharacterMs: 130,
			outputCharactersPerSecond: 400,
			inputCharacters: 12,
			outputCharacters: 40,
		},
	]);
	Assert.equal(summary.timeToFirstCharacterMs.average, 20);
	Assert.equal(summary.timeToFirstCharacterMs.median, 20);
	Assert.equal(summary.timeToFirstCharacterMs.minimum, 10);
	Assert.equal(summary.timeToFirstCharacterMs.maximum, 30);
	Assert.equal(summary.timeToLastCharacterMs.average, 120);
	Assert.equal(summary.outputCharactersPerSecond.average, 300);
	Assert.equal(summary.inputCharacters, 12);
	Assert.equal(summary.outputCharacters.average, 30);
});

Test('computes Output Characters per Second from the Time to First and Time to Last Character of the completion', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('0123456789', 100, 600));
	const sample = report.summaries[0].samples[0];
	Assert.equal(sample.timeToFirstCharacterMs, 100);
	Assert.equal(sample.timeToLastCharacterMs, 600);
	Assert.equal(sample.outputCharacters, 10);
	Assert.equal(sample.inputCharacters, options.prompt.length);
	// 10 characters over the 500 ms between the Time to First Character and the Time to Last Character is 20 characters per second.
	Assert.equal(sample.outputCharactersPerSecond, 20);
});

Test('floors the streaming duration at 1 ms rather than dividing by zero when the Time to First Character equals the Time to Last Character', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('whole answer', 50, 50));
	Assert.equal(report.summaries[0].samples[0].outputCharactersPerSecond, 'whole answer'.length * 1_000);
});

Test('runs the warm-ups and then the measured requests in strict sequence', async () => {
	const calls: string[] = [];
	const report = await BenchmarkRunner.runBenchmark(options, async (modelId, prompt) => {
		calls.push(`${modelId}:${prompt}`);
		return completionResult('the answer', 5, 50);
	});

	// One warm-up request plus the two measured runs from `options`.
	Assert.deepEqual(calls, [
		'a-model:same prompt',
		'a-model:same prompt',
		'a-model:same prompt',
	]);
	Assert.equal(report.settings.parallelism, 1);
	Assert.equal(report.summaries[0].outputCharacters.average, 'the answer'.length);
});

Test('measures every named model one after the other, finishing one before starting the next', async () => {
	const calls: string[] = [];
	const report = await BenchmarkRunner.runBenchmark(
		{ ...options, modelIds: ['first-model', 'second-model'], runs: 2, warmupRuns: 0 },
		async (modelId) => {
			calls.push(modelId);
			return completionResult('the answer', 5, 50);
		},
	);

	Assert.deepEqual(calls, ['first-model', 'first-model', 'second-model', 'second-model']);
	Assert.equal(report.summaries.length, 2);
	Assert.equal(report.summaries[0].modelId, 'first-model');
	Assert.equal(report.summaries[1].modelId, 'second-model');
});

Test('refuses request counts that are not whole numbers in range', async () => {
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, runs: 0 }, async () => completionResult('a', 1, 2)), /--runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, warmupRuns: -1 }, async () => completionResult('a', 1, 2)), /--warmup_runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, modelIds: [] }, async () => completionResult('a', 1, 2)), /--model/);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportRenderer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('writes the same benchmark report out as text, markdown, and JSON', async () => {
	const report = await BenchmarkRunner.runBenchmark(options, async () => completionResult('the answer', 5, 50));

	const text = ReportRenderer.formatBenchmarkReport(report, 'text');
	Assert.match(text, /OpenAI API benchmark \(parallelism: 1\)/);
	Assert.match(text, /Time to First Character:/);
	Assert.match(text, /Time to Last Character:/);
	Assert.match(text, /Output Characters per Second:/);
	Assert.match(text, new RegExp(target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	Assert.match(markdown, /^# OpenAI API benchmark/);
	Assert.match(markdown, /\| Base URL \| Model \| Time to First Character \| Time to Last Character \| Output Characters per Second \| Input Characters \| Output Characters \|/);
	Assert.match(markdown, new RegExp(`\\| ${target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`));

	const json = ReportRenderer.formatBenchmarkReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summaries[0].baseUrl, target.baseUrl);
	Assert.equal(typeof parsed.summaries[0].timeToFirstCharacterMs.average, 'number');
});

Test('gives every measured model its own markdown row', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{ ...options, modelIds: ['first-model', 'second-model'], runs: 1, warmupRuns: 0 },
		async () => completionResult('the answer', 5, 50),
	);
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	Assert.match(markdown, /\| first-model \|/);
	Assert.match(markdown, /\| second-model \|/);
});

Test('accepts only the report formats it knows about', () => {
	Assert.equal(ReportRenderer.isReportFormat('text'), true);
	Assert.equal(ReportRenderer.isReportFormat('markdown'), true);
	Assert.equal(ReportRenderer.isReportFormat('json'), true);
	Assert.equal(ReportRenderer.isReportFormat('yaml'), false);
});

Test('describes a swept pair as one line, and a skipped pair by why it was skipped', () => {
	const okLine = ReportRenderer.sweepOutcomeLine({
		modelId: 'dev_formula',
		mode: 'nostream',
		status: 'ok',
		timeToFirstCharacterMs: 244.4,
		timeToLastCharacterMs: 244.4,
		characterCount: 2,
		answer: '17',
		failureMessage: undefined,
	});
	Assert.equal(okLine, 'dev_formula (nostream): ok — first character in 244 ms, last character in 244 ms, 2 characters');

	const skippedLine = ReportRenderer.sweepOutcomeLine({
		modelId: 'dev_formula',
		mode: 'streamed',
		status: 'skipped',
		timeToFirstCharacterMs: 0,
		timeToLastCharacterMs: 0,
		characterCount: 0,
		answer: '',
		failureMessage: 'it answers with one number',
	});
	Assert.equal(skippedLine, 'dev_formula (streamed): skipped — it answers with one number');
});

Test('counts passed, skipped, and failed pairs in the sweep summary', () => {
	const lines = ReportRenderer.sweepSummaryLines([
		{ modelId: 'a', mode: 'nostream', status: 'ok', timeToFirstCharacterMs: 1, timeToLastCharacterMs: 2, characterCount: 3, answer: 'abc', failureMessage: undefined },
		{ modelId: 'a', mode: 'streamed', status: 'skipped', timeToFirstCharacterMs: 0, timeToLastCharacterMs: 0, characterCount: 0, answer: '', failureMessage: 'why' },
		{ modelId: 'b', mode: 'nostream', status: 'failed', timeToFirstCharacterMs: 5, timeToLastCharacterMs: 5, characterCount: 0, answer: '', failureMessage: 'no worker' },
	]);
	Assert.equal(lines[lines.length - 1], '1/3 passed, 1 skipped, 1 failed');
});

const sweepOutcomes = [
	{ modelId: 'a', mode: 'nostream' as const, status: 'ok' as const, timeToFirstCharacterMs: 1, timeToLastCharacterMs: 2, characterCount: 3, answer: 'abc', failureMessage: undefined },
	{ modelId: 'a', mode: 'streamed' as const, status: 'skipped' as const, timeToFirstCharacterMs: 0, timeToLastCharacterMs: 0, characterCount: 0, answer: '', failureMessage: 'why' },
	{ modelId: 'b', mode: 'nostream' as const, status: 'failed' as const, timeToFirstCharacterMs: 5, timeToLastCharacterMs: 5, characterCount: 0, answer: '', failureMessage: 'no worker' },
];

Test('gives every swept pair its own markdown row, with the passed/skipped/failed counts below the table', () => {
	const markdown = ReportRenderer.formatSweepReport(sweepOutcomes, 'markdown');
	Assert.match(markdown, /^# OpenAI API sweep/);
	Assert.match(markdown, /\| Model \| Mode \| Status \| Time to First Character \| Time to Last Character \| Characters \| Cluster Generation Time \| Failure \|/);
	Assert.match(markdown, /\| a \| nostream \| ok \|/);
	Assert.match(markdown, /\| a \| streamed \| skipped \|/);
	Assert.match(markdown, /\| b \| nostream \| failed \|/);
	Assert.match(markdown, /1\/3 passed, 1 skipped, 1 failed/);
});

Test('writes every swept pair and the passed/skipped/failed counts as JSON', () => {
	const json = ReportRenderer.formatSweepReport(sweepOutcomes, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.outcomes.length, 3);
	Assert.equal(parsed.outcomes[0].modelId, 'a');
	Assert.deepEqual(parsed.summary, { passed: 1, skipped: 1, failed: 1, total: 3 });
});

const historySweepOutcomes = [
	{
		modelId: 'a',
		mode: 'nostream' as const,
		status: 'ok' as const,
		timeToFirstCharacterMs: 1,
		timeToLastCharacterMs: 2,
		characterCount: 3,
		answer: 'Ada, Lisp',
		failureMessage: undefined,
		turns: [
			{ role: 'user' as const, content: 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.' },
			{ role: 'assistant' as const, content: 'Hello Ada!' },
			{ role: 'user' as const, content: 'What is my name, and what is my favorite programming language? Answer in one short sentence.' },
			{ role: 'assistant' as const, content: 'Ada, Lisp' },
		],
	},
];

Test("lists every history turn and its role under a Turns section, naming the swept model and mode", () => {
	const markdown = ReportRenderer.formatSweepReport(historySweepOutcomes, 'markdown');
	Assert.match(markdown, /## Turns/);
	Assert.match(markdown, /### a \(nostream\)/);
	Assert.match(markdown, /- \*\*user\*\*: My name is Ada/);
	Assert.match(markdown, /- \*\*assistant\*\*: Hello Ada!/);
});

Test('leaves out the Turns section when no outcome carries turns', () => {
	const markdown = ReportRenderer.formatSweepReport(sweepOutcomes, 'markdown');
	Assert.doesNotMatch(markdown, /## Turns/);
});

Test('carries every history turn and its role through the JSON sweep report', () => {
	const json = ReportRenderer.formatSweepReport(historySweepOutcomes, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.outcomes[0].turns.length, 4);
	Assert.deepEqual(parsed.outcomes[0].turns[0], { role: 'user', content: 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.' });
});

const usageOutcomes: UsageOutcome[] = [
	{
		modelId: 'llm_qwen3_5_0_8b_full',
		mode: 'nostream',
		status: 'ok',
		usagePresent: true,
		usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
		finishReason: 'stop',
		failureMessage: undefined,
	},
	{
		modelId: 'llm_gemma_nano_chrome_full',
		mode: 'nostream',
		status: 'ok',
		usagePresent: false,
		usage: undefined,
		finishReason: 'stop',
		failureMessage: undefined,
	},
	{
		modelId: 'dev_formula',
		mode: 'streamed',
		status: 'skipped',
		usagePresent: false,
		usage: undefined,
		finishReason: undefined,
		failureMessage: 'it answers with one number',
	},
	{
		modelId: 'llm_llama3_2_1b_full',
		mode: 'nostream',
		status: 'failed',
		usagePresent: false,
		usage: undefined,
		finishReason: undefined,
		failureMessage: 'no worker',
	},
];

Test('describes a usage outcome by whether usage was present, its token counts, and its finish_reason', () => {
	Assert.equal(
		ReportRenderer.usageOutcomeLine(usageOutcomes[0]),
		'llm_qwen3_5_0_8b_full (nostream): ok — usage present, prompt_tokens 7, completion_tokens 3, total_tokens 10, finish_reason stop',
	);
	Assert.equal(
		ReportRenderer.usageOutcomeLine(usageOutcomes[1]),
		'llm_gemma_nano_chrome_full (nostream): ok — usage not reported, finish_reason stop',
	);
	Assert.equal(
		ReportRenderer.usageOutcomeLine(usageOutcomes[2]),
		'dev_formula (streamed): skipped — it answers with one number',
	);
});

Test('counts how many pairs reported usage in the usage sweep summary', () => {
	const lines = ReportRenderer.usageSummaryLines(usageOutcomes);
	Assert.equal(lines[lines.length - 1], '1/4 reported usage, 1 skipped, 1 failed');
});

Test('gives every usage pair its own markdown row, with the reported/skipped/failed counts below the table', () => {
	const markdown = ReportRenderer.formatUsageReport(usageOutcomes, 'markdown');
	Assert.match(markdown, /^# OpenAI API usage sweep/);
	Assert.match(markdown, /\| Model \| Mode \| Status \| Usage Present \| Prompt Tokens \| Completion Tokens \| Total Tokens \| Finish Reason \| Failure \|/);
	Assert.match(markdown, /\| llm_qwen3_5_0_8b_full \| nostream \| ok \| yes \| 7 \| 3 \| 10 \| stop \|/);
	Assert.match(markdown, /\| llm_gemma_nano_chrome_full \| nostream \| ok \| no \|/);
	Assert.match(markdown, /1\/4 reported usage, 1 skipped, 1 failed/);
});

Test('writes every usage pair and the reported/skipped/failed counts as JSON', () => {
	const json = ReportRenderer.formatUsageReport(usageOutcomes, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.outcomes.length, 4);
	Assert.deepEqual(parsed.outcomes[0].usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
	Assert.deepEqual(parsed.summary, { reportingUsage: 1, skipped: 1, failed: 1, total: 4 });
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('reads Time to First and Time to Last Character from a real server-sent event stream, spaced out over real wall-clock time', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
		});
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
		setTimeout(() => {
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`);
			setTimeout(() => {
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ', world' } }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
				response.write('data: [DONE]\n\n');
				response.end();
			}, 60);
		}, 40);
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const pieces: string[] = [];
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			mode: 'streamed',
			writePiece: (piece) => pieces.push(piece),
		});
		Assert.equal(result.answer, 'Hello, world');
		Assert.deepEqual(pieces, ['Hello', ', world']);
		// The two content chunks are spaced 40 ms and then 60 ms apart, so the Time to First
		// Character must land after roughly the first wait and the Time to Last Character after
		// roughly both — proof this measures real elapsed wall-clock time from a real streamed
		// connection, not just the shape of the numbers.
		Assert.ok(result.timeToFirstCharacterMs >= 30, `expected the Time to First Character to reflect the 40 ms wait, got ${result.timeToFirstCharacterMs} ms`);
		Assert.ok(
			result.timeToLastCharacterMs >= result.timeToFirstCharacterMs + 50,
			`expected the Time to Last Character to be at least ~60 ms after the Time to First Character, got Time to First Character ${result.timeToFirstCharacterMs} ms and Time to Last Character ${result.timeToLastCharacterMs} ms`,
		);
	} finally {
		await server.stop();
	}
});

Test('reads the cluster generation-time header the streamed mode names, and leaves the whole-answer one unset', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'X-Webai-Time-To-First-Piece-Ms': '42',
		});
		response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
		response.write('data: [DONE]\n\n');
		response.end();
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'streamed',
		});
		Assert.equal(result.clusterTimeToFirstPieceMs, 42);
		Assert.equal(result.clusterGenerationTimeMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('reads the cluster generation-time header the whole-answer mode names, and leaves the streamed one unset', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
			'X-Webai-Generation-Time-Ms': '99',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'nostream',
		});
		Assert.equal(result.clusterGenerationTimeMs, 99);
		Assert.equal(result.clusterTimeToFirstPieceMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('reports no cluster generation time at all against an endpoint that sends neither header', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'nostream',
		});
		Assert.equal(result.clusterGenerationTimeMs, undefined);
		Assert.equal(result.clusterTimeToFirstPieceMs, undefined);
	} finally {
		await server.stop();
	}
});

Test('falls back to one whole request when the endpoint ignores the streaming request and answers with one JSON body', async () => {
	// The `openai` npm package reads such a body as a stream carrying no pieces at all, so
	// without the fallback this endpoint would look like one that answered with nothing.
	const requestedStreams: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreams.push(JSON.parse(body).stream);
			response.writeHead(200, {
				'Content-Type': 'application/json',
			});
			response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer, no streaming' } }] }));
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [
				{
					role: 'user',
					content: 'say hello',
				},
			],
			mode: 'streamed',
		});
		Assert.equal(result.answer, 'whole answer, no streaming');
		Assert.equal(result.timeToFirstCharacterMs, result.timeToLastCharacterMs);
		Assert.deepEqual(requestedStreams, [true, undefined]);
	} finally {
		await server.stop();
	}
});

Test('reports an endpoint that answered with no text at all as a failure', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		await Assert.rejects(
			async () => CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				mode: 'nostream',
			}),
			/no answer text/,
		);
	} finally {
		await server.stop();
	}
});

Test('reads usage and finish_reason straight from the nostream response body', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({
			choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
		}));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'nostream',
		});
		Assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('leaves usage undefined when the nostream response body carries none', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(200, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }] }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'nostream',
		});
		Assert.equal(result.usage, undefined);
	} finally {
		await server.stop();
	}
});

Test('asks for and reads usage from the final, choice-less streamed chunk only when includeUsage is set', async () => {
	const requestedStreamOptions: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreamOptions.push(JSON.parse(body).stream_options);
			response.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
			});
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }], usage: null })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'streamed',
			includeUsage: true,
		});
		Assert.deepEqual(requestedStreamOptions, [{ include_usage: true }]);
		Assert.deepEqual(result.usage, { promptTokens: 4, completionTokens: 1, totalTokens: 5 });
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('sends no stream_options at all when includeUsage is left out, exactly as completion/history/benchmark already do', async () => {
	const requestedStreamOptions: unknown[] = [];
	const server = await startTestServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on('end', () => {
			requestedStreamOptions.push(JSON.parse(body).stream_options);
			response.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
			});
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hi' } }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
			response.write('data: [DONE]\n\n');
			response.end();
		});
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		const result = await CompletionSender.send({
			client,
			modelId: 'irrelevant-to-this-test',
			messages: [{ role: 'user', content: 'say hi' }],
			mode: 'streamed',
		});
		Assert.deepEqual(requestedStreamOptions, [undefined]);
		Assert.equal(result.usage, undefined);
		Assert.equal(result.finishReason, 'stop');
	} finally {
		await server.stop();
	}
});

Test('reports a refusal from the endpoint in words rather than as a stack trace', async () => {
	const server = await startTestServer((request, response) => {
		response.writeHead(503, {
			'Content-Type': 'application/json',
		});
		response.end(JSON.stringify({ error: { message: 'no worker is offering this work', code: 'no_worker' } }));
	});
	try {
		const client = CompletionSender.createClient({
			baseUrl: server.baseUrl,
			apiKey: 'insecure-benchmark-key',
			timeoutMs: 5_000,
		});
		try {
			await CompletionSender.send({
				client,
				modelId: 'irrelevant-to-this-test',
				messages: [
					{
						role: 'user',
						content: 'say hello',
					},
				],
				mode: 'nostream',
			});
			Assert.fail('the request should have been refused');
		} catch (error: unknown) {
			const message = CompletionSender.describeFailure(error);
			Assert.match(message, /^HTTP 503 \(no_worker\)/);
			Assert.match(message, /no worker is offering this work/);
		}
	} finally {
		await server.stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
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
		mode: 'nostream',
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
