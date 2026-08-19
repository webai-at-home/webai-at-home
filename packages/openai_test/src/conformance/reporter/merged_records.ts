// local imports
import type { ConformanceRun, TestRunRecord } from '../runner.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MergedRecords — one model's runs, laid back out as the single list the four reporters read
//
//	A model measured with streaming both on and off produces three runs: the tests streaming has no
//	bearing on, and one per stream setting for the tests it does. That is three sets of records for
//	one model, and the report of one model is one document, so the three are merged back into one
//	list here rather than printed as the verdict matrix a sweep across several models earns.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Merges every run of one model into the single record list the four reporters read. */
export class MergedRecords {
	/**
	 * Merges one model's runs into one list, with the two records of a test measured both ways
	 * sitting next to each other rather than in two distant blocks.
	 *
	 * The stream setting is written onto a record only when both settings ran. A run given
	 * `--stream on` or `--stream off` measured every test once, so naming the setting on every row
	 * of its report would distinguish nothing, and such a report is the report as it always was,
	 * row for row.
	 *
	 * @param runs Every run of one model, in the order they were run.
	 * @returns One record per test per stream setting, ordered by the test first and the stream
	 * setting second.
	 */
	static of(runs: readonly ConformanceRun[]): readonly TestRunRecord[] {
		const settings = new Set(runs.map((run) => run.streamSetting).filter((setting) => setting !== undefined));
		const isSettingWorthNaming = settings.size > 1;

		const byTestId = new Map<string, TestRunRecord[]>();
		for (const run of runs) {
			for (const record of run.records) {
				const isNamed = run.streamSetting !== undefined && isSettingWorthNaming === true;
				const marked = isNamed === true ? {
					...record,
					streamSetting: run.streamSetting,
				} : record;
				const existing = byTestId.get(record.test.id);
				if (existing === undefined) {
					byTestId.set(record.test.id, [marked]);
					continue;
				}
				existing.push(marked);
			}
		}

		return [...byTestId.values()].flat();
	}
}
