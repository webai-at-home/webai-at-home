// local imports
import { OpenaiPackageClient } from '../clients/openai_package_client.js';
import { RawHttpClient } from '../clients/raw_http_client.js';
import { reportFormats, thinkingSettings, type BenchmarkReport, type ThinkingSetting } from '../completion_types.js';
import { EndpointReachability } from '../endpoint_reachability.js';
import { ModelResolver } from '../model_resolver.js';
import { ReportParameters } from '../report_parameters.js';
import { ReportWriter } from '../report_writer.js';
import { SharedOptions, type RawEndpointOptions } from '../shared_options.js';
import { BenchmarkRunner, type BenchmarkProgressListener } from './benchmark_runner.js';
import { ReportRenderer, type BenchmarkMarkdownOptions } from './report_renderer.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkCommand — measures one OpenAI-compatible endpoint's chat completion latency
//
//	Run with:
//	  ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct
//	  ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model all --format markdown
//
//	Every request is streamed, because Time to First Character and Time to Last Character are two
//	separate numbers only while the answer arrives in pieces. This is why `benchmark` takes neither
//	`--stream`: there is nothing to choose.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `benchmark` subcommand's options, exactly as commander parses them. */
export type RawBenchmarkOptions = RawEndpointOptions & {
	/** The model identifier to measure. */
	model: string;
	/** The one prompt sent to the endpoint. */
	prompt: string;
	/** The number of measured requests per model, still as text. */
	runs: string;
	/** The number of unreported warm-up requests per model, still as text. */
	warmup_runs: string;
	/** The output format. */
	format: string;
	/** Write the report to this file rather than to standard output, when given. */
	output?: string;
	/** Set when `-v/--verbose` was given. */
	verbose?: boolean;
	/** Whether the model may think before it answers, still as text. */
	thinking: string;
};

/** Measures the streamed chat completion latency of one OpenAI-compatible endpoint. */
export class BenchmarkCommand {
	/** The prompt sent when `-p/--prompt` is not given, long enough to produce a measurable stream. */
	static readonly defaultPrompt = 'Count up to 30';

	/**
	 * Runs the `benchmark` subcommand: measures every requested model on the endpoint, one after
	 * the other, and writes one report.
	 *
	 * @param rawOptions The subcommand's options, exactly as commander parsed them.
	 * @param args The command line arguments as they were typed, without the program name, so that
	 * a markdown report can carry the line that produced it. Defaults to no arguments at all, for a
	 * caller that has none to offer.
	 * @param invokedName The name this program was invoked under, written at the head of that line.
	 * @returns Nothing, once the report has been written. Sets `process.exitCode` to `1` when a
	 * model named could not be measured while another one could, since the run produced numbers but
	 * not the numbers it was asked for.
	 * @throws {Error} If `-f/--format` names a format that cannot be written, if a request count is
	 * not a whole number in range, if nothing is listening at the endpoint, or if no model could be
	 * measured at all.
	 */
	static async run(rawOptions: RawBenchmarkOptions, args: readonly string[] = [], invokedName = 'openai_test'): Promise<void> {
		if (rawOptions.model === undefined || rawOptions.model.trim() === '') {
			throw new Error('-m/--model is required, or set the OPENAI_MODEL environment variable');
		}
		if (ReportRenderer.isReportFormat(rawOptions.format) === false) {
			throw new Error(`-f/--format must be one of ${reportFormats.join(', ')}, got "${rawOptions.format}"`);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const rawHttpClient = new RawHttpClient(target);
		await EndpointReachability.assertReachable(rawHttpClient, target.baseUrl);
		if (rawOptions.model.trim() === 'list') {
			SharedOptions.printModelIds(await ModelResolver.listModelIds(rawHttpClient));
			return;
		}

		const selection = await ModelResolver.resolve(rawOptions.model, rawHttpClient);
		const modelIds: string[] = [];
		for (const modelId of selection.modelIds) {
			if (selection.isFromEndpointListing === true) {
				const reason = await ModelResolver.probeUsable(new OpenaiPackageClient(target).client, modelId);
				if (reason !== undefined) {
					console.error(`Model left out: "${modelId}" (${reason})`);
					continue;
				}
			}
			modelIds.push(modelId);
		}
		if (modelIds.length === 0) {
			throw new Error('every model the endpoint listed failed to answer one chat completion under its own name');
		}

		const report = await BenchmarkRunner.runBenchmark({
			target,
			modelIds,
			prompt: rawOptions.prompt,
			runs: SharedOptions.positiveInteger(rawOptions.runs, '--runs'),
			warmupRuns: SharedOptions.positiveInteger(rawOptions.warmup_runs, '--warmup_runs', true),
			thinkingSetting: BenchmarkCommand._resolveThinkingSetting(rawOptions.thinking),
			...(rawOptions.verbose === true ? { listener: BenchmarkCommand._buildProgressListener() } : {}),
		});
		BenchmarkCommand._announceFailures(report);
		const markdownOptions: BenchmarkMarkdownOptions = {
			generatedAt: new Date(),
			parameters: ReportParameters.ofBenchmarkOptions(rawOptions),
			commandLine: ReportParameters.commandLine(args, invokedName),
		};
		ReportWriter.write(ReportRenderer.formatBenchmarkReport(report, rawOptions.format, markdownOptions), rawOptions.output);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads what `--thinking` was given.
	 *
	 * @param thinking The option's value, exactly as it was typed.
	 * @returns The setting it names.
	 * @throws {Error} If it names neither `on` nor `off`.
	 */
	private static _resolveThinkingSetting(thinking: string): ThinkingSetting {
		const wanted = thinking.trim().toLowerCase();
		if ((thinkingSettings as readonly string[]).includes(wanted) === false) {
			throw new Error(`--thinking must be one of ${thinkingSettings.join(', ')}, got "${thinking}"`);
		}
		return wanted as ThinkingSetting;
	}

	/**
	 * Names every model that could not be measured on standard error, so that a run written to a
	 * file with `-o/--output` still says on the terminal that something was asked for and not
	 * measured.
	 *
	 * @param report The report the run produced.
	 * @returns Nothing.
	 */
	private static _announceFailures(report: BenchmarkReport): void {
		for (const failure of report.failures ?? []) {
			console.error(`Model not measured: "${failure.modelId}" (${failure.reason})`);
		}
	}

	/**
	 * Builds the listener that prints each request as it is sent and as it comes back, so that a
	 * run against a slow endpoint says what it is doing rather than sitting silent for minutes.
	 *
	 * The lines go to standard error, so that a report written to standard output stays exactly the
	 * report and nothing else. Each request writes one line in two halves: which request it is when
	 * it is sent, and what it measured when it comes back.
	 *
	 * @returns The listener to hand `BenchmarkRunner.runBenchmark`.
	 */
	private static _buildProgressListener(): BenchmarkProgressListener {
		const rounded = (value: number): string => value.toFixed(2);
		return {
			onWarmupRequestStarted: (modelId, warmupRun, warmupRuns) => {
				process.stderr.write(`${modelId} warm-up request ${warmupRun}/${warmupRuns} ... `);
			},
			onWarmupRequestFinished: () => {
				process.stderr.write('answered, and thrown away\n');
			},
			onMeasuredRequestStarted: (modelId, run, runs) => {
				process.stderr.write(`${modelId} measured request ${run}/${runs} ... `);
			},
			onMeasuredRequestFinished: (modelId, sample) => {
				const measured = [
					`${rounded(sample.timeToFirstCharacterMs)} ms to first character`,
					`${rounded(sample.timeToLastCharacterMs)} ms to last character`,
					`${rounded(sample.outputCharactersPerSecond)} characters/second`,
					`${sample.outputCharacters} characters`,
				].join(', ');
				process.stderr.write(`${measured}\n`);
			},
			onModelFailed: (modelId, reason) => {
				process.stderr.write(`${modelId} not measured: ${reason}\n`);
			},
		};
	}

}
