// local imports
import type { ConformanceRun, SkippedModel, TestRunRecord } from '../runner.js';
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

	/**
	 * Renders a sweep across several models as JSON, one entry per run.
	 *
	 * The single-model document is not nested inside this one: a reader of either has to know which
	 * they are looking at anyway, and a sweep carries two things a single run has no place for — the
	 * stream setting each run's probes were sent in, and the models the sweep never measured.
	 *
	 * @param runs Every run of the sweep, in the order they were run.
	 * @param endpoint The endpoint's base URL.
	 * @param skippedModels The models the sweep left out, and why.
	 * @returns The JSON document, indented, ready to print or redirect to a file.
	 */
	static renderRuns(runs: readonly ConformanceRun[], endpoint: string, skippedModels: readonly SkippedModel[]): string {
		return JSON.stringify(
			{
				endpoint,
				runs: runs.map((run) => {
					const summary = ReportSummary.of(run.records);
					return {
						model: run.modelId,
						streamSetting: run.streamSetting ?? null,
						summary: {
							passed: summary.passedCount,
							failed: summary.failedCount,
							skipped: summary.skippedCount,
							warned: summary.warnedCount,
							compatibilityPercent: Number(summary.compatibilityPercent.toFixed(1)),
						},
						tests: JsonReporter._testEntries(run.records),
					};
				}),
				skippedModels: skippedModels.map((skipped) => ({
					model: skipped.modelId,
					reason: skipped.reason,
				})),
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
