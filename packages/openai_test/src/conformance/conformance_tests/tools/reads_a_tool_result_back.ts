// local imports
import { ToolCallVerdict } from '../../probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsReadsAToolResultBackTest — the `reads_a_tool_result_back` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that, given a history that already contains a tool call and that tool's result, the model
 * answers from the result. Generating a call and reading one back are two different abilities, and a
 * model can have the second without the first.
 *
 * The probing itself belongs to `ToolCallProber` in `src/probers/tool_call_prober.ts`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsReadsAToolResultBackTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('reads_a_tool_result_back');
		return ToolCallVerdict.fromOutcome(outcome, 'reads_a_tool_result_back');
	}
}

export const toolsReadsAToolResultBackTest: ConformanceTest = {
	id: 'tools.reads_a_tool_result_back',
	name: 'tool result can be submitted, and the conversation continues',
	group: 'tools',
	run: ToolsReadsAToolResultBackTest.run,
};
