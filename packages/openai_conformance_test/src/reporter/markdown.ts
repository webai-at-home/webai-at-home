// local imports
import type { TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';
import { ReportSummary } from './report_summary.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MarkdownReporter — the report of section 28 of issue #181, for a GitHub issue or a CI artifact
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `MarkdownReporter.render` needs beyond the run records themselves. */
export type MarkdownReportOptions = {
	/** The endpoint's base URL. */
	readonly endpoint: string;
	/** The model identifier requested. */
	readonly modelId: string;
};

/** Renders a run as the markdown document section 28 of issue #181 shows. */
export class MarkdownReporter {
	/** The heading printed above each group's table. */
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
	 * Renders a run as markdown: one table per group, then the counts and the percentage.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to name in the document.
	 * @returns The markdown document, ready to print or redirect to a file.
	 */
	static render(records: readonly TestRunRecord[], options: MarkdownReportOptions): string {
		const lines: string[] = ['# OpenAI Compatibility Report', '', `Endpoint: \`${options.endpoint}\``, '', `Model: \`${options.modelId}\``, ''];

		for (const group of MarkdownReporter._orderedGroups(records)) {
			lines.push(`## ${MarkdownReporter._groupHeadings.get(group) ?? group}`, '', '| Test | Result | Detail |', '| --- | --- | --- |');
			for (const record of records.filter((candidate) => candidate.test.group === group)) {
				const detail = record.result.verdict === 'PASS' ? '' : MarkdownReporter._escapeTableCell(record.result.detail);
				lines.push(`| \`${record.test.id}\` | ${MarkdownReporter._icon(record.result.verdict)} | ${detail} |`);
			}
			lines.push('');
		}

		const summary = ReportSummary.of(records);
		lines.push('## Summary', '');
		lines.push(`- Passed: ${summary.passedCount}`);
		lines.push(`- Failed: ${summary.failedCount}`);
		lines.push(`- Skipped: ${summary.skippedCount}`);
		lines.push(`- Warned: ${summary.warnedCount}`);
		lines.push('', `Compatibility: ${summary.compatibilityPercent.toFixed(1)}%`, '');
		lines.push('A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.');
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
	 * The emoji shown for one verdict in a table cell.
	 *
	 * @param verdict The verdict to show.
	 * @returns The emoji.
	 */
	private static _icon(verdict: Verdict): string {
		switch (verdict) {
			case 'PASS':
				return '✅';
			case 'FAIL':
				return '❌';
			case 'SKIP':
				return '⊘';
			case 'WARN':
				return '⚠️';
		}
	}

	/**
	 * Makes one detail safe to put inside a markdown table cell, where a newline ends the row and
	 * a vertical bar starts a new column.
	 *
	 * @param detail The detail to escape.
	 * @returns The escaped detail.
	 */
	private static _escapeTableCell(detail: string): string {
		return detail.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
	}
}
