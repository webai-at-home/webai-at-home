// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// npm imports
import type OpenAI from 'openai';

// local imports
import { BenchmarkRunner } from '../src/benchmark/benchmark_runner.js';
import { ReportRenderer } from '../src/benchmark/report_renderer.js';
import { StatisticsCalculator } from '../src/benchmark/statistics_calculator.js';
import { ChatCommand } from '../src/chat/chat_command.js';
import { ChatRenderer } from '../src/chat/chat_renderer.js';
import { ChatSession, type LineSource } from '../src/chat/chat_session.js';
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

/**
 * Builds a line source that reads the given lines and then ends, which is how a session is driven
 * without a terminal.
 *
 * @param lines The lines to read, in order.
 * @returns The line source to hand to a session.
 */
function lineSourceOf(lines: readonly string[]): LineSource {
	let index = 0;
	return {
		next: async () => {
			if (index >= lines.length) {
				return {
					done: true,
				};
			}
			const value = lines[index];
			index += 1;
			return {
				done: false,
				value,
			};
		},
	};
}

/** What one scripted session wrote, and what it was asked to send. */
type SessionTranscript = {
	/** The session that ran, so a test can read the history it ended with. */
	readonly session: ChatSession;
	/** Everything written, concatenated. */
	readonly written: string;
	/** The messages of every turn sent, in the order the turns were sent. */
	readonly sentMessages: OpenAI.ChatCompletionMessageParam[][];
};

/**
 * Runs one whole session over scripted lines, with a sender that answers without an endpoint.
 *
 * @param lines The lines typed into the session, in order.
 * @param systemText The system message to open the session with, `undefined` for none.
 * @param answerOf What the model answers a turn with, read from the turn itself. Throwing from it is
 * how a turn the endpoint would not answer is scripted.
 * @returns What the session wrote and what it sent.
 */
async function runScriptedSession(
	lines: readonly string[],
	systemText: string | undefined,
	answerOf: (turn: string) => string,
): Promise<SessionTranscript> {
	const sentMessages: OpenAI.ChatCompletionMessageParam[][] = [];
	let written = '';
	const session = new ChatSession({
		modelId: 'a-model',
		baseUrl: 'http://localhost:1234/v1',
		systemText,
		isInteractive: true,
		lines: lineSourceOf(lines),
		write: (text: string) => {
			written += text;
		},
		sendTurn: async (messages, writePiece) => {
			sentMessages.push([...messages]);
			const lastMessage = messages[messages.length - 1];
			const answer = answerOf(typeof lastMessage.content === 'string' ? lastMessage.content : '');
			for (const piece of answer) {
				writePiece(piece);
			}
			return {
				answer,
				reportedModelId: 'a-model',
				timeToFirstCharacterMs: 12,
				timeToLastCharacterMs: 34,
				clusterGenerationTimeMs: undefined,
				clusterTimeToFirstPieceMs: undefined,
				usage: undefined,
				finishReason: 'stop',
				toolCalls: [],
			};
		},
	});
	await session.run();
	return {
		session,
		written,
		sentMessages,
	};
}

Test.describe('ChatRenderer.banner', () => {
	Test.it('says what can be typed only when somebody is typing', () => {
		Assert.match(ChatRenderer.banner('a-model', 'http://localhost:1234/v1', true), /Type a turn/);
		Assert.doesNotMatch(ChatRenderer.banner('a-model', 'http://localhost:1234/v1', false), /Type a turn/);
	});

	Test.it('names the model and the endpoint either way', () => {
		for (const isInteractive of [true, false]) {
			const banner = ChatRenderer.banner('a-model', 'http://localhost:1234/v1', isInteractive);
			Assert.match(banner, /a-model/);
			Assert.match(banner, /localhost:1234/);
		}
	});
});

Test.describe('ChatSession.openingMessages', () => {
	Test.it('opens with nothing at all when no system message was asked for', () => {
		Assert.deepEqual(ChatSession.openingMessages(undefined), []);
	});

	Test.it('opens with the system message when one was asked for', () => {
		Assert.deepEqual(ChatSession.openingMessages('Answer in one word.'), [
			{
				role: 'system',
				content: 'Answer in one word.',
			},
		]);
	});
});

Test.describe('ChatSession.run', () => {
	Test.it('sends the whole history with every turn after the first', async () => {
		const transcript = await runScriptedSession(
			['What is the capital of France?', 'And of Spain?'],
			'Answer in one word.',
			() => 'Paris',
		);
		Assert.equal(transcript.sentMessages.length, 2);
		Assert.deepEqual(
			transcript.sentMessages[0].map((message) => message.role),
			['system', 'user'],
		);
		Assert.deepEqual(
			transcript.sentMessages[1].map((message) => message.role),
			['system', 'user', 'assistant', 'user'],
		);
		Assert.equal(transcript.session.currentMessages().length, 5);
	});

	Test.it('writes the answer and the dimmed timings under it', async () => {
		const transcript = await runScriptedSession(['What is the capital of France?'], undefined, () => 'Paris');
		Assert.match(transcript.written, /Paris/);
		Assert.match(transcript.written, /Time to First Character 12 ms/);
		Assert.match(transcript.written, /Time to Last Character 34 ms/);
		Assert.match(transcript.written, /5 characters/);
	});

	Test.it('leaves the session on /quit, and reads nothing after it', async () => {
		const transcript = await runScriptedSession(['/quit', 'this turn is never read'], undefined, () => 'Paris');
		Assert.equal(transcript.sentMessages.length, 0);
	});

	Test.it('clears the history on /reset, and keeps the system message', async () => {
		const transcript = await runScriptedSession(
			['What is the capital of France?', '/reset', 'And of Spain?'],
			'Answer in one word.',
			() => 'Paris',
		);
		Assert.deepEqual(
			transcript.sentMessages[1].map((message) => message.role),
			['system', 'user'],
		);
		Assert.match(transcript.written, /The history is cleared/);
	});

	Test.it('prints every message the next turn would carry on /history', async () => {
		const transcript = await runScriptedSession(['What is the capital of France?', '/history'], undefined, () => 'Paris');
		Assert.match(transcript.written, /2 messages will be sent with the next turn/);
		Assert.match(transcript.written, /user: What is the capital of France\?/);
		Assert.match(transcript.written, /assistant: Paris/);
	});

	Test.it('sends a line that only starts with a slash as a turn', async () => {
		const transcript = await runScriptedSession(['/resetting is not /reset'], undefined, () => 'Paris');
		Assert.equal(transcript.sentMessages.length, 1);
	});

	Test.it('reports a turn the endpoint would not answer, and carries on with the history it had', async () => {
		const transcript = await runScriptedSession(
			['What is the capital of France?', 'And of Spain?'],
			undefined,
			(turn: string) => {
				if (turn === 'What is the capital of France?') {
					throw new Error('the endpoint refused this one');
				}
				return 'Madrid';
			},
		);
		Assert.match(transcript.written, /That turn was not answered: the endpoint refused this one/);
		Assert.deepEqual(
			transcript.sentMessages[1].map((message) => message.role),
			['user'],
		);
		Assert.deepEqual(
			transcript.session.currentMessages().map((message) => message.role),
			['user', 'assistant'],
		);
	});

	Test.it('skips a line with nothing on it', async () => {
		const transcript = await runScriptedSession(['', '   ', 'What is the capital of France?'], undefined, () => 'Paris');
		Assert.equal(transcript.sentMessages.length, 1);
	});
});

Test.describe('ChatCommand', () => {
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

	Test.it('refuses a run that named no model at all', async () => {
		await Assert.rejects(
			async () =>
				await ChatCommand.run({
					base_url: 'http://localhost:1234/v1',
					api_key: 'no-key-required',
					timeout_ms: '600000',
				}),
			/no model was named/,
		);
	});

	Test.it('reads the one turn of -p/--prompt and then ends the input', async () => {
		const lines = ChatCommand.oneLineSource('What is the capital of France?');
		Assert.deepEqual(await lines.next(), {
			done: false,
			value: 'What is the capital of France?',
		});
		Assert.deepEqual(await lines.next(), {
			done: true,
		});
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
