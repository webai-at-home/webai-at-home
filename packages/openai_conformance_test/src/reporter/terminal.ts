// npm imports
import Chalk from 'chalk';

// local imports
import type { TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TerminalReporter — the human-readable report printed after a run, section 33's `text` format
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `TerminalReporter.render` needs beyond the run records themselves. */
export type TerminalReportOptions = {
	/** The endpoint's base URL, printed in the header. */
	readonly endpoint: string;
	/** The model identifier requested, printed in the header. */
	readonly modelId: string;
};

/** Renders a run's records as the terminal report a person reads. */
export class TerminalReporter {
	/** The heading printed above each group's tests, in the order the groups are printed. */
	private static readonly _groupHeadings: ReadonlyMap<string, string> = new Map([
		['models', 'Models'],
		['chat', 'Chat Completions'],
		['usage', 'Usage'],
		['errors', 'Errors'],
		['streaming', 'Streaming'],
		['tools', 'Tool Calling'],
		['parameters', 'Parameters'],
		['structured_output', 'Structured Output'],
		['sdk', 'OpenAI Node.js Package'],
	]);

	/**
	 * Renders a run's records into the report section 33 of issue #181 calls the `text` format: a
	 * header naming the endpoint and the model, one heading per group with one line per test under
	 * it, a summary count, and a compatibility percentage that never replaces the lines above it.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to name in the header.
	 * @returns The complete report, ready to print.
	 */
	static render(records: readonly TestRunRecord[], options: TerminalReportOptions): string {
		const lines: string[] = [Chalk.bold('OpenAI API Conformance Test'), `Endpoint: ${options.endpoint}`, `Model: ${options.modelId}`, ''];

		for (const group of TerminalReporter._orderedGroups(records)) {
			lines.push(Chalk.bold(TerminalReporter._groupHeadings.get(group) ?? group));
			for (const record of records.filter((candidate) => candidate.test.group === group)) {
				lines.push(`  ${TerminalReporter._testLine(record)}`);
			}
			lines.push('');
		}

		lines.push('-'.repeat(40));
		lines.push('');
		lines.push(...TerminalReporter._summaryLines(records));

		return lines.join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Lists every group present in `records`, in the order its first test was run.
	 *
	 * @param records Every test's outcome.
	 * @returns The distinct group names, first-seen order.
	 */
	private static _orderedGroups(records: readonly TestRunRecord[]): string[] {
		const groups: string[] = [];
		for (const record of records) {
			if (groups.includes(record.test.group) === false) {
				groups.push(record.test.group);
			}
		}
		return groups;
	}

	/**
	 * Builds the one line printed for one test's outcome.
	 *
	 * @param record The test and the outcome it reached.
	 * @returns The line to print, colored by verdict.
	 */
	private static _testLine(record: TestRunRecord): string {
		const line = `${TerminalReporter._icon(record.result.verdict)} ${record.test.name}`;
		const colored = TerminalReporter._colorByVerdict(record.result.verdict, line);
		if (record.result.verdict === 'PASS') {
			return colored;
		}
		return `${colored} — ${record.result.detail}`;
	}

	/**
	 * The symbol printed ahead of one test's name, one per verdict so `SKIP` and `WARN` are never
	 * mistaken for `FAIL` at a glance.
	 *
	 * @param verdict The verdict to symbolize.
	 * @returns The symbol.
	 */
	private static _icon(verdict: Verdict): string {
		switch (verdict) {
			case 'PASS':
				return '✓';
			case 'FAIL':
				return '✗';
			case 'SKIP':
				return '⊘';
			case 'WARN':
				return '⚠';
		}
	}

	/**
	 * Colors one line by its verdict: green for `PASS`, red for `FAIL`, dim for `SKIP`, yellow for
	 * `WARN`. Chalk turns coloring off automatically once output is piped or redirected.
	 *
	 * @param verdict The verdict to color by.
	 * @param line The line to color.
	 * @returns The colored line.
	 */
	private static _colorByVerdict(verdict: Verdict, line: string): string {
		switch (verdict) {
			case 'PASS':
				return Chalk.green(line);
			case 'FAIL':
				return Chalk.red(line);
			case 'SKIP':
				return Chalk.dim(line);
			case 'WARN':
				return Chalk.yellow(line);
		}
	}

	/**
	 * Builds the summary lines printed at the end of the report: a count per verdict, and a
	 * compatibility percentage.
	 *
	 * `SKIP` is left out of the percentage's denominator, because a feature the endpoint has
	 * declared it does not support was never a candidate for compatibility. `WARN` stays in the
	 * denominator on the side of "not yet confirmed compatible", alongside `FAIL`, so the
	 * percentage never rises on a result this package could not fully confirm.
	 *
	 * @param records Every test's outcome.
	 * @returns The summary lines, in order.
	 */
	private static _summaryLines(records: readonly TestRunRecord[]): string[] {
		const passedCount = records.filter((record) => record.result.verdict === 'PASS').length;
		const failedCount = records.filter((record) => record.result.verdict === 'FAIL').length;
		const skippedCount = records.filter((record) => record.result.verdict === 'SKIP').length;
		const warnedCount = records.filter((record) => record.result.verdict === 'WARN').length;
		const scoredCount = records.length - skippedCount;
		const compatibility = scoredCount === 0 ? 100 : (passedCount / scoredCount) * 100;

		const lines = [`Passed: ${passedCount}`, Chalk.red(`Failed: ${failedCount}`), Chalk.dim(`Skipped: ${skippedCount}`)];
		if (warnedCount > 0) {
			lines.push(Chalk.yellow(`Warned: ${warnedCount}`));
		}
		lines.push('', `Compatibility: ${compatibility.toFixed(1)}%`);
		return lines;
	}
}
