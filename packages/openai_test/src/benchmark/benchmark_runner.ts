// local imports
import { CompletionSender, type CompletionRequester } from '../clients/completion_sender.js';
import type {
	BenchmarkReport,
	BenchmarkSample,
	BenchmarkSummary,
	CompletionResult,
	CompletionTarget,
	ThinkingSetting,
} from '../completion_types.js';
import { StatisticsCalculator } from './statistics_calculator.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkRunner — runs the warm-up and measured requests, and aggregates what they measured
//
//	Every request asks for its answer in pieces, so Time to First Character and Time to Last
//	Character can be measured separately, the way a person waiting on the answer would experience
//	the difference between the two. An endpoint that ignores the streaming request and answers in
//	one piece still works: its first and last character then arrive at the same moment.
//
//	One run measures one model. A model that cannot be measured at all throws, because a benchmark
//	report of one model with no measurement in it is nothing at all.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one benchmark run tells its caller as it happens, so that `-v/--verbose` can print a line
 * per request rather than leaving a run against a slow endpoint silent for minutes.
 *
 * Every method is called from the runner and returns nothing. A run given no listener at all
 * measures exactly the same numbers, since nothing here is measured inside a listener.
 */
export type BenchmarkProgressListener = {
	/** Called before each warm-up request is sent, with the one-based warm-up number and the total. */
	readonly onWarmupRequestStarted: (modelId: string, warmupRun: number, warmupRuns: number) => void;
	/** Called once that warm-up request has come back, whatever it answered. */
	readonly onWarmupRequestFinished: (modelId: string) => void;
	/** Called before each measured request is sent, with the one-based request number and the total. */
	readonly onMeasuredRequestStarted: (modelId: string, run: number, runs: number) => void;
	/** Called once that measured request has come back, with what it measured. */
	readonly onMeasuredRequestFinished: (modelId: string, sample: BenchmarkSample) => void;
};

/** The options that control one benchmark run. */
export type BenchmarkOptions = {
	/** The endpoint to measure. */
	readonly target: CompletionTarget;
	/** The one model identifier to measure on that endpoint. */
	readonly modelId: string;
	/** The one prompt sent to the endpoint. */
	readonly prompt: string;
	/** The number of measured requests. */
	readonly runs: number;
	/** The number of unreported warm-up requests. */
	readonly warmupRuns: number;
	/** Whether every request lets the model think before it answers. */
	readonly thinkingSetting: ThinkingSetting;
	/** Told what the run is doing as it happens, when the caller asked for progress lines. */
	readonly listener?: BenchmarkProgressListener;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkRunner
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Measures the latency of one model on one OpenAI-compatible endpoint. */
export class BenchmarkRunner {
	/**
	 * Runs the warm-up requests and then the measured requests of the one model measured, with no
	 * concurrent requests at any point.
	 *
	 * @param options The endpoint, the model, the prompt, and the request counts of this run.
	 * @param requester The completion request used for every warm-up and measured request.
	 * Defaults to a real streamed request through `CompletionSender`, and is replaced by a test
	 * that needs measurements it decides itself.
	 * @returns The full benchmark report, holding the aggregate measurements of that model.
	 * @throws {Error} If any request count is not a whole number in range, if no model was named,
	 * or if the model could not be measured, since a report with no measurement in it measured
	 * nothing.
	 */
	static async runBenchmark(
		options: BenchmarkOptions,
		requester: CompletionRequester = BenchmarkRunner.streamedRequester(options.target, options.thinkingSetting),
	): Promise<BenchmarkReport> {
		if (options.modelId.trim() === '') {
			throw new Error('--model named no model to measure');
		}
		if (options.runs < 1 || Number.isInteger(options.runs) === false) {
			throw new Error('--runs must be a positive integer');
		}
		if (options.warmupRuns < 0 || Number.isInteger(options.warmupRuns) === false) {
			throw new Error('--warmup_runs must be a non-negative integer');
		}
		if (options.target.timeoutMs < 1 || Number.isInteger(options.target.timeoutMs) === false) {
			throw new Error('--timeout_ms must be a positive integer');
		}

		let summary: BenchmarkSummary;
		try {
			summary = await BenchmarkRunner._measureModel(options.modelId, options, requester);
		} catch (error: unknown) {
			throw new Error(`"${options.modelId}" was not measured: ${CompletionSender.describeFailure(error)}`);
		}

		return {
			settings: {
				prompt: options.prompt,
				runs: options.runs,
				warmupRuns: options.warmupRuns,
				thinkingSetting: options.thinkingSetting,
				parallelism: 1,
			},
			summary,
		};
	}

	/**
	 * Builds the requester used when no other one is given: one streamed request per call, sent
	 * through the one transport this package uses, over a client shared by every request of the
	 * run so that the measurements are not distorted by a new connection each time.
	 *
	 * @param target The endpoint to send requests to.
	 * @param thinkingSetting Whether to let the model think before it answers.
	 * @returns The requester to hand to `runBenchmark`.
	 */
	static streamedRequester(target: CompletionTarget, thinkingSetting: ThinkingSetting): CompletionRequester {
		const client = CompletionSender.createClient(target);
		return async (modelId: string, prompt: string): Promise<CompletionResult> => {
			return await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
				streamSetting: 'on',
				thinkingSetting,
			});
		};
	}

	/**
	 * Calculates the average, median, minimum, and maximum of each metric from measured samples.
	 *
	 * @param baseUrl The base URL of the endpoint the samples were measured against.
	 * @param modelId The model identifier the samples were measured for.
	 * @param samples The measured samples, in request order.
	 * @returns The aggregate measurements for that model on that endpoint.
	 * @throws {Error} If no sample was measured.
	 */
	static summarizeSamples(baseUrl: string, modelId: string, samples: readonly BenchmarkSample[]): BenchmarkSummary {
		if (samples.length === 0) {
			throw new Error(`The benchmark produced no samples for ${modelId} on ${baseUrl}`);
		}
		return {
			baseUrl,
			modelId,
			samples,
			timeToFirstCharacterMs: StatisticsCalculator.of(samples.map((sample) => sample.timeToFirstCharacterMs)),
			timeToLastCharacterMs: StatisticsCalculator.of(samples.map((sample) => sample.timeToLastCharacterMs)),
			outputCharactersPerSecond: StatisticsCalculator.of(samples.map((sample) => sample.outputCharactersPerSecond)),
			inputCharacters: samples[0].inputCharacters,
			outputCharacters: StatisticsCalculator.of(samples.map((sample) => sample.outputCharacters)),
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one model's warm-up and measured requests in strict sequence.
	 *
	 * @param modelId The model identifier to measure.
	 * @param options The endpoint, the prompt, and the request counts of this run.
	 * @param requester The completion request used for every warm-up and measured request.
	 * @returns The aggregate measurements for that model.
	 */
	private static async _measureModel(modelId: string, options: BenchmarkOptions, requester: CompletionRequester): Promise<BenchmarkSummary> {
		for (let warmupRun = 1; warmupRun <= options.warmupRuns; warmupRun += 1) {
			options.listener?.onWarmupRequestStarted(modelId, warmupRun, options.warmupRuns);
			await requester(modelId, options.prompt);
			options.listener?.onWarmupRequestFinished(modelId);
		}
		const samples: BenchmarkSample[] = [];
		for (let run = 1; run <= options.runs; run += 1) {
			options.listener?.onMeasuredRequestStarted(modelId, run, options.runs);
			const result = await requester(modelId, options.prompt);
			const sample = BenchmarkRunner._buildSample(run, options.prompt, result);
			options.listener?.onMeasuredRequestFinished(modelId, sample);
			samples.push(sample);
		}
		return BenchmarkRunner.summarizeSamples(options.target.baseUrl, modelId, samples);
	}

	/**
	 * Turns one completion result into a measured sample, computing Output Characters per Second
	 * from the Time to First and Time to Last Character the requester reported.
	 *
	 * @param run The one-based measured request number.
	 * @param prompt The prompt this request sent, read for its character count.
	 * @param result The completion result to build a sample from.
	 * @returns The measured sample.
	 */
	private static _buildSample(run: number, prompt: string, result: CompletionResult): BenchmarkSample {
		// Floored at 1 ms rather than left at 0, since an answer that arrived in a single piece
		// has no streaming duration to divide by, and characters-per-second cannot be undefined.
		const streamingMs = Math.max(result.timeToLastCharacterMs - result.timeToFirstCharacterMs, 1);
		return {
			run,
			timeToFirstCharacterMs: result.timeToFirstCharacterMs,
			timeToLastCharacterMs: result.timeToLastCharacterMs,
			outputCharactersPerSecond: result.answer.length / (streamingMs / 1_000),
			inputCharacters: prompt.length,
			outputCharacters: result.answer.length,
		};
	}
}
