// local imports
import { ToolCallVerdict } from '../../probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsFillsInTheArgumentsTest — the `fills_in_the_arguments` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that the tool call the model generated carries arguments that parse as JSON and hold the
 * value the question named.
 *
 * The probing itself belongs to `ToolCallProber` in `src/probers/tool_call_prober.ts`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsFillsInTheArgumentsTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('fills_in_the_arguments');
		return ToolCallVerdict.fromOutcome(outcome, 'fills_in_the_arguments');
	}
}

export const toolsFillsInTheArgumentsTest: ConformanceTest = {
	id: 'tools.fills_in_the_arguments',
	name: 'arguments are valid JSON and carry the value asked for',
	group: 'tools',
	run: ToolsFillsInTheArgumentsTest.run,
};
