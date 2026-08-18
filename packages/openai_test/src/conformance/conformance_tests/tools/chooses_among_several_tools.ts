// local imports
import { ToolCallVerdict } from '../../probes/tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsChoosesAmongSeveralToolsTest — the `chooses_among_several_tools` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that, with more than one tool declared, the model asks for the one that answers the
 * question rather than one of the others.
 *
 * The probing itself belongs to `ToolCallProber` in `src/probers/tool_call_prober.ts`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsChoosesAmongSeveralToolsTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('chooses_among_several_tools');
		return ToolCallVerdict.fromOutcome(outcome, 'chooses_among_several_tools');
	}
}

export const toolsChoosesAmongSeveralToolsTest: ConformanceTest = {
	id: 'tools.chooses_among_several_tools',
	name: 'chooses the right tool among several',
	group: 'tools',
	run: ToolsChoosesAmongSeveralToolsTest.run,
};
