// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { BenchmarkRunner, type BenchmarkOptions } from '../src/benchmark/benchmark_runner.js';
import { ReportRenderer } from '../src/benchmark/report_renderer.js';
import { StatisticsCalculator } from '../src/benchmark/statistics_calculator.js';
import { reportFormats, type CompletionResult, type CompletionTarget } from '../src/completion_types.js';
import { ReportParameters } from '../src/report_parameters.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The benchmark subcommand: the statistics, the runner, and the four report formats
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const target: CompletionTarget = {
	baseUrl: 'http://direct.test/v1',
	apiKey: 'insecure-benchmark-key',
	timeoutMs: 1_000,
};

const options: BenchmarkOptions = {
	target,
	modelId: 'a-model',
	prompt: 'same prompt',
	runs: 2,
	warmupRuns: 1,
	thinkingSetting: 'off',
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
		reportedModelId: undefined,
		timeToFirstCharacterMs,
		timeToLastCharacterMs,
		clusterGenerationTimeMs: undefined,
		clusterTimeToFirstPieceMs: undefined,
		usage: undefined,
		finishReason: undefined,
		toolCalls: [],
	};
}

/** The endpoint the benchmark tests name, which no test of this section ever reaches. */
const benchmarkTarget: CompletionTarget = {
	baseUrl: 'http://localhost:1234/v1',
	apiKey: 'no-key-required',
	timeoutMs: 600_000,
};

/**
 * Builds one whole completion result out of the three things a benchmark sample is built from, so a
 * test states those three and nothing else.
 *
 * @param modelId The model identifier the answer names.
 * @param answer The assistant answer, read for its character count.
 * @param timeToFirstCharacterMs Time to First Character, in milliseconds.
 * @param timeToLastCharacterMs Time to Last Character, in milliseconds.
 * @returns The completion result a fake requester answers with.
 */
function benchmarkResultOf(modelId: string, answer: string, timeToFirstCharacterMs: number, timeToLastCharacterMs: number): CompletionResult {
	return {
		answer,
		reportedModelId: modelId,
		timeToFirstCharacterMs,
		timeToLastCharacterMs,
		clusterGenerationTimeMs: undefined,
		clusterTimeToFirstPieceMs: undefined,
		usage: undefined,
		finishReason: 'stop',
		toolCalls: [],
	};
}

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
	const sample = report.summary.samples[0];
	Assert.equal(sample.timeToFirstCharacterMs, 100);
	Assert.equal(sample.timeToLastCharacterMs, 600);
	Assert.equal(sample.outputCharacters, 10);
	Assert.equal(sample.inputCharacters, options.prompt.length);
	// 10 characters over the 500 ms between the Time to First Character and the Time to Last Character is 20 characters per second.
	Assert.equal(sample.outputCharactersPerSecond, 20);
});

Test('floors the streaming duration at 1 ms rather than dividing by zero when the Time to First Character equals the Time to Last Character', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('whole answer', 50, 50));
	Assert.equal(report.summary.samples[0].outputCharactersPerSecond, 'whole answer'.length * 1_000);
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
	Assert.equal(report.summary.outputCharacters.average, 'the answer'.length);
});

Test('tells the listener about every warm-up and every measured request, in the order they were sent', async () => {
	const announced: string[] = [];
	await BenchmarkRunner.runBenchmark(
		{
			...options,
			runs: 2,
			warmupRuns: 1,
			listener: {
				onWarmupRequestStarted: (modelId, warmupRun, warmupRuns) => announced.push(`warm-up started ${modelId} ${warmupRun}/${warmupRuns}`),
				onWarmupRequestFinished: (modelId) => announced.push(`warm-up finished ${modelId}`),
				onMeasuredRequestStarted: (modelId, run, runs) => announced.push(`measured started ${modelId} ${run}/${runs}`),
				onMeasuredRequestFinished: (modelId, sample) => announced.push(`measured finished ${modelId} ${sample.run} ${sample.outputCharacters}`),
			},
		},
		async () => completionResult('the answer', 5, 50),
	);

	Assert.deepEqual(announced, [
		'warm-up started a-model 1/1',
		'warm-up finished a-model',
		'measured started a-model 1/2',
		'measured finished a-model 1 10',
		'measured started a-model 2/2',
		'measured finished a-model 2 10',
	]);
});

Test('refuses request counts that are not whole numbers in range', async () => {
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, runs: 0 }, async () => completionResult('a', 1, 2)), /--runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, warmupRuns: -1 }, async () => completionResult('a', 1, 2)), /--warmup_runs/);
	await Assert.rejects(async () => BenchmarkRunner.runBenchmark({ ...options, modelId: '   ' }, async () => completionResult('a', 1, 2)), /--model/);
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
	Assert.match(markdown, /^# OpenAI API Benchmark Report/);
	Assert.match(markdown, /## Measurements/);
	Assert.match(markdown, /\| Metric \| Average \| Median \| Minimum \| Maximum \|/);
	Assert.match(markdown, new RegExp(`- Endpoint: \`${target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));

	const json = ReportRenderer.formatBenchmarkReport(report, 'json');
	const parsed = JSON.parse(json);
	Assert.equal(parsed.settings.runs, options.runs);
	Assert.equal(parsed.summary.baseUrl, target.baseUrl);
	Assert.equal(typeof parsed.summary.timeToFirstCharacterMs.average, 'number');
});

Test('names the one model measured, and the endpoint it was measured on, in the measurement run section', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('the answer', 5, 50));
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	Assert.match(markdown, /- Model: `a-model`/);
	Assert.match(markdown, new RegExp(`- Endpoint: \`${target.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
	// The default `--runs 1`, said in words rather than as "1 times".
	Assert.match(markdown, /The model was sent the same prompt once/);
	Assert.match(markdown, /No warm-up request was sent at all/);
});

Test('the markdown report says what each measured figure means, and lists every measured request behind the averages', async () => {
	const timings = [
		[10, 110],
		[30, 130],
	];
	let sent = 0;
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 2, warmupRuns: 1 }, async () => {
		const timing = timings[Math.min(Math.max(sent - 1, 0), timings.length - 1)];
		sent += 1;
		return completionResult('0123456789', timing[0], timing[1]);
	});
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');

	// What the run was, in words, so that a report file found months later needs nothing else read
	// beside it to be understood.
	Assert.match(markdown, /## What Was Measured/);
	Assert.match(markdown, /The model was sent the same prompt 2 times/);
	Assert.match(markdown, /One warm-up request was sent first and its answer thrown away/);
	Assert.match(markdown, /\| Time to First Character \| How long from sending the request/);
	Assert.match(markdown, /None of the five is a token count\./);
	// The one setting that moves Time to First Character the most is named in words, not left to a
	// reader to work out from the parameter table.
	Assert.match(markdown, /Every request carried `reasoning_effort: "none"`/);

	// Every measured request of its own, because the spread between them is what says how much to
	// trust the average above them.
	Assert.match(markdown, /### Every Measured Request/);
	Assert.match(markdown, /\| 1 \| 10\.00 ms \| 110\.00 ms \|/);
	Assert.match(markdown, /\| 2 \| 30\.00 ms \| 130\.00 ms \|/);
	Assert.match(markdown, /\| Time to First Character \| 20\.00 ms \| 20\.00 ms \| 10\.00 ms \| 30\.00 ms \|/);
});

Test('the markdown report carries the generation date, the parameters, and the command line it was given', async () => {
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('the answer', 5, 50));
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown', {
		generatedAt: new Date('2026-08-19T00:00:00.000Z'),
		parameters: ReportParameters.ofBenchmarkOptions({
			model: 'a-model',
			prompt: 'Count up to 30',
			runs: '3',
			warmup_runs: '1',
			thinking: 'off',
			base_url: 'https://api.openai.test/v1',
			api_key: 'sk-a-real-secret-key',
			timeout_ms: '600000',
			format: 'markdown',
		}),
		commandLine: 'openai_test benchmark --model a-model',
	});

	Assert.match(markdown, /- Generated: 2026-08-19T00:00:00\.000Z/);
	Assert.match(markdown, /```bash\nopenai_test benchmark --model a-model\n```/);
	Assert.match(markdown, /\| `--runs` \| 3 \|/);
	Assert.match(markdown, /\| `--warmup_runs` \| 1 \|/);
	Assert.match(markdown, /\| `--thinking` \| off \|/);
	Assert.match(markdown, /\| `--prompt` \| Count up to 30 \|/);
	// The bearer token never reaches a report, in either the parameter list or the command line.
	Assert.equal(markdown.includes('sk-a-real-secret-key'), false, markdown);
	Assert.match(markdown, /\| `--api_key` \| <redacted> \|/);
});

Test('the markdown report stamps the moment it rendered when the caller offers no generation date', async () => {
	const before = new Date();
	const report = await BenchmarkRunner.runBenchmark({ ...options, runs: 1, warmupRuns: 0 }, async () => completionResult('the answer', 5, 50));
	const markdown = ReportRenderer.formatBenchmarkReport(report, 'markdown');
	const stamped = /- Generated: (\S+)/.exec(markdown)?.[1];
	Assert.notEqual(stamped, undefined, markdown);
	Assert.equal(new Date(String(stamped)).getTime() >= before.getTime(), true, `stamped ${String(stamped)}`);
});

Test('says in every format whether the model was allowed to think', async () => {
	const thinking = await BenchmarkRunner.runBenchmark(
		{ ...options, runs: 1, warmupRuns: 0, thinkingSetting: 'on' },
		async () => completionResult('the answer', 5, 50),
	);
	Assert.equal(thinking.settings.thinkingSetting, 'on');
	Assert.match(ReportRenderer.formatBenchmarkReport(thinking, 'text'), /thinking: on/);
	Assert.match(ReportRenderer.formatBenchmarkReport(thinking, 'markdown'), /No thinking field was sent, so the endpoint applied its own default\./);
	Assert.match(ReportRenderer.formatBenchmarkReport(thinking, 'junit'), /<property name="thinking" value="on"\/>/);
	Assert.equal(JSON.parse(ReportRenderer.formatBenchmarkReport(thinking, 'json')).settings.thinkingSetting, 'on');

	const notThinking = await BenchmarkRunner.runBenchmark(
		{ ...options, runs: 1, warmupRuns: 0, thinkingSetting: 'off' },
		async () => completionResult('the answer', 5, 50),
	);
	Assert.match(ReportRenderer.formatBenchmarkReport(notThinking, 'text'), /thinking: off/);
	Assert.match(ReportRenderer.formatBenchmarkReport(notThinking, 'junit'), /<property name="thinking" value="off"\/>/);
});

Test('accepts only the report formats it knows about', () => {
	Assert.equal(ReportRenderer.isReportFormat('text'), true);
	Assert.equal(ReportRenderer.isReportFormat('markdown'), true);
	Assert.equal(ReportRenderer.isReportFormat('json'), true);
	Assert.equal(ReportRenderer.isReportFormat('junit'), true);
	Assert.equal(ReportRenderer.isReportFormat('yaml'), false);
	Assert.equal(ReportRenderer.isReportFormat('csv'), false);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	A model the benchmark could not measure at all
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('BenchmarkRunner.runBenchmark measures the one model named, and reports what it measured', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{
			target: benchmarkTarget,
			modelId: 'first-model',
			prompt: 'Count up to 30',
			runs: 2,
			warmupRuns: 1,
			thinkingSetting: 'off',
		},
		async (modelId: string) => benchmarkResultOf(modelId, 'one two three', 20, 1020),
	);
	Assert.equal(report.summary.modelId, 'first-model');
	Assert.equal(report.summary.samples.length, 2);
	Assert.equal(report.summary.timeToFirstCharacterMs.average, 20);
	Assert.equal(report.summary.outputCharacters.average, 13);
});

Test('BenchmarkRunner.runBenchmark refuses a run whose one model could not be measured, naming the model and the reason', async () => {
	await Assert.rejects(
		async () =>
			await BenchmarkRunner.runBenchmark(
				{
					target: benchmarkTarget,
					modelId: 'failing-model',
					prompt: 'Count up to 30',
					runs: 1,
					warmupRuns: 0,
					thinkingSetting: 'off',
				},
				async () => {
					throw new Error('this model answered as somebody else');
				},
			),
		/"failing-model" was not measured: .*answered as somebody else/,
	);
});

Test('ReportRenderer.formatBenchmarkReport names the one model measured in every one of the four formats', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{
			target: benchmarkTarget,
			modelId: 'first-model',
			prompt: 'Count up to 30',
			runs: 1,
			warmupRuns: 0,
			thinkingSetting: 'off',
		},
		async (modelId: string) => benchmarkResultOf(modelId, 'one two three', 20, 1020),
	);
	for (const format of reportFormats) {
		const rendered = ReportRenderer.formatBenchmarkReport(report, format);
		Assert.match(rendered, /first-model/, `the ${format} format left the measured model out`);
	}
	Assert.match(ReportRenderer.formatBenchmarkReport(report, 'junit'), /tests="1" failures="0"/);
});
