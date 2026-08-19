// npm imports
import Chalk from 'chalk';

// local imports
import {
	reportFormats,
	type BenchmarkReport,
	type BenchmarkSummary,
	type ReportFormat,
	type SweepOutcome,
	type SweepStatus,
	type UsageOutcome,
} from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportRenderer — turns outcomes and measurements into the lines a person reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Writes out what `completion`, `history`, and `benchmark` produced. */
export class ReportRenderer {
	/**
	 * Builds the analysis line for one swept model and mode pair. The raw answer, or the two
	 * turns of a history, have already been written out as they were produced, so this line
	 * reads as commentary on text already shown rather than repeating it.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The one line to print.
	 */
	static sweepOutcomeLine(outcome: SweepOutcome): string {
		if (outcome.status === 'skipped') {
			return `${outcome.modelId} (${outcome.mode}): skipped — ${String(outcome.failureMessage)}`;
		}
		const timings = [
			`first character in ${Math.round(outcome.timeToFirstCharacterMs)} ms`,
			`last character in ${Math.round(outcome.timeToLastCharacterMs)} ms`,
			`${outcome.characterCount} characters`,
			...(outcome.clusterGenerationTimeMs !== undefined ? [`${Math.round(outcome.clusterGenerationTimeMs)} ms of it spent generating inside the cluster`] : []),
			...(outcome.clusterTimeToFirstPieceMs !== undefined ? [`${Math.round(outcome.clusterTimeToFirstPieceMs)} ms of it spent inside the cluster before the first piece`] : []),
		].join(', ');
		const line = `${outcome.modelId} (${outcome.mode}): ${outcome.status} — ${timings}`;
		if (outcome.status === 'failed') {
			return `${line} — ${String(outcome.failureMessage)}`;
		}
		return line;
	}

	/**
	 * Prints the analysis line for one swept model and mode pair, sending a failure to the error
	 * output so that a run piped into a file still shows what went wrong. Colored green for
	 * `ok`, yellow for `skipped`, and red for `failed`, turned off automatically once output is
	 * piped or redirected.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	static printSweepOutcome(outcome: SweepOutcome): void {
		const line = ReportRenderer._colorByStatus(outcome.status, ReportRenderer.sweepOutcomeLine(outcome));
		if (outcome.status === 'failed') {
			console.error(line);
			return;
		}
		console.log(line);
	}

	/**
	 * Builds the summary table printed at the end of a sweep.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The lines to print, in order.
	 */
	static sweepSummaryLines(outcomes: readonly SweepOutcome[]): string[] {
		const lines: string[] = ['', 'Summary:'];
		for (const outcome of outcomes) {
			lines.push(`  ${outcome.modelId} (${outcome.mode}): ${outcome.status}`);
		}
		const failureCount = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skippedCount = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		const passedCount = outcomes.length - failureCount - skippedCount;
		lines.push('');
		lines.push(`${passedCount}/${outcomes.length} passed, ${skippedCount} skipped, ${failureCount} failed`);
		return lines;
	}

	/**
	 * Prints the summary table at the end of a sweep. Each per-pair line is colored by its
	 * status, and the final counts line highlights `skipped`/`failed` in color when either is
	 * above zero, turned off automatically once output is piped or redirected.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns Nothing.
	 */
	static printSweepSummary(outcomes: readonly SweepOutcome[]): void {
		console.log('');
		console.log('Summary:');
		for (const outcome of outcomes) {
			console.log(ReportRenderer._colorByStatus(outcome.status, `  ${outcome.modelId} (${outcome.mode}): ${outcome.status}`));
		}
		console.log('');

		const failureCount = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skippedCount = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		const passedCount = outcomes.length - failureCount - skippedCount;
		const skippedText = skippedCount > 0 ? Chalk.yellow(`${skippedCount} skipped`) : `${skippedCount} skipped`;
		const failedText = failureCount > 0 ? Chalk.red(`${failureCount} failed`) : `${failureCount} failed`;
		console.log(`${passedCount}/${outcomes.length} passed, ${skippedText}, ${failedText}`);
	}

	/**
	 * Writes a benchmark report out in the requested format.
	 *
	 * @param report The full benchmark report to write.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatBenchmarkReport(report: BenchmarkReport, format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify(report, null, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownReport(report);
		}
		return ReportRenderer._renderTextReport(report);
	}

	/**
	 * Writes a `completion` or `history` sweep report out in the requested format, once the
	 * sweep has finished. `markdown` and `json` hold every outcome plus the passed/skipped/failed
	 * counts; `text` reuses the same lines `printSweepOutcome`/`printSweepSummary` print live,
	 * uncolored, for a caller that wants the sweep run silently and printed once at the end.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatSweepReport(outcomes: readonly SweepOutcome[], format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify({ outcomes, summary: ReportRenderer._sweepCounts(outcomes) }, null, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownSweepReport(outcomes);
		}
		return [
			...outcomes.map((outcome) => ReportRenderer.sweepOutcomeLine(outcome)),
			...ReportRenderer.sweepSummaryLines(outcomes),
		].join('\n');
	}

	/**
	 * Reports whether a string names a format `formatBenchmarkReport`/`formatSweepReport` can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isReportFormat(value: string): value is ReportFormat {
		return (reportFormats as readonly string[]).includes(value);
	}

	/**
	 * Builds the analysis line for one swept model and mode pair's usage outcome.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The one line to print.
	 */
	static usageOutcomeLine(outcome: UsageOutcome): string {
		if (outcome.status === 'skipped') {
			return `${outcome.modelId} (${outcome.mode}): skipped — ${String(outcome.failureMessage)}`;
		}
		if (outcome.status === 'failed') {
			return `${outcome.modelId} (${outcome.mode}): failed — ${String(outcome.failureMessage)}`;
		}
		const finishReasonText = `finish_reason ${outcome.finishReason ?? 'unknown'}`;
		if (outcome.usagePresent === false || outcome.usage === undefined) {
			return `${outcome.modelId} (${outcome.mode}): ok — usage not reported, ${finishReasonText}`;
		}
		const usage = outcome.usage;
		return `${outcome.modelId} (${outcome.mode}): ok — usage present, prompt_tokens ${usage.promptTokens}, completion_tokens ${usage.completionTokens}, total_tokens ${usage.totalTokens}, ${finishReasonText}`;
	}

	/**
	 * Prints the analysis line for one swept model and mode pair's usage outcome, sending a
	 * failure to the error output so that a run piped into a file still shows what went wrong.
	 * Colored green for `ok`, yellow for `skipped`, and red for `failed`, turned off automatically
	 * once output is piped or redirected.
	 *
	 * @param outcome The outcome to print.
	 * @returns Nothing.
	 */
	static printUsageOutcome(outcome: UsageOutcome): void {
		const line = ReportRenderer._colorByStatus(outcome.status, ReportRenderer.usageOutcomeLine(outcome));
		if (outcome.status === 'failed') {
			console.error(line);
			return;
		}
		console.log(line);
	}

	/**
	 * Builds the summary table printed at the end of a `usage` sweep.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The lines to print, in order.
	 */
	static usageSummaryLines(outcomes: readonly UsageOutcome[]): string[] {
		const lines: string[] = ['', 'Summary:'];
		for (const outcome of outcomes) {
			lines.push(`  ${outcome.modelId} (${outcome.mode}): ${ReportRenderer._usageSummaryText(outcome)}`);
		}
		const counts = ReportRenderer._usageCounts(outcomes);
		lines.push('');
		lines.push(`${counts.reportingUsage}/${counts.total} reported usage, ${counts.skipped} skipped, ${counts.failed} failed`);
		return lines;
	}

	/**
	 * Prints the summary table at the end of a `usage` sweep. Each per-pair line is colored by its
	 * status, and the final counts line highlights `skipped`/`failed` in color when either is
	 * above zero, turned off automatically once output is piped or redirected.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns Nothing.
	 */
	static printUsageSummary(outcomes: readonly UsageOutcome[]): void {
		console.log('');
		console.log('Summary:');
		for (const outcome of outcomes) {
			console.log(ReportRenderer._colorByStatus(outcome.status, `  ${outcome.modelId} (${outcome.mode}): ${ReportRenderer._usageSummaryText(outcome)}`));
		}
		console.log('');

		const counts = ReportRenderer._usageCounts(outcomes);
		const skippedText = counts.skipped > 0 ? Chalk.yellow(`${counts.skipped} skipped`) : `${counts.skipped} skipped`;
		const failedText = counts.failed > 0 ? Chalk.red(`${counts.failed} failed`) : `${counts.failed} failed`;
		console.log(`${counts.reportingUsage}/${counts.total} reported usage, ${skippedText}, ${failedText}`);
	}

	/**
	 * Writes a `usage` sweep report out in the requested format, once the sweep has finished.
	 * `markdown` and `json` hold every outcome plus the reported/skipped/failed counts; `text`
	 * reuses the same lines `printUsageOutcome`/`printUsageSummary` print live, uncolored, for a
	 * caller that wants the sweep run silently and printed once at the end.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print.
	 */
	static formatUsageReport(outcomes: readonly UsageOutcome[], format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify({ outcomes, summary: ReportRenderer._usageCounts(outcomes) }, null, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownUsageReport(outcomes);
		}
		return [
			...outcomes.map((outcome) => ReportRenderer.usageOutcomeLine(outcome)),
			...ReportRenderer.usageSummaryLines(outcomes),
		].join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Colors one printed line by a sweep outcome's status: green for `ok`, yellow for
	 * `skipped`, red for `failed`. Turned off automatically once output is piped or redirected.
	 *
	 * @param status The status the line describes.
	 * @param line The line to color.
	 * @returns The colored line.
	 */
	private static _colorByStatus(status: SweepStatus, line: string): string {
		if (status === 'ok') {
			return Chalk.green(line);
		}
		if (status === 'skipped') {
			return Chalk.yellow(line);
		}
		return Chalk.red(line);
	}

	/**
	 * Counts how a sweep's outcomes turned out.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The passed, skipped, failed, and total counts.
	 */
	private static _sweepCounts(outcomes: readonly SweepOutcome[]): { passed: number; skipped: number; failed: number; total: number } {
		const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		return {
			passed: outcomes.length - failed - skipped,
			skipped,
			failed,
			total: outcomes.length,
		};
	}

	/**
	 * The short status text one `usage` sweep summary line shows for one outcome.
	 *
	 * @param outcome The outcome to describe.
	 * @returns `usage present` or `usage not reported` for an `ok` outcome, and the status itself
	 * for a `skipped` or `failed` outcome.
	 */
	private static _usageSummaryText(outcome: UsageOutcome): string {
		if (outcome.status !== 'ok') {
			return outcome.status;
		}
		return outcome.usagePresent === true ? 'usage present' : 'usage not reported';
	}

	/**
	 * Counts how a `usage` sweep's outcomes turned out.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The count of outcomes that reported usage, the skipped, failed, and total counts.
	 */
	private static _usageCounts(outcomes: readonly UsageOutcome[]): { reportingUsage: number; skipped: number; failed: number; total: number } {
		const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
		const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
		const reportingUsage = outcomes.filter((outcome) => outcome.usagePresent === true).length;
		return {
			reportingUsage,
			skipped,
			failed,
			total: outcomes.length,
		};
	}

	/**
	 * Renders a `usage` sweep report as markdown, one row per swept pair, followed by the
	 * reported/skipped/failed counts.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownUsageReport(outcomes: readonly UsageOutcome[]): string {
		const rows = outcomes.map((outcome) => [
			'|',
			outcome.modelId,
			'|',
			outcome.mode,
			`| ${outcome.status}`,
			`| ${outcome.usagePresent === true ? 'yes' : 'no'}`,
			`| ${outcome.usage?.promptTokens ?? ''}`,
			`| ${outcome.usage?.completionTokens ?? ''}`,
			`| ${outcome.usage?.totalTokens ?? ''}`,
			`| ${outcome.finishReason ?? ''}`,
			`| ${outcome.failureMessage ?? ''} |`,
		].join(' '));
		const counts = ReportRenderer._usageCounts(outcomes);
		const blocks: string[] = [
			'# OpenAI API usage sweep',
			[
				'| Model | Mode | Status | Usage Present | Prompt Tokens | Completion Tokens | Total Tokens | Finish Reason | Failure |',
				'| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |',
				...rows,
			].join('\n'),
			`${counts.reportingUsage}/${counts.total} reported usage, ${counts.skipped} skipped, ${counts.failed} failed`,
		];
		return `${blocks.join('\n\n')}\n`;
	}

	/**
	 * Renders a `completion` or `history` sweep report as markdown, one row per swept pair,
	 * followed by the passed/skipped/failed counts, and — only when `history` set `turns` on at
	 * least one outcome — a transcript section listing every message of every such outcome.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownSweepReport(outcomes: readonly SweepOutcome[]): string {
		const rows = outcomes.map((outcome) => [
			'|',
			outcome.modelId,
			'|',
			outcome.mode,
			`| ${outcome.status}`,
			`| ${ReportRenderer._rounded(outcome.timeToFirstCharacterMs)} ms`,
			`| ${ReportRenderer._rounded(outcome.timeToLastCharacterMs)} ms`,
			`| ${outcome.characterCount}`,
			`| ${ReportRenderer._clusterTimeCell(outcome)}`,
			`| ${outcome.failureMessage ?? ''} |`,
		].join(' '));
		const counts = ReportRenderer._sweepCounts(outcomes);
		const blocks: string[] = [
			'# OpenAI API sweep',
			[
				'| Model | Mode | Status | Time to First Character | Time to Last Character | Characters | Cluster Generation Time | Failure |',
				'| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
				...rows,
			].join('\n'),
			`${counts.passed}/${counts.total} passed, ${counts.skipped} skipped, ${counts.failed} failed`,
		];
		const turnsSection = ReportRenderer._renderTurnsSection(outcomes);
		if (turnsSection !== undefined) {
			blocks.push(turnsSection);
		}
		return `${blocks.join('\n\n')}\n`;
	}

	/**
	 * Renders the `## Turns` section of a markdown sweep report, one subsection per outcome that
	 * carries `turns`, listing every message in the order it was sent.
	 *
	 * @param outcomes Every pair swept, in the order they were swept.
	 * @returns The section as markdown, or `undefined` when no outcome carries `turns`.
	 */
	private static _renderTurnsSection(outcomes: readonly SweepOutcome[]): string | undefined {
		const outcomesWithTurns = outcomes.filter((outcome) => outcome.turns !== undefined && outcome.turns.length > 0);
		if (outcomesWithTurns.length === 0) {
			return undefined;
		}
		const subsections = outcomesWithTurns.map((outcome) => {
			const turnLines = (outcome.turns ?? []).map((turn) => `- **${turn.role}**: ${turn.content}`);
			return [`### ${outcome.modelId} (${outcome.mode})`, ...turnLines].join('\n');
		});
		return ['## Turns', ...subsections].join('\n\n');
	}

	/**
	 * Renders one sweep outcome's cluster-reported generation time for the markdown table, from
	 * whichever of the two, mode-dependent figures the outcome carries.
	 *
	 * @param outcome The outcome to describe.
	 * @returns The cell text: the figure and which one it is, or an em dash when the endpoint
	 * reported neither, which every endpoint other than this project's own `consumer_openai`
	 * server does.
	 */
	private static _clusterTimeCell(outcome: SweepOutcome): string {
		if (outcome.clusterGenerationTimeMs !== undefined) {
			return `${ReportRenderer._rounded(outcome.clusterGenerationTimeMs)} ms (generation)`;
		}
		if (outcome.clusterTimeToFirstPieceMs !== undefined) {
			return `${ReportRenderer._rounded(outcome.clusterTimeToFirstPieceMs)} ms (to first piece)`;
		}
		return '—';
	}

	/**
	 * Rounds a report number for readable human output, while the JSON format keeps full values.
	 *
	 * @param value The report number to round.
	 * @returns The number as text with two decimal places.
	 */
	private static _rounded(value: number): string {
		return value.toFixed(2);
	}

	/**
	 * Renders the benchmark report as the compact human-readable text printed to a terminal, one
	 * block per measured model.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one string.
	 */
	private static _renderTextReport(report: BenchmarkReport): string {
		const lines: string[] = [
			Chalk.bold(`OpenAI API benchmark (parallelism: ${report.settings.parallelism})`),
			Chalk.dim(`Measured requests: ${report.settings.runs}; warm-up requests: ${report.settings.warmupRuns}`),
		];
		for (const summary of report.summaries) {
			lines.push('');
			lines.push(Chalk.cyan.bold(`${summary.baseUrl} (${summary.modelId})`));
			lines.push(`  ${Chalk.dim('Time to First Character:      ')} ${ReportRenderer._statisticsLine(summary.timeToFirstCharacterMs)}`);
			lines.push(`  ${Chalk.dim('Time to Last Character:       ')} ${ReportRenderer._statisticsLine(summary.timeToLastCharacterMs)}`);
			lines.push(`  ${Chalk.dim('Input Characters:             ')} ${summary.inputCharacters} characters`);
			lines.push(`  ${Chalk.dim('Output Characters:            ')} ${ReportRenderer._rounded(summary.outputCharacters.average)} characters average`);
			lines.push(
				`  ${Chalk.dim('Output Characters per Second: ')} ${Chalk.green.bold(`${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} characters/second average`)}`,
			);
		}
		return lines.join('\n');
	}

	/**
	 * Renders one metric's average, median, and range as the single line the text report shows.
	 *
	 * @param statistics The statistics of one metric, in milliseconds.
	 * @returns The one line describing the metric.
	 */
	private static _statisticsLine(statistics: BenchmarkSummary['timeToFirstCharacterMs']): string {
		const average = ReportRenderer._rounded(statistics.average);
		const median = ReportRenderer._rounded(statistics.median);
		const minimum = ReportRenderer._rounded(statistics.minimum);
		const maximum = ReportRenderer._rounded(statistics.maximum);
		return `${average} ms average, ${median} ms median, ${minimum}–${maximum} ms range`;
	}

	/**
	 * Renders the benchmark report as markdown, so it can be pasted straight into an issue, a
	 * pull request, or a notes file and still read as a report. Every measured model is one row
	 * of one table, which is what makes a sweep across several models worth reading.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(report: BenchmarkReport): string {
		const rows = report.summaries.map((summary) => [
			'|',
			summary.baseUrl,
			'|',
			summary.modelId,
			`| ${ReportRenderer._rounded(summary.timeToFirstCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.timeToLastCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} chars/s`,
			`| ${summary.inputCharacters}`,
			`| ${ReportRenderer._rounded(summary.outputCharacters.average)} |`,
		].join(' '));
		const blocks: string[] = [
			'# OpenAI API benchmark',
			`Parallelism: ${report.settings.parallelism} · measured requests: ${report.settings.runs} · warm-up requests: ${report.settings.warmupRuns}`,
			[
				'| Base URL | Model | Time to First Character | Time to Last Character | Output Characters per Second | Input Characters | Output Characters |',
				'| --- | --- | ---: | ---: | ---: | ---: | ---: |',
				...rows,
			].join('\n'),
		];
		return `${blocks.join('\n\n')}\n`;
	}
}
