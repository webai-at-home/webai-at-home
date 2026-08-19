// npm imports
import type OpenAI from 'openai';

// local imports
import { taskTypeNames } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import { reportFormats, type CompletionMode, type UsageOutcome } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	UsageCommand — sends one prompt per model and per mode, and reports usage and finish_reason
//
//	Sweeps every model of `taskTypeNames` the same way `completion` does, but instead of reporting
//	which pair answered, reports whether the answer's `usage` object was present and, when it was,
//	its `prompt_tokens`/`completion_tokens`/`total_tokens` and `finish_reason`. The streamed mode
//	asks for its final, choice-less usage chunk with `stream_options: { include_usage: true }`.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `usage` subcommand's own options, exactly as commander parses them. */
export type RawUsageOptions = RawSharedOptions & {
	/** The prompt to send instead of each model's own default prompt. */
	prompt?: string;
};

/** Sends one chat completion request per model and per mode, and reports each answer's usage and finish_reason. */
export class UsageCommand {
	/** The prompt sent to `dev_formula`, which accepts only a number and answers with a number. */
	private static readonly _devFormulaPrompt = '5';

	/** The prompt sent to every model other than `dev_formula`. */
	private static readonly _defaultLanguagePrompt = 'What is the capital of France?';

	/**
	 * Runs the `usage` subcommand: sweeps every requested model and mode pair, one at a time,
	 * prints one line per pair, and finishes with a summary table.
	 *
	 * `-m/--model list` is handled first, as a request to print the model identifiers rather than
	 * to send anything, so it needs neither `-u/--base_url` to answer nor a gateway to be reachable.
	 *
	 * `-f/--format text`, the default, prints each pair's usage line as it finishes. `-f/--format
	 * markdown` or `-f/--format json` runs the sweep silently and prints one report once every
	 * pair has finished.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 * @throws {Error} If `--format` names a format that cannot be written.
	 */
	static async run(rawOptions: RawUsageOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNames);
			return;
		}
		if (ReportRenderer.isReportFormat(rawOptions.format) === false) {
			throw new Error(`--format must be one of ${reportFormats.join(', ')}`);
		}

		const modelIds = ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNames, 'accept');
		const modes = SharedOptions.resolveModes(rawOptions);
		const client = CompletionSender.createClient(SharedOptions.buildTarget(rawOptions));
		const isText = rawOptions.format === 'text';

		const outcomes: UsageOutcome[] = [];
		for (const modelId of modelIds) {
			const prompt = rawOptions.prompt ?? UsageCommand._defaultPromptFor(modelId);
			for (const mode of modes) {
				const outcome = await UsageCommand._sweepOne(client, modelId, mode, prompt);
				outcomes.push(outcome);
				if (isText === true) {
					ReportRenderer.printUsageOutcome(outcome);
				}
			}
		}

		if (isText === true) {
			ReportRenderer.printUsageSummary(outcomes);
		} else {
			console.log(ReportRenderer.formatUsageReport(outcomes, rawOptions.format));
		}
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The default prompt for one model.
	 *
	 * @param modelId The model identifier.
	 * @returns `5` for `dev_formula`, and a plain question for every other model.
	 */
	private static _defaultPromptFor(modelId: string): string {
		if (modelId === 'dev_formula') {
			return UsageCommand._devFormulaPrompt;
		}
		return UsageCommand._defaultLanguagePrompt;
	}

	/**
	 * Sweeps one model and one mode: sends the one prompt, and turns either the answer's usage and
	 * finish_reason or the failure into a `UsageOutcome`.
	 *
	 * `dev_formula` asked to stream is skipped rather than sent, because `TaskInputFactory` in
	 * `@webai/consumer-cli` refuses it outright — the `dev_formula` task answers with one number,
	 * so it cannot produce its answer in pieces. That is a permanent, documented restriction
	 * rather than something this run could ever fix, so it is reported apart from an actual failure.
	 *
	 * @param client The OpenAI client pointed at the endpoint under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for the answer as it is written, or in one piece.
	 * @param prompt The single user message to send.
	 * @returns What happened.
	 */
	private static async _sweepOne(client: OpenAI, modelId: string, mode: CompletionMode, prompt: string): Promise<UsageOutcome> {
		if (modelId === 'dev_formula' && mode === 'streamed') {
			return {
				modelId,
				mode,
				status: 'skipped',
				usagePresent: false,
				usage: undefined,
				finishReason: undefined,
				failureMessage: 'the dev_formula task answers with one number, so it cannot produce its answer in pieces',
			};
		}

		try {
			const result = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
				mode,
				includeUsage: true,
			});
			return {
				modelId,
				mode,
				status: 'ok',
				usagePresent: result.usage !== undefined,
				usage: result.usage,
				finishReason: result.finishReason,
				failureMessage: undefined,
			};
		} catch (error: unknown) {
			return {
				modelId,
				mode,
				status: 'failed',
				usagePresent: false,
				usage: undefined,
				finishReason: undefined,
				failureMessage: CompletionSender.describeFailure(error),
			};
		}
	}
}
