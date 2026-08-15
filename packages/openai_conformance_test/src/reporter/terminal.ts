// npm imports
import Chalk from 'chalk';

// local imports
import type { TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';
import { ReportSummary } from './report_summary.js';

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
	/**
	 * Whether to print the detail of a test that passed as well.
	 *
	 * A passing test's detail is suppressed by default so the report reads as a list of what
	 * worked; `--verbose` is what section 25 of issue #181 asks for when the measurement behind a
	 * pass is the interesting part, such as the chunk timings behind `streaming.timing`.
	 */
	readonly verbose?: boolean;
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
				lines.push(`  ${TerminalReporter._testLine(record, options.verbose === true)}`);
			}
			lines.push('');
		}

		lines.push('-'.repeat(40));
		lines.push('');
		lines.push(...TerminalReporter._featureMatrixLines(records));
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
	 * @param verbose Whether to print the detail of a test that passed as well.
	 * @returns The line to print, colored by verdict.
	 */
	private static _testLine(record: TestRunRecord, verbose: boolean): string {
		const line = `${TerminalReporter._statusWord(record.result.verdict)} ${record.test.name}`;
		const colored = TerminalReporter._colorByVerdict(record.result.verdict, line);
		if (record.result.verdict === 'PASS' && verbose === false) {
			return colored;
		}
		const detail = verbose === true ? `${record.result.detail} [${record.test.id}, ${record.durationMs} ms]` : record.result.detail;
		return `${colored} — ${detail}`;
	}

	/**
	 * The word printed ahead of one test's name, one per verdict so `SKIP` and `WARN` are never
	 * mistaken for `FAIL` at a glance.
	 *
	 * @param verdict The verdict to name.
	 * @returns The word.
	 */
	private static _statusWord(verdict: Verdict): string {
		switch (verdict) {
			case 'PASS':
				return 'OK';
			case 'FAIL':
				return 'Failed';
			case 'SKIP':
				return 'Skipped';
			case 'WARN':
				return 'Warn';
		}
	}

	/**
	 * Colors one line by its verdict: green for `PASS`, red for `FAIL`, cyan for `SKIP`, yellow for
	 * `WARN`. Cyan keeps `SKIP` visibly distinct from a dimmed, uncolored line. Chalk turns coloring
	 * off automatically once output is piped or redirected.
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
				return Chalk.cyan(line);
			case 'WARN':
				return Chalk.yellow(line);
		}
	}

	/**
	 * Builds the feature matrix of section 31 of issue #181: one line per group, saying whether
	 * every test in it passed.
	 *
	 * Section 31 calls this more useful than the overall percentage, and section 30 says the
	 * percentage must never replace the detail, so the matrix is printed above the percentage
	 * rather than instead of it.
	 *
	 * A group is `✓` only when every test in it passed. A group holding any `FAIL` is `✗`; one
	 * holding no failure but some `WARN` is `⚠`; one every test of which was skipped is `⊘`, since
	 * nothing about it was learned.
	 *
	 * @param records Every test's outcome.
	 * @returns The matrix lines, in order.
	 */
	private static _featureMatrixLines(records: readonly TestRunRecord[]): string[] {
		const lines: string[] = [Chalk.bold('Capability'.padEnd(28) + 'Status'), ''];
		for (const group of TerminalReporter._orderedGroups(records)) {
			const groupRecords = records.filter((record) => record.test.group === group);
			const verdict = TerminalReporter._groupVerdict(groupRecords);
			const heading = TerminalReporter._groupHeadings.get(group) ?? group;
			lines.push(`${heading.padEnd(28)}${TerminalReporter._colorByVerdict(verdict, TerminalReporter._statusWord(verdict))}`);
		}
		return lines;
	}

	/**
	 * Reduces one group's outcomes to the single verdict its feature matrix line shows.
	 *
	 * @param groupRecords Every outcome of one group.
	 * @returns `FAIL` if any test failed, `WARN` if any warned, `SKIP` if every test was skipped,
	 * `PASS` otherwise.
	 */
	private static _groupVerdict(groupRecords: readonly TestRunRecord[]): Verdict {
		if (groupRecords.some((record) => record.result.verdict === 'FAIL')) {
			return 'FAIL';
		}
		if (groupRecords.some((record) => record.result.verdict === 'WARN')) {
			return 'WARN';
		}
		if (groupRecords.every((record) => record.result.verdict === 'SKIP')) {
			return 'SKIP';
		}
		return 'PASS';
	}

	/**
	 * Builds the summary lines printed at the end of the report: a count per verdict, and a
	 * compatibility percentage.
	 *
	 * The arithmetic itself lives in `ReportSummary`, so every reporter shows the same numbers.
	 *
	 * @param records Every test's outcome.
	 * @returns The summary lines, in order.
	 */
	private static _summaryLines(records: readonly TestRunRecord[]): string[] {
		const summary = ReportSummary.of(records);
		const lines = [`Passed: ${summary.passedCount}`, Chalk.red(`Failed: ${summary.failedCount}`), Chalk.cyan(`Skipped: ${summary.skippedCount}`)];
		if (summary.warnedCount > 0) {
			lines.push(Chalk.yellow(`Warned: ${summary.warnedCount}`));
		}
		lines.push('', `Compatibility: ${summary.compatibilityPercent.toFixed(1)}%`);
		return lines;
	}
}
