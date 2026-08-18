// npm imports
import Chalk from 'chalk';

// local imports
import type { BenchmarkFailure, BenchmarkReport, BenchmarkSummary, MetricStatistics, ReportFormat } from '../completion_types.js';
import { reportFormats } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportRenderer — turns one benchmark report into the four formats `-f/--format` names
//
//	`text` is what a person reads in a terminal, `markdown` is what is pasted into an issue, `json`
//	is what another program reads, and `junit` is what a continuous integration run already knows
//	how to read. Every one of them names the models that could not be measured, so a report never
//	looks complete while a model it was asked to measure is quietly missing from it.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Renders a benchmark report in the format `-f/--format` named. */
export class ReportRenderer {
	/**
	 * Writes a benchmark report out in the requested format.
	 *
	 * @param report The full benchmark report to write.
	 * @param format Which format to write.
	 * @returns The whole report as one string, ready to print or to write to a file.
	 */
	static formatBenchmarkReport(report: BenchmarkReport, format: ReportFormat): string {
		if (format === 'json') {
			return JSON.stringify(report, undefined, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownReport(report);
		}
		if (format === 'junit') {
			return ReportRenderer._renderJunitReport(report);
		}
		return ReportRenderer._renderTextReport(report);
	}

	/**
	 * Reports whether a string names a format `formatBenchmarkReport` can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isReportFormat(value: string): value is ReportFormat {
		return (reportFormats as readonly string[]).includes(value);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
		for (const failure of report.failures ?? []) {
			lines.push('');
			lines.push(Chalk.red.bold(`${failure.modelId}: not measured`));
			lines.push(`  ${Chalk.dim('Why:                          ')} ${failure.reason}`);
		}
		return lines.join('\n');
	}

	/**
	 * Renders one metric's average, median, and range as the single line the text report shows.
	 *
	 * @param statistics The statistics of one metric, in milliseconds.
	 * @returns The one line describing the metric.
	 */
	private static _statisticsLine(statistics: MetricStatistics): string {
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
		const failureBlock = ReportRenderer._markdownFailureBlock(report.failures ?? []);
		if (failureBlock !== undefined) {
			blocks.push(failureBlock);
		}
		return `${blocks.join('\n\n')}\n`;
	}

	/**
	 * Renders the models that could not be measured as their own markdown section.
	 *
	 * @param failures The models that could not be measured, and why.
	 * @returns The section, or `undefined` when every model named was measured.
	 */
	private static _markdownFailureBlock(failures: readonly BenchmarkFailure[]): string | undefined {
		if (failures.length === 0) {
			return undefined;
		}
		return [
			'## Models not measured',
			'',
			'| Model | Why |',
			'| --- | --- |',
			...failures.map((failure) => `| ${failure.modelId} | ${ReportRenderer._escapeMarkdownCell(failure.reason)} |`),
		].join('\n');
	}

	/**
	 * Renders the benchmark report as one JUnit test suite, one test case per model named.
	 *
	 * A measured model is a passing case whose time is its average Time to Last Character, which is
	 * what a continuous integration run watching for a slowdown wants to read. A model that could
	 * not be measured is a `<failure>`, since the run was asked for a number and produced none.
	 *
	 * @param report The full benchmark report to render.
	 * @returns The XML document.
	 */
	private static _renderJunitReport(report: BenchmarkReport): string {
		const failures = report.failures ?? [];
		const totalSeconds = report.summaries
			.reduce((total, summary) => total + summary.timeToLastCharacterMs.average, 0) / 1000;
		const lines: string[] = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<testsuite name="openai_test.benchmark" tests="${report.summaries.length + failures.length}" failures="${failures.length}" skipped="0" time="${totalSeconds.toFixed(3)}">`,
			'\t<properties>',
			`\t\t<property name="prompt" value="${ReportRenderer._escapeXml(report.settings.prompt)}"/>`,
			`\t\t<property name="runs" value="${report.settings.runs}"/>`,
			`\t\t<property name="warmupRuns" value="${report.settings.warmupRuns}"/>`,
			'\t</properties>',
		];
		for (const summary of report.summaries) {
			lines.push(...ReportRenderer._junitMeasuredCaseLines(summary));
		}
		for (const failure of failures) {
			lines.push(
				`\t<testcase classname="benchmark" name="${ReportRenderer._escapeXml(failure.modelId)}" time="0.000">`,
				`\t\t<failure message="${ReportRenderer._escapeXml(failure.reason)}"/>`,
				'\t</testcase>',
			);
		}
		lines.push('</testsuite>');
		return lines.join('\n');
	}

	/**
	 * Builds the lines of one measured model's JUnit test case, carrying the three averages a
	 * reader of the XML would otherwise have to go back to the JSON report for.
	 *
	 * @param summary The aggregate measurements of one model.
	 * @returns The lines, in order.
	 */
	private static _junitMeasuredCaseLines(summary: BenchmarkSummary): string[] {
		const seconds = (summary.timeToLastCharacterMs.average / 1000).toFixed(3);
		const note = [
			`Time to First Character: ${ReportRenderer._rounded(summary.timeToFirstCharacterMs.average)} ms average`,
			`Time to Last Character: ${ReportRenderer._rounded(summary.timeToLastCharacterMs.average)} ms average`,
			`Output Characters per Second: ${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} average`,
		].join('; ');
		return [
			`\t<testcase classname="benchmark" name="${ReportRenderer._escapeXml(summary.modelId)}" time="${seconds}">`,
			`\t\t<system-out>${ReportRenderer._escapeXml(note)}</system-out>`,
			'\t</testcase>',
		];
	}

	/**
	 * Escapes the two characters that would break a markdown table cell, since a failure reason
	 * quotes whatever the endpoint sent back.
	 *
	 * @param text The text to escape.
	 * @returns The escaped text.
	 */
	private static _escapeMarkdownCell(text: string): string {
		return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	}

	/**
	 * Escapes the five characters XML reserves, for the same reason.
	 *
	 * @param text The text to escape.
	 * @returns The escaped text.
	 */
	private static _escapeXml(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
	}
}
