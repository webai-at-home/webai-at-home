// local imports
import { ToolCallVerdict } from '../../tool_call_verdict.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolsGeneratesACallTest — the `generates_a_call` ability of ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that, asked a question a declared tool answers, the model asks for that tool rather than
 * answering in words.
 *
 * The probing itself belongs to `ToolCallProber` in `@webai/openai-api-tool`; this file only reads
 * that one ability's outcome out of the run every tool call test shares, and translates it.
 */
class ToolsGeneratesACallTest {
	/**
	 * @param context The endpoint, the model, and the shared tool call probe run.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const outcome = await context.toolCallProbeCache.outcomeFor('generates_a_call');
		return ToolCallVerdict.fromOutcome(outcome, 'generates_a_call');
	}
}

export const toolsGeneratesACallTest: ConformanceTest = {
	id: 'tools.generates_a_call',
	name: 'tool call returned',
	group: 'tools',
	run: ToolsGeneratesACallTest.run,
};
