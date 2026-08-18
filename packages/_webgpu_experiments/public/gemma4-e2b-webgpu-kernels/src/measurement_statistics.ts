///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MeasurementStatistics — summarises repeated runs, because no timing comes from a single run
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one generation run produced and how long each part of it took.
 */
export type GenerationRun = {
	/** Which run this is, counting from 1, with the warm-up runs already left out. */
	index: number;
	/** How long the first generated token took to arrive, in milliseconds. */
	timeToFirstTokenMs: number;
	/** How many tokens the whole answer holds. */
	tokenCount: number;
	/** How long every token after the first took to arrive, in milliseconds. */
	decodeMs: number;
	/** How many tokens arrived per second, counting every token after the first. */
	tokensPerSecond: number;
	/** The whole answer this run generated. */
	text: string;
};

/**
 * The smallest, the middle, and the largest value of one measured quantity across every run.
 */
export type MeasurementSummary = {
	/** The smallest value measured. */
	minimum: number;
	/** The middle value measured, taking the lower of the two middle values on an even count. */
	median: number;
	/** The largest value measured. */
	maximum: number;
};

export class MeasurementStatistics {
	/**
	 * Summarises one measured quantity across every run.
	 *
	 * @param values The measured values, one per run, in any order.
	 * @returns The smallest, the middle, and the largest value.
	 * @throws When there is no value to summarise, because a summary of nothing would be a made-up number.
	 */
	static summarise(values: number[]): MeasurementSummary {
		if (values.length === 0) {
			throw new Error('MeasurementStatistics.summarise needs at least one value.');
		}
		const sorted = [...values].sort((first, second) => first - second);
		const middleIndex = Math.floor((sorted.length - 1) / 2);
		return {
			minimum: sorted[0] as number,
			median: sorted[middleIndex] as number,
			maximum: sorted[sorted.length - 1] as number,
		};
	}

	/**
	 * Writes a summary as one line of text, with the middle value first and the range after it.
	 *
	 * @param summary The summary to write.
	 * @param unit The unit to write after every number, such as `ms`.
	 * @param decimals How many digits to keep after the decimal point.
	 * @returns The summary as one line, for example `12.3 ms (11.8 – 13.1)`.
	 */
	static format(summary: MeasurementSummary, unit: string, decimals: number): string {
		const median = summary.median.toFixed(decimals);
		const minimum = summary.minimum.toFixed(decimals);
		const maximum = summary.maximum.toFixed(decimals);
		return `${median} ${unit} (${minimum} – ${maximum})`;
	}

	/**
	 * Writes a byte count as a line of text a person can read.
	 *
	 * @param byteCount How many bytes.
	 * @returns The byte count in gigabytes, megabytes, kilobytes, or bytes, whichever fits.
	 */
	static formatBytes(byteCount: number): string {
		if (byteCount >= 1_000_000_000) {
			return `${(byteCount / 1_000_000_000).toFixed(2)} GB`;
		}
		if (byteCount >= 1_000_000) {
			return `${(byteCount / 1_000_000).toFixed(1)} MB`;
		}
		if (byteCount >= 1_000) {
			return `${(byteCount / 1_000).toFixed(1)} kB`;
		}
		return `${byteCount} B`;
	}
}
