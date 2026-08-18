// local imports
import type { ConformanceRun, TestRunRecord } from '../runner.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JunitReporter — the JUnit XML of section 33 of issue #181, for a continuous integration run
//	that already knows how to read it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `JunitReporter.render` needs beyond the run records themselves. */
export type JunitReportOptions = {
	/** The endpoint's base URL, carried as a property of the test suite. */
	readonly endpoint: string;
	/** The model identifier requested, carried as a property of the test suite. */
	readonly modelId: string;
};

/** Renders a run as JUnit XML. */
export class JunitReporter {
	/**
	 * Renders a run as a single JUnit test suite, one test case per conformance test.
	 *
	 * `WARN` is written as a passing test case carrying a `system-out` note rather than as a
	 * failure, because a continuous integration run must not go red on a result this package
	 * deliberately does not call a failure. `SKIP` becomes `<skipped>`, which JUnit already has.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to record on the suite.
	 * @returns The XML document, ready to print or redirect to a file.
	 */
	static render(records: readonly TestRunRecord[], options: JunitReportOptions): string {
		return ['<?xml version="1.0" encoding="UTF-8"?>', ...JunitReporter._testSuiteLines(records, options, '')].join('\n');
	}

	/**
	 * Renders a sweep across several models as one `<testsuites>` element holding one `<testsuite>`
	 * per run, which is the shape JUnit already has for exactly this.
	 *
	 * A suite is named `openai_test.<model>` and, where the mode reached its tests, `.<mode>` after
	 * that, so a continuous integration run that shows one suite per line names the model rather
	 * than showing the same name several times over.
	 *
	 * @param runs Every run of the sweep, in the order they were run.
	 * @param endpoint The endpoint's base URL, recorded on every suite.
	 * @returns The XML document, ready to print or redirect to a file.
	 */
	static renderRuns(runs: readonly ConformanceRun[], endpoint: string): string {
		const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
		for (const run of runs) {
			const suiteLines = JunitReporter._testSuiteLines(
				run.records,
				{
					endpoint,
					modelId: run.modelId,
				},
				run.mode === undefined ? `.${run.modelId}` : `.${run.modelId}.${run.mode}`,
			);
			lines.push(...suiteLines.map((line) => `\t${line}`));
		}
		lines.push('</testsuites>');
		return lines.join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the lines of one `<testsuite>` element, without the XML declaration in front of it.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to record on the suite.
	 * @param nameSuffix What to add after `openai_test` in the suite's name, empty for a single run.
	 * @returns The lines, in order.
	 */
	private static _testSuiteLines(records: readonly TestRunRecord[], options: JunitReportOptions, nameSuffix: string): string[] {
		const failureCount = records.filter((record) => record.result.verdict === 'FAIL').length;
		const skippedCount = records.filter((record) => record.result.verdict === 'SKIP').length;
		const totalDurationSeconds = (records.reduce((total, record) => total + record.durationMs, 0) / 1000).toFixed(3);

		const suiteName = JunitReporter._escape(`openai_test${nameSuffix}`);
		const lines: string[] = [
			`<testsuite name="${suiteName}" tests="${records.length}" failures="${failureCount}" skipped="${skippedCount}" time="${totalDurationSeconds}">`,
			'\t<properties>',
			`\t\t<property name="endpoint" value="${JunitReporter._escape(options.endpoint)}"/>`,
			`\t\t<property name="model" value="${JunitReporter._escape(options.modelId)}"/>`,
			'\t</properties>',
		];
		for (const record of records) {
			lines.push(...JunitReporter._testCaseLines(record));
		}
		lines.push('</testsuite>');
		return lines;
	}

	/**
	 * Builds the lines of one `<testcase>` element.
	 *
	 * @param record The test and the outcome it reached.
	 * @returns The lines, in order.
	 */
	private static _testCaseLines(record: TestRunRecord): string[] {
		const durationSeconds = (record.durationMs / 1000).toFixed(3);
		const openingTag = `\t<testcase classname="${JunitReporter._escape(record.test.group)}" name="${JunitReporter._escape(record.test.id)}" time="${durationSeconds}">`;
		const detail = JunitReporter._escape(record.result.detail);
		switch (record.result.verdict) {
			case 'PASS':
				return [`${openingTag.slice(0, -1)}/>`];
			case 'FAIL':
				return [openingTag, `\t\t<failure message="${detail}"/>`, '\t</testcase>'];
			case 'SKIP':
				return [openingTag, `\t\t<skipped message="${detail}"/>`, '\t</testcase>'];
			case 'WARN':
				return [openingTag, `\t\t<system-out>WARN: ${detail}</system-out>`, '\t</testcase>'];
		}
	}

	/**
	 * Escapes the five characters XML reserves, so a detail carrying a quotation mark or an angle
	 * bracket cannot break the document.
	 *
	 * @param text The text to escape.
	 * @returns The escaped text.
	 */
	private static _escape(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
	}
}
