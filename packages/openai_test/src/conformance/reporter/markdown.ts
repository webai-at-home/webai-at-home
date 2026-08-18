// local imports
import type { TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';
import { ReportSummary } from './report_summary.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MarkdownReporter — the report of section 28 of issue #181, for a GitHub issue or a CI artifact
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One command line parameter this run was given, as it is written into the report. */
export type ReportParameter = {
	/** The option name, spelled the way the command line spells it, such as `--profile`. */
	readonly name: string;
	/** The value that option ended up with, after commander applied its default. */
	readonly value: string;
};

/** What `MarkdownReporter.render` needs beyond the run records themselves. */
export type MarkdownReportOptions = {
	/** The endpoint's base URL. */
	readonly endpoint: string;
	/** The model identifier requested. */
	readonly modelId: string;
	/**
	 * When this run was generated, written into the report so that a report file found later says
	 * how old its measurements are.
	 *
	 * Left out by a caller that has no clock to offer, in which case the report is stamped with the
	 * moment it was rendered.
	 */
	readonly generatedAt?: Date;
	/**
	 * Every command line parameter this run was given, including the ones commander filled in from a
	 * default, so that a report says what was measured rather than only what came out.
	 *
	 * The bearer token is never among them in readable form. A report file is written to be pasted
	 * into a GitHub issue or committed beside the code, and a secret written into one is a secret
	 * published; whoever builds this list replaces that value before it arrives here.
	 */
	readonly parameters?: readonly ReportParameter[];
	/**
	 * The command line that produced this run, as one line a reader can run again.
	 *
	 * Carries the same redaction the parameter list does, for the same reason.
	 */
	readonly commandLine?: string;
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
	 * Renders a run as markdown: the counts and the percentage first, then what was run, then one
	 * table per group.
	 *
	 * The summary is at the head rather than at the foot because a reader opening a report file
	 * wants the one number before the thirty rows that produced it, and a reader who wants the rows
	 * scrolls to them either way.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to name in the document, and, when the caller has
	 * them, when the run was generated and which command line parameters it was given.
	 * @returns The markdown document, ready to print or redirect to a file.
	 */
	static render(records: readonly TestRunRecord[], options: MarkdownReportOptions): string {
		const lines: string[] = ['# OpenAI Compatibility Report', ''];

		const summary = ReportSummary.of(records);
		lines.push('## Summary', '');
		lines.push(`- Passed: ${summary.passedCount}`);
		lines.push(`- Failed: ${summary.failedCount}`);
		lines.push(`- Skipped: ${summary.skippedCount}`);
		lines.push(`- Warned: ${summary.warnedCount}`);
		lines.push('', `Compatibility: ${summary.compatibilityPercent.toFixed(1)}%`, '');
		lines.push('A skipped test is a capability the endpoint declared it does not support, and is left out of the percentage. A warned test behaved correctly in a way that may still break a client.', '');

		lines.push(...MarkdownReporter._testRunSection(options));

		for (const group of MarkdownReporter._orderedGroups(records)) {
			lines.push(`## ${MarkdownReporter._groupHeadings.get(group) ?? group}`, '', '| Test | Result | Detail |', '| --- | --- | --- |');
			for (const record of records.filter((candidate) => candidate.test.group === group)) {
				const detail = record.result.verdict === 'PASS' ? '' : MarkdownReporter._escapeTableCell(record.result.detail);
				lines.push(`| \`${record.test.id}\` | ${MarkdownReporter._icon(record.result.verdict)} | ${detail} |`);
			}
			lines.push('');
		}

		return lines.join('\n').trimEnd();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the section saying when this run happened, what it was pointed at, and which command
	 * line parameters it was given.
	 *
	 * @param options The endpoint and the model, and the generation date, parameters, and command
	 * line when the caller offered them.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _testRunSection(options: MarkdownReportOptions): string[] {
		const generatedAt = options.generatedAt ?? new Date();
		const lines: string[] = ['## Test Run', ''];
		lines.push(`- Generated: ${generatedAt.toISOString()}`);
		lines.push(`- Endpoint: \`${options.endpoint}\``);
		lines.push(`- Model: \`${options.modelId}\``);
		lines.push('');

		if (options.commandLine !== undefined) {
			lines.push('### Command Line', '', '```bash', options.commandLine, '```', '');
		}

		if (options.parameters !== undefined && options.parameters.length > 0) {
			lines.push('### Parameters', '', '| Option | Value |', '| --- | --- |');
			for (const parameter of options.parameters) {
				lines.push(`| \`${parameter.name}\` | ${MarkdownReporter._escapeTableCell(parameter.value)} |`);
			}
			lines.push('');
		}

		return lines;
	}

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
