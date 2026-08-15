// local imports
import { GenerationControlVerdict } from '../../generation_control_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ParametersMaxCompletionTokensTest — the `max_completion_tokens` control of GenerationControlProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether `max_completion_tokens` is honoured, rather than only accepted.
 *
 * The probing itself belongs to `GenerationControlProber` in `@webai/openai-api-tool`, which
 * compares repeated answers rather than concluding anything from the endpoint having accepted the
 * field. This file reads that one control's outcome out of the run every parameter test shares.
 */
class ParametersMaxCompletionTokensTest {
	/**
	 * @param context The endpoint, the model, and the shared generation control probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.generationControlProbeCache.outcomeFor('max_completion_tokens');
		return GenerationControlVerdict.fromOutcome(outcome, 'max_completion_tokens');
	}
}

export const parametersMaxCompletionTokensTest: ConformanceTest = {
	id: 'parameters.max_completion_tokens',
	name: 'max_completion_tokens',
	group: 'parameters',
	run: ParametersMaxCompletionTokensTest.run,
};
