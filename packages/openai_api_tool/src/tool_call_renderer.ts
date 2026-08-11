// npm imports
import Chalk from 'chalk';

// local imports
import type { ReportFormat, ToolCallOutcome, ToolCallStatus } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallRenderer — turns tool call probe outcomes into the lines a person reads
//
//	Kept apart from `report_renderer.ts` and from `generation_control_renderer.ts` because these
//	outcomes answer a different question again: not how fast an endpoint answered, and not whether a
//	control it accepted changed the answer, but which of six separate tool call abilities the model
//	behind that endpoint actually has.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How each status is colored. Turned off automatically once output is piped. */
const colorByStatus: Record<ToolCallStatus, (text: string) => string> = {
	supported: (text) => Chalk.green(text),
	unsupported: (text) => Chalk.red(text),
	refused: (text) => Chalk.cyan(text),
	inconclusive: (text) => Chalk.yellow(text),
	failed: (text) => Chalk.red(text),
};

/** Writes out what the `tool_calls` subcommand's probes concluded. */
export class ToolCallRenderer {
	/**
	 * Builds the line for one probe outcome.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The one line to print.
	 */
	static outcomeLine(outcome: ToolCallOutcome): string {
		return `${outcome.modelId} (${outcome.mode}) ${outcome.ability}: ${outcome.status} — ${outcome.observation}`;
	}

	/**
	 * Prints the line for one probe outcome, colored by what it concluded, sending a failed probe to
	 * the error output so that a run piped into a file still shows what went wrong.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	static printOutcome(outcome: ToolCallOutcome): void {
		const line = colorByStatus[outcome.status](ToolCallRenderer.outcomeLine(outcome));
		if (outcome.status === 'failed') {
			console.error(line);
			return;
		}
		console.log(line);
	}

	/**
	 * Builds the summary printed at the end of a run: one line per model and mode naming the
	 * abilities it has, then the counts.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns The lines to print, in order.
	 */
	static summaryLines(outcomes: readonly ToolCallOutcome[]): string[] {
		const lines: string[] = ['', 'Summary:'];
		for (const [pair, pairOutcomes] of ToolCallRenderer._byModelAndMode(outcomes)) {
			lines.push(`  ${pair}: ${ToolCallRenderer._abilitiesLine(pairOutcomes)}`);
		}
		const counts = ToolCallRenderer._counts(outcomes);
		lines.push('');
		lines.push(`${counts.supported}/${counts.total} supported, ${counts.refused} refused, ${counts.unsupported} unsupported, ${counts.inconclusive} inconclusive, ${counts.failed} failed`);
		return lines;
	}

	/**
	 * Prints the summary at the end of a run, colored, with the counts that matter highlighted when
	 * they are above zero.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns Nothing.
	 */
	static printSummary(outcomes: readonly ToolCallOutcome[]): void {
		console.log('');
		console.log('Summary:');
		for (const [pair, pairOutcomes] of ToolCallRenderer._byModelAndMode(outcomes)) {
			const supported = pairOutcomes.filter((outcome) => outcome.status === 'supported');
			const text = `  ${pair}: ${ToolCallRenderer._abilitiesLine(pairOutcomes)}`;
			console.log(supported.length === 0 ? text : Chalk.green(text));
		}
		console.log('');

		const counts = ToolCallRenderer._counts(outcomes);
		const unsupportedText = counts.unsupported > 0 ? Chalk.red(`${counts.unsupported} unsupported`) : `${counts.unsupported} unsupported`;
		const failedText = counts.failed > 0 ? Chalk.red(`${counts.failed} failed`) : `${counts.failed} failed`;
		const inconclusiveText = counts.inconclusive > 0 ? Chalk.yellow(`${counts.inconclusive} inconclusive`) : `${counts.inconclusive} inconclusive`;
		console.log(`${counts.supported}/${counts.total} supported, ${counts.refused} refused, ${unsupportedText}, ${inconclusiveText}, ${failedText}`);
	}

	/**
	 * Writes a whole run out in the requested format, once every probe has finished.
	 *
	 * `json` and `markdown` carry every answer each probe produced, so a reader can check a
	 * conclusion against what the model really wrote rather than taking it on trust. That is what
	 * makes a run of this subcommand a finding worth recording on an issue instead of a claim.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatReport(outcomes: readonly ToolCallOutcome[], format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify({
				outcomes,
				summary: ToolCallRenderer._counts(outcomes),
			}, null, 2);
		}
		if (format === 'markdown') {
			return ToolCallRenderer._renderMarkdownReport(outcomes);
		}
		return [
			...outcomes.map((outcome) => ToolCallRenderer.outcomeLine(outcome)),
			...ToolCallRenderer.summaryLines(outcomes),
		].join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the summary line for one model and mode: the abilities it has, or a statement that it
	 * has none of the six.
	 *
	 * @param outcomes The probes run against that one model and mode.
	 * @returns The text to print after the model and mode.
	 */
	private static _abilitiesLine(outcomes: readonly ToolCallOutcome[]): string {
		const supported = outcomes.filter((outcome) => outcome.status === 'supported').map((outcome) => outcome.ability);
		if (supported.length === 0) {
			return 'none of the six abilities';
		}
		return supported.join(', ');
	}

	/**
	 * Groups the outcomes by the model and mode they were run against, keeping the order they were
	 * run in.
	 *
	 * @param outcomes Every probe run.
	 * @returns One entry per model and mode pair, keyed by the text naming that pair.
	 */
	private static _byModelAndMode(outcomes: readonly ToolCallOutcome[]): Map<string, ToolCallOutcome[]> {
		const grouped = new Map<string, ToolCallOutcome[]>();
		for (const outcome of outcomes) {
			const key = `${outcome.modelId} (${outcome.mode})`;
			const existing = grouped.get(key);
			if (existing === undefined) {
				grouped.set(key, [outcome]);
				continue;
			}
			existing.push(outcome);
		}
		return grouped;
	}

	/**
	 * Counts how many probes reached each conclusion.
	 *
	 * @param outcomes Every probe run.
	 * @returns The counts printed at the end of a run.
	 */
	private static _counts(outcomes: readonly ToolCallOutcome[]): { supported: number; unsupported: number; refused: number; inconclusive: number; failed: number; total: number } {
		return {
			supported: outcomes.filter((outcome) => outcome.status === 'supported').length,
			unsupported: outcomes.filter((outcome) => outcome.status === 'unsupported').length,
			refused: outcomes.filter((outcome) => outcome.status === 'refused').length,
			inconclusive: outcomes.filter((outcome) => outcome.status === 'inconclusive').length,
			failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
			total: outcomes.length,
		};
	}

	/**
	 * Renders a whole run as markdown: one row per probe, then the counts, then every answer each
	 * probe drew its conclusion from.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(outcomes: readonly ToolCallOutcome[]): string {
		const rows = outcomes.map((outcome) => `| ${outcome.modelId} | ${outcome.mode} | ${outcome.ability} | ${outcome.status} | ${outcome.observation} |`);
		const counts = ToolCallRenderer._counts(outcomes);
		const answerBlocks = outcomes.map((outcome) => [
			`### ${outcome.modelId} (${outcome.mode}) ${outcome.ability} — ${outcome.status}`,
			'',
			'```',
			...outcome.answers.map((answer, answerIndex) => `run ${answerIndex}: ${JSON.stringify(answer)}`),
			'```',
		].join('\n'));
		const blocks: string[] = [
			'# OpenAI API tool call probe',
			[
				'| Model | Mode | Ability | Status | Observation |',
				'| --- | --- | --- | --- | --- |',
				...rows,
			].join('\n'),
			`${counts.supported}/${counts.total} supported, ${counts.refused} refused, ${counts.unsupported} unsupported, ${counts.inconclusive} inconclusive, ${counts.failed} failed`,
			'## The answers each conclusion was drawn from',
			...answerBlocks,
		];
		return `${blocks.join('\n\n')}\n`;
	}
}
