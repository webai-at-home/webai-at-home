// local imports
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
};

/**
 * Told when each test starts and when each test finishes, so a caller can show a run as it
 * happens rather than only once every test is over. `Runner` itself never prints.
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
	static async run(tests: readonly ConformanceTest[], context: TestContext, progressListener?: RunnerProgressListener): Promise<TestRunRecord[]> {
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
