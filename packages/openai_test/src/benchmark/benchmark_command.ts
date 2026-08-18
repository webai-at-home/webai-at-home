// local imports
import { OpenaiPackageClient } from '../clients/openai_package_client.js';
import { RawHttpClient } from '../clients/raw_http_client.js';
import { reportFormats, type BenchmarkReport } from '../completion_types.js';
import { EndpointReachability } from '../endpoint_reachability.js';
import { exitCodes } from '../exit_codes.js';
import { ModelResolver } from '../model_resolver.js';
import { ReportWriter } from '../report_writer.js';
import { SharedOptions, type RawEndpointOptions } from '../shared_options.js';
import { BenchmarkRunner } from './benchmark_runner.js';
import { ReportRenderer } from './report_renderer.js';

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
//	`-s/--streamed` nor `--nostream`: there is nothing to choose.
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
	 * @returns Nothing, once the report has been written. Sets `process.exitCode` to `1` when a
	 * model named could not be measured while another one could, since the run produced numbers but
	 * not the numbers it was asked for.
	 * @throws {Error} If `-f/--format` names a format that cannot be written, if a request count is
	 * not a whole number in range, if nothing is listening at the endpoint, or if no model could be
	 * measured at all.
	 */
	static async run(rawOptions: RawBenchmarkOptions): Promise<void> {
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
		});
		BenchmarkCommand._announceFailures(report);
		ReportWriter.write(ReportRenderer.formatBenchmarkReport(report, rawOptions.format), rawOptions.output);
		BenchmarkCommand._setExitCode(report);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
	 * Sets the exit code a model that could not be measured earns.
	 *
	 * A benchmark has no verdicts, so the only thing that can be wrong with a run that produced a
	 * report is a model it was asked to measure and could not. That is exit code `1`, the same code
	 * a failed conformance test sets; a run that could not start at all is `2` and is thrown rather
	 * than reported.
	 *
	 * @param report The report the run produced.
	 * @returns Nothing.
	 */
	private static _setExitCode(report: BenchmarkReport): void {
		if ((report.failures ?? []).length > 0) {
			process.exitCode = exitCodes.someFailed;
		}
	}
}
