// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { BenchmarkRunner } from '../src/benchmark/benchmark_runner.js';
import { ReportRenderer } from '../src/benchmark/report_renderer.js';
import { StatisticsCalculator } from '../src/benchmark/statistics_calculator.js';
import { ChatCommand } from '../src/chat/chat_command.js';
import { CompletionSender } from '../src/clients/completion_sender.js';
import { reportFormats, type CompletionResult, type CompletionTarget } from '../src/completion_types.js';
import { SharedOptions } from '../src/shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Helpers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Starts a local HTTP server that answers one streamed chat completion, naming whichever model
 * identifier the caller asks it to name.
 *
 * This is how the substitution LM Studio 0.4.20 performs is reproduced without LM Studio: a server
 * that answers HTTP 200 to a request naming one model, with a body naming another. See
 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
 *
 * @param reportedModelId The model identifier the answer names, whatever the request asked for.
 * @param answer The assistant answer text the server streams, one chunk per character.
 * @returns The base URL to point a client at, and how to stop the server again.
 */
async function startStreamingServer(reportedModelId: string, answer: string): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
	const server = Http.createServer((request, response) => {
		response.writeHead(200, {
			'content-type': 'text/event-stream',
		});
		for (const piece of answer) {
			const chunk = {
				id: 'chatcmpl-test',
				object: 'chat.completion.chunk',
				created: 1,
				model: reportedModelId,
				choices: [
					{
						index: 0,
						delta: {
							content: piece,
						},
						finish_reason: null,
					},
				],
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		response.write('data: [DONE]\n\n');
		response.end();
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the test server did not report a port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		stop: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

/**
 * Builds an endpoint pointed at a local test server.
 *
 * @param baseUrl The base URL the test server is listening on.
 * @returns The endpoint to hand to `CompletionSender.createClient`.
 */
function targetOf(baseUrl: string): CompletionTarget {
	return {
		baseUrl,
		apiKey: 'no-key-required',
		timeoutMs: 5_000,
	};
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Reported Model Identifier Check
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test.describe('CompletionSender.isReportedModelIdAcceptable', () => {
	Test.it('accepts an endpoint that names exactly the requested model identifier', () => {
		Assert.equal(CompletionSender.isReportedModelIdAcceptable('llama-3.2-1b-instruct', 'llama-3.2-1b-instruct'), true);
	});

	Test.it('accepts an endpoint that resolved an alias to a longer, dated identifier', () => {
		Assert.equal(CompletionSender.isReportedModelIdAcceptable('gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'), true);
	});

	Test.it('accepts an endpoint that named no model at all', () => {
		Assert.equal(CompletionSender.isReportedModelIdAcceptable('llama-3.2-1b-instruct', undefined), true);
	});

	Test.it('refuses an endpoint that answered as a different model', () => {
		Assert.equal(CompletionSender.isReportedModelIdAcceptable('text-embedding-nomic-embed-text-v1.5', 'llama-3.2-1b-instruct'), false);
	});

	Test.it('refuses an endpoint that answered as a shorter identifier than the one requested', () => {
		Assert.equal(CompletionSender.isReportedModelIdAcceptable('gpt-4.1-mini-2025-04-14', 'gpt-4.1-mini'), false);
	});
});

Test.describe('CompletionSender.assertReportedModelId', () => {
	Test.it('names both model identifiers when it refuses one', () => {
		Assert.throws(
			() => CompletionSender.assertReportedModelId('this-model-does-not-exist-at-all', 'qwen_qwen3-0.6b'),
			/this-model-does-not-exist-at-all[\s\S]*qwen_qwen3-0\.6b|qwen_qwen3-0\.6b[\s\S]*this-model-does-not-exist-at-all/,
		);
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sending One Turn
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test.describe('CompletionSender.send, streamed, against a local server', () => {
	Test.it('streams every piece and reports the model the endpoint named', async () => {
		const server = await startStreamingServer('a-model', 'Paris');
		try {
			const pieces: string[] = [];
			const result = await CompletionSender.send({
				client: CompletionSender.createClient(targetOf(server.baseUrl)),
				modelId: 'a-model',
				messages: [
					{
						role: 'user',
						content: 'What is the capital of France?',
					},
				],
				mode: 'streamed',
				writePiece: (piece: string) => pieces.push(piece),
			});
			Assert.equal(result.answer, 'Paris');
			Assert.deepEqual(pieces, ['P', 'a', 'r', 'i', 's']);
			Assert.equal(result.reportedModelId, 'a-model');
			Assert.ok(result.timeToFirstCharacterMs <= result.timeToLastCharacterMs);
		} finally {
			await server.stop();
		}
	});

	Test.it('fails the request when the endpoint answered as a model nobody asked for', async () => {
		const server = await startStreamingServer('a-substitute-model', 'Paris');
		try {
			await Assert.rejects(
				async () =>
					await CompletionSender.send({
						client: CompletionSender.createClient(targetOf(server.baseUrl)),
						modelId: 'the-model-that-was-asked-for',
						messages: [
							{
								role: 'user',
								content: 'What is the capital of France?',
							},
						],
						mode: 'streamed',
					}),
				/a-substitute-model/,
			);
		} finally {
			await server.stop();
		}
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Shared Options
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test.describe('SharedOptions', () => {
	Test.it('builds the endpoint out of the command line options', () => {
		const target = SharedOptions.buildTarget({
			base_url: 'http://localhost:1234/v1',
			api_key: 'no-key-required',
			timeout_ms: '600000',
		});
		Assert.deepEqual(target, {
			baseUrl: 'http://localhost:1234/v1',
			apiKey: 'no-key-required',
			timeoutMs: 600_000,
		});
	});

	Test.it('names the option at fault when a numeric option cannot be read', () => {
		Assert.throws(() => SharedOptions.positiveInteger('not-a-number', '--timeout_ms'), /--timeout_ms/);
	});

	Test.it('sweeps both modes when neither mode flag was given', () => {
		const modes = SharedOptions.resolveModes({
			model: 'a-model',
			base_url: 'http://localhost:1234/v1',
			api_key: 'no-key-required',
			timeout_ms: '600000',
			format: 'text',
		});
		Assert.deepEqual(modes, ['nostream', 'streamed']);
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The chat Subcommand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test.describe('ChatCommand.buildMessages', () => {
	Test.it('sends the turn alone when no system message was asked for', () => {
		Assert.deepEqual(ChatCommand.buildMessages(undefined, 'What is the capital of France?'), [
			{
				role: 'user',
				content: 'What is the capital of France?',
			},
		]);
	});

	Test.it('opens the session with the system message when one was asked for', () => {
		Assert.deepEqual(ChatCommand.buildMessages('Answer in one word.', 'What is the capital of France?'), [
			{
				role: 'system',
				content: 'Answer in one word.',
			},
			{
				role: 'user',
				content: 'What is the capital of France?',
			},
		]);
	});
});

Test.describe('ChatCommand.run', () => {
	Test.it('refuses a model spelling that names more than one model', async () => {
		await Assert.rejects(
			async () =>
				await ChatCommand.run({
					model: 'all',
					prompt: 'What is the capital of France?',
					base_url: 'http://localhost:1234/v1',
					api_key: 'no-key-required',
					timeout_ms: '600000',
				}),
			/one model identifier/,
		);
	});

	Test.it('says the session is not built yet when no turn was given', async () => {
		await Assert.rejects(
			async () =>
				await ChatCommand.run({
					model: 'a-model',
					base_url: 'http://localhost:1234/v1',
					api_key: 'no-key-required',
					timeout_ms: '600000',
				}),
			/-p\/--prompt/,
		);
	});
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The benchmark subcommand
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

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

Test.describe('StatisticsCalculator.of', () => {
	Test.it('takes the middle value as the median of an odd number of values', () => {
		const statistics = StatisticsCalculator.of([30, 10, 20]);
		Assert.equal(statistics.average, 20);
		Assert.equal(statistics.median, 20);
		Assert.equal(statistics.minimum, 10);
		Assert.equal(statistics.maximum, 30);
	});

	Test.it('takes the mean of the two middle values as the median of an even number of values', () => {
		Assert.equal(StatisticsCalculator.of([10, 20, 30, 50]).median, 25);
	});

	Test.it('refuses to state a statistic of nothing', () => {
		Assert.throws(() => StatisticsCalculator.of([]), /No values were measured/);
	});
});

Test.describe('BenchmarkRunner.runBenchmark', () => {
	Test.it('measures every model named, and carries on past the one that failed', async () => {
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

	Test.it('carries no failure list at all when every model named was measured', async () => {
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

	Test.it('refuses a run in which no model could be measured', async () => {
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
});

Test.describe('ReportRenderer.formatBenchmarkReport', () => {
	Test.it('names the model that could not be measured in every one of the four formats', async () => {
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

	Test.it('refuses a format it cannot write', () => {
		Assert.equal(ReportRenderer.isReportFormat('csv'), false);
		Assert.equal(ReportRenderer.isReportFormat('junit'), true);
	});
});
