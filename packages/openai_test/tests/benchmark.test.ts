// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { BenchmarkRunner, type BenchmarkOptions } from '../src/benchmark/benchmark_runner.js';
import { ReportRenderer } from '../src/benchmark/report_renderer.js';
import { StatisticsCalculator } from '../src/benchmark/statistics_calculator.js';
import { reportFormats, type CompletionResult, type CompletionTarget } from '../src/completion_types.js';

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
	Assert.equal(ReportRenderer.isReportFormat('junit'), true);
	Assert.equal(ReportRenderer.isReportFormat('yaml'), false);
	Assert.equal(ReportRenderer.isReportFormat('csv'), false);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	A model the benchmark could not measure at all
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('BenchmarkRunner.runBenchmark measures every model named, and carries on past the one that failed', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{
			target: benchmarkTarget,
			modelIds: ['first-model', 'failing-model', 'second-model'],
			prompt: 'Count up to 30',
			runs: 2,
			warmupRuns: 1,
		},
		async (modelId: string) => {
			if (modelId === 'failing-model') {
				throw new Error('this model answered as somebody else');
			}
			return benchmarkResultOf(modelId, 'one two three', 20, 1020);
		},
	);
	Assert.deepEqual(report.summaries.map((summary) => summary.modelId), ['first-model', 'second-model']);
	Assert.deepEqual(report.failures?.map((failure) => failure.modelId), ['failing-model']);
	Assert.match(report.failures?.[0].reason ?? '', /answered as somebody else/);
	Assert.equal(report.summaries[0].samples.length, 2);
	Assert.equal(report.summaries[0].timeToFirstCharacterMs.average, 20);
	Assert.equal(report.summaries[0].outputCharacters.average, 13);
});

Test('BenchmarkRunner.runBenchmark carries no failure list at all when every model named was measured', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{
			target: benchmarkTarget,
			modelIds: ['first-model'],
			prompt: 'Count up to 30',
			runs: 1,
			warmupRuns: 0,
		},
		async (modelId: string) => benchmarkResultOf(modelId, 'one', 5, 105),
	);
	Assert.equal(report.failures, undefined);
});

Test('BenchmarkRunner.runBenchmark refuses a run in which no model could be measured', async () => {
	await Assert.rejects(
		async () =>
			await BenchmarkRunner.runBenchmark(
				{
					target: benchmarkTarget,
					modelIds: ['failing-model'],
					prompt: 'Count up to 30',
					runs: 1,
					warmupRuns: 0,
				},
				async () => {
					throw new Error('nothing answered');
				},
			),
		/no model was measured/,
	);
});

Test('ReportRenderer.formatBenchmarkReport names the model that could not be measured in every one of the four formats', async () => {
	const report = await BenchmarkRunner.runBenchmark(
		{
			target: benchmarkTarget,
			modelIds: ['first-model', 'failing-model'],
			prompt: 'Count up to 30',
			runs: 1,
			warmupRuns: 0,
		},
		async (modelId: string) => {
			if (modelId === 'failing-model') {
				throw new Error('this model answered as somebody else');
			}
			return benchmarkResultOf(modelId, 'one two three', 20, 1020);
		},
	);
	for (const format of reportFormats) {
		const rendered = ReportRenderer.formatBenchmarkReport(report, format);
		Assert.match(rendered, /failing-model/, `the ${format} format left the failing model out`);
	}
	Assert.match(ReportRenderer.formatBenchmarkReport(report, 'junit'), /failures="1"/);
});
