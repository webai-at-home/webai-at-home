// npm imports
import Chalk from 'chalk';

// local imports
import type { GenerationControlOutcome, GenerationControlStatus, ReportFormat } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlRenderer — turns generation control probe outcomes into the lines a person reads
//
//	Kept apart from `report_renderer.ts` because these outcomes answer a different question from
//	every other subcommand's: not how fast an endpoint answered or what it reported, but whether a
//	control it accepted actually changed the answer.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How each status is colored, and the word printed for it. Turned off automatically once output is piped. */
const colorByStatus: Record<GenerationControlStatus, (text: string) => string> = {
	honoured: (text) => Chalk.green(text),
	not_honoured: (text) => Chalk.red(text),
	refused: (text) => Chalk.cyan(text),
	inconclusive: (text) => Chalk.yellow(text),
	failed: (text) => Chalk.red(text),
};

/** Writes out what the `generation_controls` subcommand's probes concluded. */
export class GenerationControlRenderer {
	/**
	 * Builds the line for one probe outcome.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The one line to print.
	 */
	static outcomeLine(outcome: GenerationControlOutcome): string {
		return `${outcome.modelId} (${outcome.mode}) ${outcome.control}: ${outcome.status} — ${outcome.observation}`;
	}

	/**
	 * Prints the line for one probe outcome, colored by what it concluded, sending a failed probe
	 * to the error output so that a run piped into a file still shows what went wrong.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	static printOutcome(outcome: GenerationControlOutcome): void {
		const line = colorByStatus[outcome.status](GenerationControlRenderer.outcomeLine(outcome));
		if (outcome.status === 'failed') {
			console.error(line);
			return;
		}
		console.log(line);
	}

	/**
	 * Builds the summary printed at the end of a run: one line per model and mode naming the
	 * controls it honours, then the counts.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns The lines to print, in order.
	 */
	static summaryLines(outcomes: readonly GenerationControlOutcome[]): string[] {
		const lines: string[] = ['', 'Summary:'];
		for (const [pair, pairOutcomes] of GenerationControlRenderer._byModelAndMode(outcomes)) {
			const honoured = pairOutcomes.filter((outcome) => outcome.status === 'honoured').map((outcome) => outcome.control);
			lines.push(`  ${pair}: honours ${honoured.length === 0 ? 'none of the five' : honoured.join(', ')}`);
		}
		const counts = GenerationControlRenderer._counts(outcomes);
		lines.push('');
		lines.push(`${counts.honoured}/${counts.total} honoured, ${counts.refused} refused, ${counts.notHonoured} not honoured, ${counts.inconclusive} inconclusive, ${counts.failed} failed`);
		return lines;
	}

	/**
	 * Prints the summary at the end of a run, colored, with the counts that matter highlighted
	 * when they are above zero.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns Nothing.
	 */
	static printSummary(outcomes: readonly GenerationControlOutcome[]): void {
		console.log('');
		console.log('Summary:');
		for (const [pair, pairOutcomes] of GenerationControlRenderer._byModelAndMode(outcomes)) {
			const honoured = pairOutcomes.filter((outcome) => outcome.status === 'honoured').map((outcome) => outcome.control);
			const text = `  ${pair}: honours ${honoured.length === 0 ? 'none of the five' : honoured.join(', ')}`;
			console.log(honoured.length === 0 ? text : Chalk.green(text));
		}
		console.log('');

		const counts = GenerationControlRenderer._counts(outcomes);
		const notHonouredText = counts.notHonoured > 0 ? Chalk.red(`${counts.notHonoured} not honoured`) : `${counts.notHonoured} not honoured`;
		const failedText = counts.failed > 0 ? Chalk.red(`${counts.failed} failed`) : `${counts.failed} failed`;
		const inconclusiveText = counts.inconclusive > 0 ? Chalk.yellow(`${counts.inconclusive} inconclusive`) : `${counts.inconclusive} inconclusive`;
		console.log(`${counts.honoured}/${counts.total} honoured, ${counts.refused} refused, ${notHonouredText}, ${inconclusiveText}, ${failedText}`);
	}

	/**
	 * Writes a whole run out in the requested format, once every probe has finished.
	 *
	 * `json` and `markdown` carry every answer each probe produced, so a reader can check a
	 * conclusion against the text it was drawn from rather than taking it on trust.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatReport(outcomes: readonly GenerationControlOutcome[], format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify({ outcomes, summary: GenerationControlRenderer._counts(outcomes) }, null, 2);
		}
		if (format === 'markdown') {
			return GenerationControlRenderer._renderMarkdownReport(outcomes);
		}
		return [
			...outcomes.map((outcome) => GenerationControlRenderer.outcomeLine(outcome)),
			...GenerationControlRenderer.summaryLines(outcomes),
		].join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Groups the outcomes by the model and mode they were run against, keeping the order they
	 * were run in.
	 *
	 * @param outcomes Every probe run.
	 * @returns One entry per model and mode pair, keyed by the text naming that pair.
	 */
	private static _byModelAndMode(outcomes: readonly GenerationControlOutcome[]): Map<string, GenerationControlOutcome[]> {
		const grouped = new Map<string, GenerationControlOutcome[]>();
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
	private static _counts(outcomes: readonly GenerationControlOutcome[]): { honoured: number; notHonoured: number; refused: number; inconclusive: number; failed: number; total: number } {
		return {
			honoured: outcomes.filter((outcome) => outcome.status === 'honoured').length,
			notHonoured: outcomes.filter((outcome) => outcome.status === 'not_honoured').length,
			refused: outcomes.filter((outcome) => outcome.status === 'refused').length,
			inconclusive: outcomes.filter((outcome) => outcome.status === 'inconclusive').length,
			failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
			total: outcomes.length,
		};
	}

	/**
	 * Renders a whole run as markdown: one row per probe, then the counts, then the answers each
	 * probe drew its conclusion from.
	 *
	 * @param outcomes Every probe run, in the order they were run.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(outcomes: readonly GenerationControlOutcome[]): string {
		const rows = outcomes.map((outcome) => `| ${outcome.modelId} | ${outcome.mode} | ${outcome.control} | ${outcome.status} | ${outcome.observation} |`);
		const counts = GenerationControlRenderer._counts(outcomes);
		const answerBlocks = outcomes.map((outcome) => [
			`### ${outcome.modelId} (${outcome.mode}) ${outcome.control} — ${outcome.status}`,
			'',
			'```',
			...outcome.answers.map((answer, answerIndex) => `run ${answerIndex}: ${JSON.stringify(answer)}`),
			'```',
		].join('\n'));
		const blocks: string[] = [
			'# OpenAI API generation control probe',
			[
				'| Model | Mode | Control | Status | Observation |',
				'| --- | --- | --- | --- | --- |',
				...rows,
			].join('\n'),
			`${counts.honoured}/${counts.total} honoured, ${counts.refused} refused, ${counts.notHonoured} not honoured, ${counts.inconclusive} inconclusive, ${counts.failed} failed`,
			'## The answers each conclusion was drawn from',
			...answerBlocks,
		];
		return `${blocks.join('\n\n')}\n`;
	}
}
