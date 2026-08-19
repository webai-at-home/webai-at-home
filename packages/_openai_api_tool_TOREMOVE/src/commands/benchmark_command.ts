// local imports
import { taskTypeNames } from '@webai/consumer-cli';
import { BenchmarkRunner } from '../benchmark_runner.js';
import { reportFormats } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BenchmarkCommand — measures one OpenAI-compatible endpoint's chat completion latency
//
//	Unlike the other two subcommands this one reaches any server that speaks the OpenAI-compatible
//	API, not only this cluster, so `-m/--model` accepts a name that is not a task type name of
//	this project — `llama-3.2-3b-instruct` on LM Studio, for one. That is the whole point of the
//	subcommand: it is how the cluster is compared against a model running on one machine.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `benchmark` subcommand's own options, exactly as commander parses them. */
export type RawBenchmarkOptions = RawSharedOptions & {
	/** The one prompt sent to the endpoint. */
	prompt: string;
	/** The number of measured requests per model, still as text. */
	runs: string;
	/** The number of unreported warm-up requests per model, still as text. */
	warmup_runs: string;
};

/** Measures the streamed chat completion latency of one OpenAI-compatible endpoint. */
export class BenchmarkCommand {
	/** The prompt sent when `-p/--prompt` is not given, long enough to produce a measurable stream. */
	static readonly defaultPrompt = 'Count up to 30';

	/**
	 * Runs the `benchmark` subcommand: measures every requested model on the endpoint, one after
	 * the other, and prints one report.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing, once the report has been printed.
	 * @throws {Error} If `--format` names a format that cannot be written, or if a request count
	 * is not a whole number in range.
	 */
	static async run(rawOptions: RawBenchmarkOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNames);
			return;
		}
		if (ReportRenderer.isReportFormat(rawOptions.format) === false) {
			throw new Error(`--format must be one of ${reportFormats.join(', ')}`);
		}

		const target = SharedOptions.buildTarget(rawOptions);
		const report = await BenchmarkRunner.runBenchmark({
			target,
			modelIds: ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNames, 'accept'),
			prompt: rawOptions.prompt,
			runs: SharedOptions.positiveInteger(rawOptions.runs, '--runs'),
			warmupRuns: SharedOptions.positiveInteger(rawOptions.warmup_runs, '--warmup_runs', true),
		});
		console.log(ReportRenderer.formatBenchmarkReport(report, rawOptions.format));
	}
}
