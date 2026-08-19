// local imports
import { GenerationControlVerdict } from '../../probes/generation_control_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ParametersStopTest — the `stop` control of GenerationControlProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether `stop` is honoured, rather than only accepted.
 *
 * The probing itself belongs to `GenerationControlProber` in `@webai/openai-api-tool`, which
 * compares repeated answers rather than concluding anything from the endpoint having accepted the
 * field. This file reads that one control's outcome out of the run every parameter test shares.
 */
class ParametersStopTest {
	/**
	 * @param context The endpoint, the model, and the shared generation control probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.generationControlProbeCache.outcomeFor('stop');
		return GenerationControlVerdict.fromOutcome(outcome, 'stop');
	}
}

export const parametersStopTest: ConformanceTest = {
	id: 'parameters.stop',
	name: 'stop',
	group: 'parameters',
	run: ParametersStopTest.run,
};
