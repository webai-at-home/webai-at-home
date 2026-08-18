// local imports
import type { TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportSummary — the counts and the percentage every reporter shows, computed in one place
//
//	Four reporters showing four different compatibility percentages for one run would be worse
//	than showing none, so the arithmetic lives here and each reporter only formats it.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one run produced, counted. */
export type RunSummary = {
	/** How many tests passed. */
	readonly passedCount: number;
	/** How many tests failed. */
	readonly failedCount: number;
	/** How many tests were skipped. */
	readonly skippedCount: number;
	/** How many tests warned. */
	readonly warnedCount: number;
	/** The percentage of scored tests that passed, `SKIP` excluded from the denominator. */
	readonly compatibilityPercent: number;
};

/** Counts one run's outcomes, and computes the one compatibility percentage every reporter shows. */
export class ReportSummary {
	/**
	 * Counts a run's outcomes.
	 *
	 * `SKIP` is left out of the percentage's denominator, because a feature the endpoint has
	 * declared it does not support was never a candidate for compatibility. `WARN` stays in the
	 * denominator alongside `FAIL`, so the percentage never rises on a result this package could
	 * not fully confirm.
	 *
	 * @param records Every test's outcome.
	 * @returns The counts and the percentage.
	 */
	static of(records: readonly TestRunRecord[]): RunSummary {
		const countOf = (verdict: Verdict): number => records.filter((record) => record.result.verdict === verdict).length;
		const passedCount = countOf('PASS');
		const skippedCount = countOf('SKIP');
		const scoredCount = records.length - skippedCount;
		return {
			passedCount,
			failedCount: countOf('FAIL'),
			skippedCount,
			warnedCount: countOf('WARN'),
			compatibilityPercent: scoredCount === 0 ? 100 : (passedCount / scoredCount) * 100,
		};
	}
}
