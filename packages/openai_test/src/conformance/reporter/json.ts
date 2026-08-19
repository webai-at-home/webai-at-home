// local imports
import type { TestRunRecord } from '../runner.js';
import { ReportSummary } from './report_summary.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonReporter — the machine-readable report of section 27 of issue #181
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `JsonReporter.render` needs beyond the run records themselves. */
export type JsonReportOptions = {
	/** The endpoint's base URL. */
	readonly endpoint: string;
	/** The model identifier requested. */
	readonly modelId: string;
};

/** Renders a run as the JSON document section 27 of issue #181 shows. */
export class JsonReporter {
	/**
	 * Renders a run as JSON, with one entry per test carrying its identifier, verdict, duration,
	 * and — for anything other than a pass — the detail explaining it.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @param options The endpoint and the model to name in the document.
	 * @returns The JSON document, indented, ready to print or redirect to a file.
	 */
	static render(records: readonly TestRunRecord[], options: JsonReportOptions): string {
		const summary = ReportSummary.of(records);
		return JSON.stringify(
			{
				endpoint: options.endpoint,
				model: options.modelId,
				summary: {
					passed: summary.passedCount,
					failed: summary.failedCount,
					skipped: summary.skippedCount,
					warned: summary.warnedCount,
					compatibilityPercent: Number(summary.compatibilityPercent.toFixed(1)),
				},
				tests: JsonReporter._testEntries(records),
			},
			undefined,
			2,
		);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Turns one run's records into the test entries both documents carry, so the two can never
	 * disagree about how one test is written.
	 *
	 * @param records Every test's outcome, in the order the tests were run.
	 * @returns The entries, in the same order.
	 */
	private static _testEntries(records: readonly TestRunRecord[]): readonly Record<string, unknown>[] {
		return records.map((record) => ({
			id: record.test.id,
			group: record.test.group,
			...(record.streamSetting === undefined ? {} : { stream: record.streamSetting }),
			status: record.result.verdict.toLowerCase(),
			durationMs: record.durationMs,
			...(record.result.verdict === 'PASS' ? {} : { detail: record.result.detail }),
		}));
	}
}
