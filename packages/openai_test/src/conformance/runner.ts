// local imports
import type { StreamSetting } from '../completion_types.js';
import type { ConformanceTest, TestContext, TestResult } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Runner — runs a list of conformance tests, in order, against one endpoint and one model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One test, run once, with how long it took. */
export type TestRunRecord = {
	/** The test that was run. */
	readonly test: ConformanceTest;
	/** The verdict it reached. */
	readonly result: TestResult;
	/** How long this one test took, in milliseconds. */
	readonly durationMs: number;
	/**
	 * Whether streaming was on or off for this record, written on by `MergedRecords` and never by
	 * the runner itself.
	 *
	 * Present only when one model was measured both ways, where the report holds two records of the
	 * same test and has to say which is which. A report of one stream setting leaves it `undefined`
	 * on every record and names no setting anywhere.
	 */
	readonly streamSetting?: StreamSetting;
};

/**
 * One list of tests, run against one model, with the probes sent in one stream setting.
 *
 * One invocation produces more than one of these when it was given more than one stream setting:
 * one for the tests no stream setting reaches, and one per stream setting for the tests a stream
 * setting actually reaches.
 */
export type ConformanceRun = {
	/** The model identifier every test in this run was sent to. */
	readonly modelId: string;
	/**
	 * The stream setting the probe caches were given, or `undefined` when this run holds only tests no stream setting
	 * reaches.
	 *
	 * The stream setting reaches the two probe caches and nothing else, so a run of the other groups is not a
	 * run "with streaming off" or "with streaming on" — it is a run streaming has no bearing on, and
	 * saying so is the difference between a report that measured something and one that repeated
	 * itself.
	 */
	readonly streamSetting: StreamSetting | undefined;
	/** One record per test, in the order the tests were run. */
	readonly records: readonly TestRunRecord[];
};

/**
 * Told when each test starts and when each test finishes, so a caller can show a run as it happens
 * rather than only once every test is over. `Runner` itself never prints.
 */
export type RunnerProgressListener = {
	/** Called just before `test` starts running. */
	readonly onTestStarted: (test: ConformanceTest) => void;
	/** Called once `record.test` has finished, whatever verdict it reached. */
	readonly onTestFinished: (record: TestRunRecord) => void;
};

/** Runs a list of conformance tests, in order, against one endpoint and one model. */
export class Runner {
	/**
	 * Runs every test in `tests`, in order, catching a thrown error — a timeout, a connection
	 * refusal — as a `FAIL` outcome instead of stopping the whole run, so one broken test never
	 * hides the result of every test after it.
	 *
	 * @param tests The tests to run, in the order to run and report them.
	 * @param context The endpoint, the model, and both clients every test runs against.
	 * @param progressListener Told when each test starts and finishes, when one is given.
	 * @returns One record per test, in the same order as `tests`.
	 */
	static async run(
		tests: readonly ConformanceTest[],
		context: TestContext,
		progressListener?: RunnerProgressListener,
	): Promise<TestRunRecord[]> {
		const records: TestRunRecord[] = [];
		for (const test of tests) {
			if (progressListener !== undefined) {
				progressListener.onTestStarted(test);
			}
			const record = await Runner._runOne(test, context);
			if (progressListener !== undefined) {
				progressListener.onTestFinished(record);
			}
			records.push(record);
		}
		return records;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one test once, timing it and converting a thrown error into a `FAIL` result.
	 *
	 * @param test The test to run.
	 * @param context The endpoint, the model, and both clients to run it with.
	 * @returns The record this run produced.
	 */
	private static async _runOne(test: ConformanceTest, context: TestContext): Promise<TestRunRecord> {
		const startedAt = Date.now();
		try {
			const result = await test.run(context);
			return { test, result, durationMs: Date.now() - startedAt };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { test, result: { verdict: 'FAIL', detail: `threw: ${message}` }, durationMs: Date.now() - startedAt };
		}
	}
}
