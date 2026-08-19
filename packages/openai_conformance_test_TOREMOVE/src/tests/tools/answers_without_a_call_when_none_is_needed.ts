// local imports
import { ToolCallVerdict } from '../../probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsAnswersWithoutACallWhenNoneIsNeededTest — the `answers_without_a_call_when_none_is_needed` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that, with a tool declared and a question that needs no tool, the model answers in words.
 * This is the negative control that proves the endpoint read the request at all, so that an endpoint
 * failing every other probe is not mistaken for one refusing the tool wire format outright.
 *
 * The probing itself belongs to `ToolCallProber` in `@webai/openai-api-tool`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsAnswersWithoutACallWhenNoneIsNeededTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('answers_without_a_call_when_none_is_needed');
		return ToolCallVerdict.fromOutcome(outcome, 'answers_without_a_call_when_none_is_needed');
	}
}

export const toolsAnswersWithoutACallWhenNoneIsNeededTest: ConformanceTest = {
	id: 'tools.answers_without_a_call_when_none_is_needed',
	name: 'answers in words when no tool is needed',
	group: 'tools',
	run: ToolsAnswersWithoutACallWhenNoneIsNeededTest.run,
};
