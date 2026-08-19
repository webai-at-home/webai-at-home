// local imports
import { taskTypeNames } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import { reportFormats, type ToolCallOutcome } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';
import { ToolCallProber } from '../tool_call_prober.js';
import { ToolCallRenderer } from '../tool_call_renderer.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallsCommand — probes each of the six tool call abilities, one model at a time
//
//	This is the de-risk gate of
//	[issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) made re-runnable against
//	any endpoint that speaks the OpenAI-compatible API. That gate was run once, by hand, against one
//	server and one model build, and tool calling was dropped on what it found. Turning it into a
//	subcommand is what makes the finding checkable against a second server, a second quantization,
//	or a second model, which is exactly what that issue says anyone resuming the work should do
//	first.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `tool_calls` subcommand's own options, exactly as commander parses them. */
export type RawToolCallsOptions = RawSharedOptions & {
	/** How many times a probe that needs a tool call sends its prompt, still as text. */
	repeats: string;
};

/** Probes each of the six tool call abilities against every requested model. */
export class ToolCallsCommand {
	/**
	 * Runs the `tool_calls` subcommand: probes all six abilities against every requested model and
	 * mode pair, one probe at a time, prints one line per probe, and finishes with a summary naming
	 * which abilities each pair has.
	 *
	 * `dev_formula` is left out of a sweep rather than probed, because it answers with one number
	 * and generates no text at all, so it could not ask for a tool whatever was declared to it. It
	 * is still probed when it is asked for by name, since asking for it by name is asking to see
	 * that answer.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` only when a probe `failed`, never when one
	 * found an ability unsupported: a model that does not call tools is the finding this subcommand
	 * exists to report, not a fault in the run that measured it.
	 * @throws {Error} If `--format` names a format that cannot be written, or `--repeats` is not a
	 * positive whole number.
	 */
	static async run(rawOptions: RawToolCallsOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNames);
			return;
		}
		if (ReportRenderer.isReportFormat(rawOptions.format) === false) {
			throw new Error(`--format must be one of ${reportFormats.join(', ')}`);
		}
		const repeats = SharedOptions.positiveInteger(rawOptions.repeats, '--repeats');

		const modelIds = ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNames, 'accept');
		const modes = SharedOptions.resolveModes(rawOptions);
		const client = CompletionSender.createClient(SharedOptions.buildTarget(rawOptions));
		const isText = rawOptions.format === 'text';

		const outcomes: ToolCallOutcome[] = [];
		for (const modelId of modelIds) {
			if (modelId === 'dev_formula' && modelIds.length > 1) {
				continue;
			}
			for (const mode of modes) {
				const pairOutcomes = await ToolCallProber.probeAll({
					client,
					modelId,
					mode,
					repeats,
				});
				outcomes.push(...pairOutcomes);
				if (isText === true) {
					for (const outcome of pairOutcomes) {
						ToolCallRenderer.printOutcome(outcome);
					}
				}
			}
		}

		if (isText === true) {
			ToolCallRenderer.printSummary(outcomes);
		} else {
			console.log(ToolCallRenderer.formatReport(outcomes, rawOptions.format));
		}
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}
}
