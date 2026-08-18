// local imports
import type { CompletionMode } from '../completion_types.js';
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
 * One list of tests, run against one model, with the probes sent in one mode.
 *
 * A sweep produces more than one of these: one per model, and one more per extra mode for the
 * tests a mode actually reaches.
 */
export type ConformanceRun = {
	/** The model identifier every test in this run was sent to. */
	readonly modelId: string;
	/**
	 * The mode the probe caches were given, or `undefined` when this run holds only tests no mode
	 * reaches.
	 *
	 * The mode reaches the two probe caches and nothing else, so a run of the other groups is not a
	 * run "in nostream mode" or "in streamed mode" — it is a run the mode has no bearing on, and
	 * saying so is the difference between a report that measured something and one that repeated
	 * itself.
	 */
	readonly mode: CompletionMode | undefined;
	/** One record per test, in the order the tests were run. */
	readonly records: readonly TestRunRecord[];
};

/** One model a sweep left out, and why. */
export type SkippedModel = {
	/** The model identifier that was left out. */
	readonly modelId: string;
	/** Why it was left out, in the endpoint's own words where it gave any. */
	readonly reason: string;
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
	 * @returns One record per test, in the same order as `tests`.
	 */
	static async run(tests: readonly ConformanceTest[], context: TestContext): Promise<TestRunRecord[]> {
		const records: TestRunRecord[] = [];
		for (const test of tests) {
			records.push(await Runner._runOne(test, context));
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
