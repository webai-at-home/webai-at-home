// npm imports
import Chalk from 'chalk';

// local imports
import type {
	BenchmarkFailure,
	BenchmarkReport,
	BenchmarkSample,
	BenchmarkSummary,
	MetricStatistics,
	ReportFormat,
	ReportParameter,
} from '../completion_types.js';
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

/**
 * What the markdown format shows beyond the measurements themselves, so that a report file
 * committed beside the code says when it was measured and what it was measured with.
 *
 * Only the markdown format reads these. The `text` format is printed to a terminal by somebody who
 * has the command line in front of them already, `json` carries the settings as fields of its own,
 * and `junit` is read by a program that has no use for a command line.
 */
export type BenchmarkMarkdownOptions = {
	/**
	 * When this run was generated, so that a report file found later says how old its measurements
	 * are. Left out by a caller with no clock to offer, in which case the moment of rendering is
	 * stamped instead.
	 */
	readonly generatedAt?: Date;
	/**
	 * Every command line parameter this run was given, including the ones commander filled in from
	 * a default.
	 *
	 * The bearer token is never among them in readable form: whoever builds this list replaces that
	 * value first, because a report file is written to be published.
	 */
	readonly parameters?: readonly ReportParameter[];
	/** The command line that produced this run, carrying the same redaction the parameter list does. */
	readonly commandLine?: string;
};

/** Renders a benchmark report in the format `-f/--format` named. */
export class ReportRenderer {
	/**
	 * Writes a benchmark report out in the requested format.
	 *
	 * @param report The full benchmark report to write.
	 * @param format Which format to write.
	 * @param markdownOptions What the markdown format shows beyond the measurements, ignored by
	 * every other format. Left out by a caller that has none of it.
	 * @returns The whole report as one string, ready to print or to write to a file.
	 */
	static formatBenchmarkReport(report: BenchmarkReport, format: ReportFormat, markdownOptions: BenchmarkMarkdownOptions = {}): string {
		if (format === 'json') {
			return JSON.stringify(report, undefined, 2);
		}
		if (format === 'markdown') {
			return ReportRenderer._renderMarkdownReport(report, markdownOptions);
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
	 * Renders the benchmark report as markdown, so it can be pasted straight into an issue, a pull
	 * request, or a notes file, or committed beside the code and still read as a report months
	 * later.
	 *
	 * It is laid out the way the `conformance` report is laid out, for the same reason: the numbers
	 * first, then what produced them, then what each number means, then one section per model. A
	 * report that is one table of one row says what was measured but not what any of it means, and
	 * a reader who did not run it cannot tell a good number from a bad one.
	 *
	 * @param report The full benchmark report to render.
	 * @param options When it was generated, and the parameters and command line that produced it.
	 * @returns The whole report as one markdown document.
	 */
	private static _renderMarkdownReport(report: BenchmarkReport, options: BenchmarkMarkdownOptions): string {
		const lines: string[] = ['# OpenAI API Benchmark Report', ''];
		lines.push(...ReportRenderer._markdownSummarySection(report));
		lines.push(...ReportRenderer._markdownMeasurementRunSection(report, options));
		lines.push(...ReportRenderer._markdownWhatWasMeasuredSection(report));
		for (const summary of report.summaries) {
			lines.push(...ReportRenderer._markdownModelSection(summary));
		}
		if (report.summaries.length > 1) {
			lines.push(...ReportRenderer._markdownSideBySideSection(report.summaries));
		}
		lines.push(...ReportRenderer._markdownNotMeasuredSection(report.failures ?? []));
		return lines.join('\n').trimEnd();
	}

	/**
	 * Builds the section a reader sees first: how many models were measured, and which of them
	 * answered quickest, finished quickest, and generated fastest.
	 *
	 * The three headline lines name a model even when only one was measured, so that the same three
	 * lines answer the same three questions whether the run measured one model or ten.
	 *
	 * @param report The full benchmark report.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _markdownSummarySection(report: BenchmarkReport): string[] {
		const quickestToFirstCharacter = ReportRenderer._lowestAverage(report.summaries, (summary) => summary.timeToFirstCharacterMs.average);
		const quickestToLastCharacter = ReportRenderer._lowestAverage(report.summaries, (summary) => summary.timeToLastCharacterMs.average);
		const fastestOutput = ReportRenderer._highestAverage(report.summaries, (summary) => summary.outputCharactersPerSecond.average);
		return [
			'## Summary',
			'',
			`- Models measured: ${report.summaries.length}`,
			`- Models not measured: ${(report.failures ?? []).length}`,
			`- Quickest to first character: \`${quickestToFirstCharacter.modelId}\` at ${ReportRenderer._rounded(quickestToFirstCharacter.timeToFirstCharacterMs.average)} ms average`,
			`- Quickest to last character: \`${quickestToLastCharacter.modelId}\` at ${ReportRenderer._rounded(quickestToLastCharacter.timeToLastCharacterMs.average)} ms average`,
			`- Fastest output: \`${fastestOutput.modelId}\` at ${ReportRenderer._rounded(fastestOutput.outputCharactersPerSecond.average)} characters/second average`,
			'',
		];
	}

	/**
	 * Builds the section saying when this run happened, what it was pointed at, and which command
	 * line parameters it was given.
	 *
	 * @param report The full benchmark report, read for the endpoint and the models it measured.
	 * @param options The generation date, the parameters, and the command line, when the caller
	 * offered them.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _markdownMeasurementRunSection(report: BenchmarkReport, options: BenchmarkMarkdownOptions): string[] {
		const generatedAt = options.generatedAt ?? new Date();
		const modelIds = report.summaries.map((summary) => `\`${summary.modelId}\``).join(', ');
		const lines: string[] = ['## Measurement Run', ''];
		lines.push(`- Generated: ${generatedAt.toISOString()}`);
		lines.push(`- Endpoint: \`${report.summaries[0]?.baseUrl ?? ''}\``);
		lines.push(report.summaries.length === 1 ? `- Model: ${modelIds}` : `- Models: ${modelIds}`);
		lines.push('');

		if (options.commandLine !== undefined) {
			lines.push('### Command Line', '', '```bash', options.commandLine, '```', '');
		}

		if (options.parameters !== undefined && options.parameters.length > 0) {
			lines.push('### Parameters', '', '| Option | Value |', '| --- | --- |');
			for (const parameter of options.parameters) {
				lines.push(`| \`${parameter.name}\` | ${ReportRenderer._escapeMarkdownCell(parameter.value)} |`);
			}
			lines.push('');
		}

		return lines;
	}

	/**
	 * Builds the section that says in words what the five measured figures are, and what was done
	 * to make two runs of it comparable.
	 *
	 * @param report The full benchmark report, read for the settings it names.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _markdownWhatWasMeasuredSection(report: BenchmarkReport): string[] {
		const sentTimes = report.settings.runs === 1 ? 'once' : `${report.settings.runs} times`;
		const warmupSentence = ReportRenderer._warmupSentence(report.settings.warmupRuns);
		return [
			'## What Was Measured',
			'',
			`Each model was sent the same prompt ${sentTimes}, and every request asked for its answer in pieces, so that Time to First Character and Time to Last Character are two separate numbers rather than one. No two requests were ever in flight at once, which is why parallelism is ${report.settings.parallelism} in every report this program writes: a second request in flight changes what the first one measures. ${warmupSentence}`,
			'',
			'| Metric | What it means |',
			'| --- | --- |',
			'| Time to First Character | How long from sending the request until the first character of the answer arrived. This is how long somebody waits in front of a blank screen. |',
			'| Time to Last Character | How long from sending the request until the last character arrived. This is how long the whole answer took. |',
			'| Output Characters per Second | The answer divided by the time between its first character and its last. This is how fast the text arrived once it had started arriving. |',
			'| Input Characters | How long the prompt was. The same for every request of one run, since one prompt is sent every time. |',
			'| Output Characters | How long the answer was. It changes from request to request, because a model is free to answer the same prompt differently each time. |',
			'',
			'None of the five is a token count. A character is what both ends can count without agreeing on a tokenizer first, which is what makes two different endpoints comparable here.',
			'',
		];
	}

	/**
	 * Says what the warm-up requests of this run were, in words rather than as a count a reader has
	 * to work out the meaning of.
	 *
	 * @param warmupRuns How many unreported warm-up requests each model was sent.
	 * @returns The one sentence naming them.
	 */
	private static _warmupSentence(warmupRuns: number): string {
		if (warmupRuns === 0) {
			return 'No warm-up request was sent at all, so the first measured request may be the one that loaded the model.';
		}
		if (warmupRuns === 1) {
			return 'One warm-up request was sent first and its answer thrown away, so that the first measured request is not the one that loaded the model.';
		}
		return `${warmupRuns} warm-up requests were sent first and their answers thrown away, so that the first measured request is not the one that loaded the model.`;
	}

	/**
	 * Builds one measured model's own section: the four statistics of each metric, then the
	 * individual requests those statistics were computed from.
	 *
	 * The individual requests are listed rather than summarized away because the spread between
	 * them is the thing a reader most needs in order to know how much to trust the average: two
	 * requests of the same model against the same endpoint can differ by half again.
	 *
	 * @param summary The aggregate measurements of one model.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _markdownModelSection(summary: BenchmarkSummary): string[] {
		return [
			`## \`${summary.modelId}\``,
			'',
			'| Metric | Average | Median | Minimum | Maximum |',
			'| --- | ---: | ---: | ---: | ---: |',
			ReportRenderer._markdownStatisticsRow('Time to First Character', summary.timeToFirstCharacterMs, 'ms'),
			ReportRenderer._markdownStatisticsRow('Time to Last Character', summary.timeToLastCharacterMs, 'ms'),
			ReportRenderer._markdownStatisticsRow('Output Characters per Second', summary.outputCharactersPerSecond, 'chars/s'),
			ReportRenderer._markdownStatisticsRow('Output Characters', summary.outputCharacters, 'chars'),
			'',
			`Input Characters: ${summary.inputCharacters}, the same for every request below.`,
			'',
			'### Every Measured Request',
			'',
			'| Request | Time to First Character | Time to Last Character | Output Characters per Second | Output Characters |',
			'| ---: | ---: | ---: | ---: | ---: |',
			...summary.samples.map((sample) => ReportRenderer._markdownSampleRow(sample)),
			'',
		];
	}

	/**
	 * Builds one metric's row of a model's statistics table.
	 *
	 * @param metricName The metric's name, spelled the way the rest of the report spells it.
	 * @param statistics The four statistics of that metric.
	 * @param unit The unit written after each of the four numbers.
	 * @returns The row.
	 */
	private static _markdownStatisticsRow(metricName: string, statistics: MetricStatistics, unit: string): string {
		const cells = [statistics.average, statistics.median, statistics.minimum, statistics.maximum]
			.map((value) => `${ReportRenderer._rounded(value)} ${unit}`);
		return `| ${metricName} | ${cells.join(' | ')} |`;
	}

	/**
	 * Builds one measured request's row of a model's request table.
	 *
	 * @param sample The one measured request.
	 * @returns The row.
	 */
	private static _markdownSampleRow(sample: BenchmarkSample): string {
		return [
			`| ${sample.run}`,
			`| ${ReportRenderer._rounded(sample.timeToFirstCharacterMs)} ms`,
			`| ${ReportRenderer._rounded(sample.timeToLastCharacterMs)} ms`,
			`| ${ReportRenderer._rounded(sample.outputCharactersPerSecond)} chars/s`,
			`| ${sample.outputCharacters} chars |`,
		].join(' ');
	}

	/**
	 * Builds the one table that puts every measured model on a row of its own, which is what makes
	 * a sweep across several models worth reading.
	 *
	 * Written only when more than one model was measured. One model on one row of one table says
	 * nothing its own section above has not already said in full.
	 *
	 * @param summaries The aggregate measurements, one per measured model.
	 * @returns The lines of the section, ending with one blank line.
	 */
	private static _markdownSideBySideSection(summaries: readonly BenchmarkSummary[]): string[] {
		const rows = summaries.map((summary) => [
			`| \`${summary.modelId}\``,
			`| ${ReportRenderer._rounded(summary.timeToFirstCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.timeToLastCharacterMs.average)} ms`,
			`| ${ReportRenderer._rounded(summary.outputCharactersPerSecond.average)} chars/s`,
			`| ${summary.inputCharacters} chars`,
			`| ${ReportRenderer._rounded(summary.outputCharacters.average)} chars |`,
		].join(' '));
		return [
			'## Every Model Side By Side',
			'',
			'Every figure below is the average across the measured requests of that model.',
			'',
			'| Model | Time to First Character | Time to Last Character | Output Characters per Second | Input Characters | Output Characters |',
			'| --- | ---: | ---: | ---: | ---: | ---: |',
			...rows,
			'',
		];
	}

	/**
	 * Builds the section naming the models that could not be measured at all.
	 *
	 * @param failures The models that could not be measured, and why.
	 * @returns The lines of the section, or no lines when every model named was measured.
	 */
	private static _markdownNotMeasuredSection(failures: readonly BenchmarkFailure[]): string[] {
		if (failures.length === 0) {
			return [];
		}
		return [
			'## Models Not Measured',
			'',
			'| Model | Why |',
			'| --- | --- |',
			...failures.map((failure) => `| \`${failure.modelId}\` | ${ReportRenderer._escapeMarkdownCell(failure.reason)} |`),
			'',
		];
	}

	/**
	 * Finds the model with the smallest value of one metric.
	 *
	 * @param summaries The aggregate measurements, one per measured model. Never empty, since a run
	 * that measured no model at all throws before a report is rendered.
	 * @param valueOf Reads the metric to compare from one summary.
	 * @returns The summary carrying the smallest value.
	 */
	private static _lowestAverage(summaries: readonly BenchmarkSummary[], valueOf: (summary: BenchmarkSummary) => number): BenchmarkSummary {
		return summaries.reduce((best, candidate) => valueOf(candidate) < valueOf(best) ? candidate : best);
	}

	/**
	 * Finds the model with the largest value of one metric.
	 *
	 * @param summaries The aggregate measurements, one per measured model. Never empty, for the same
	 * reason.
	 * @param valueOf Reads the metric to compare from one summary.
	 * @returns The summary carrying the largest value.
	 */
	private static _highestAverage(summaries: readonly BenchmarkSummary[], valueOf: (summary: BenchmarkSummary) => number): BenchmarkSummary {
		return summaries.reduce((best, candidate) => valueOf(candidate) > valueOf(best) ? candidate : best);
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
