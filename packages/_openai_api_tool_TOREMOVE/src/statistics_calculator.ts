// local imports
import type { MetricStatistics } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StatisticsCalculator — the average, median, minimum, and maximum of measured values
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Computes the statistics the benchmark report states for each metric. */
export class StatisticsCalculator {
	/**
	 * Calculates the average, median, minimum, and maximum of a set of measured values.
	 *
	 * @param values Every measured value, in any order. The array is not modified.
	 * @returns The metric statistics computed from the values.
	 * @throws {Error} If no values were measured, since none of the four statistics is defined then.
	 */
	static of(values: readonly number[]): MetricStatistics {
		if (values.length === 0) {
			throw new Error('No values were measured, so no statistics can be calculated');
		}
		const sorted = [...values].sort((left, right) => left - right);
		const total = sorted.reduce((sum, value) => sum + value, 0);
		const middle = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 === 1
			? sorted[middle]
			: (sorted[middle - 1] + sorted[middle]) / 2;
		return {
			average: total / sorted.length,
			median,
			minimum: sorted[0],
			maximum: sorted[sorted.length - 1],
		};
	}
}
