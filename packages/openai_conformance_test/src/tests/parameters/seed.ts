// local imports
import { GenerationControlVerdict } from '../../generation_control_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ParametersSeedTest — the `seed` control of GenerationControlProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether `seed` is honoured, rather than only accepted.
 *
 * The probing itself belongs to `GenerationControlProber` in `@webai/openai-api-tool`, which
 * compares repeated answers rather than concluding anything from the endpoint having accepted the
 * field. This file reads that one control's outcome out of the run every parameter test shares.
 */
class ParametersSeedTest {
	/**
	 * @param context The endpoint, the model, and the shared generation control probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.generationControlProbeCache.outcomeFor('seed');
		return GenerationControlVerdict.fromOutcome(outcome, 'seed');
	}
}

export const parametersSeedTest: ConformanceTest = {
	id: 'parameters.seed',
	name: 'seed',
	group: 'parameters',
	run: ParametersSeedTest.run,
};
