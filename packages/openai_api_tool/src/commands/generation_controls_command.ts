// local imports
import { taskTypeNames } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import { reportFormats, type GenerationControlOutcome } from '../completion_types.js';
import { GenerationControlProber } from '../generation_control_prober.js';
import { GenerationControlRenderer } from '../generation_control_renderer.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlsCommand — probes each of the five generation controls, one model at a time
//
//	Sweeps every model of `taskTypeNames` the same way `completion` does, but instead of reporting
//	which pair answered, reports for each of `temperature`, `top_p`, `max_completion_tokens`,
//	`stop`, and `seed` whether that model really honours it — proved by comparing repeated
//	answers, never by the endpoint having accepted the field. This is the de-risk gate of
//	[issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), made re-runnable.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `generation_controls` subcommand's own options, exactly as commander parses them. */
export type RawGenerationControlsOptions = RawSharedOptions & {
	/** How many times a probe that compares repeated answers sends its prompt, still as text. */
	repeats: string;
};

/** Probes each of the five generation controls against every requested model. */
export class GenerationControlsCommand {
	/**
	 * Runs the `generation_controls` subcommand: probes all five controls against every requested
	 * model and mode pair, one probe at a time, prints one line per probe, and finishes with a
	 * summary naming which controls each pair honours.
	 *
	 * `dev_formula` is left out of a sweep rather than probed, because it answers with one number
	 * and generates no text, so there is nothing for any of the five to change. It is still probed
	 * when it is asked for by name, since asking for it by name is asking to see that answer.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any probe failed or found a control
	 * accepted and then ignored, since a silently ignored control is the fault this subcommand
	 * exists to catch.
	 * @throws {Error} If `--format` names a format that cannot be written, or `--repeats` is not a
	 * positive whole number.
	 */
	static async run(rawOptions: RawGenerationControlsOptions): Promise<void> {
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

		const outcomes: GenerationControlOutcome[] = [];
		for (const modelId of modelIds) {
			if (modelId === 'dev_formula' && modelIds.length > 1) {
				continue;
			}
			for (const mode of modes) {
				const pairOutcomes = await GenerationControlProber.probeAll({
					client,
					modelId,
					mode,
					repeats,
				});
				outcomes.push(...pairOutcomes);
				if (isText === true) {
					for (const outcome of pairOutcomes) {
						GenerationControlRenderer.printOutcome(outcome);
					}
				}
			}
		}

		if (isText === true) {
			GenerationControlRenderer.printSummary(outcomes);
		} else {
			console.log(GenerationControlRenderer.formatReport(outcomes, rawOptions.format));
		}
		if (outcomes.some((outcome) => outcome.status === 'failed' || outcome.status === 'not_honoured')) {
			process.exitCode = 1;
		}
	}
}
