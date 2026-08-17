// local imports
import { ToolCallVerdict } from '../../probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsGeneratesACallWhenForcedTest — the `generates_a_call_when_forced` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks the same with `tool_choice: "required"`, which leaves the model no choice. This is the
 * decisive probe: a model that writes plain text here was never given the option of not calling a
 * tool, so the failure cannot be explained as the model having preferred to answer in words.
 *
 * The probing itself belongs to `ToolCallProber` in `@webai/openai-api-tool`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsGeneratesACallWhenForcedTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('generates_a_call_when_forced');
		return ToolCallVerdict.fromOutcome(outcome, 'generates_a_call_when_forced');
	}
}

export const toolsGeneratesACallWhenForcedTest: ConformanceTest = {
	id: 'tools.generates_a_call_when_forced',
	name: 'tool call returned when tool_choice is required',
	group: 'tools',
	run: ToolsGeneratesACallWhenForcedTest.run,
};
