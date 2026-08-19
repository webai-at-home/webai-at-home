// local imports
import type { ConformanceTest } from '../../types.js';
import { toolsAnswersWithoutACallWhenNoneIsNeededTest } from './answers_without_a_call_when_none_is_needed.js';
import { toolsChoosesAmongSeveralToolsTest } from './chooses_among_several_tools.js';
import { toolsFillsInTheArgumentsTest } from './fills_in_the_arguments.js';
import { toolsGeneratesACallTest } from './generates_a_call.js';
import { toolsGeneratesACallWhenForcedTest } from './generates_a_call_when_forced.js';
import { toolsReadsAToolResultBackTest } from './reads_a_tool_result_back.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	toolsGroup — the six separate tool call abilities, rather than one question about tool calling
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every test in the `tools` folder, probed as the six separate abilities `ToolCallProber` already
 * distinguishes rather than as one question, because the de-risk gate of
 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) found a server that
 * accepted every tool declaration and never generated a single call.
 *
 * The negative control runs last, so a reader who sees every other ability fail can check on the
 * line below them whether the endpoint was reading the requests at all.
 */
export const toolsGroup: readonly ConformanceTest[] = [
	toolsGeneratesACallTest,
	toolsGeneratesACallWhenForcedTest,
	toolsFillsInTheArgumentsTest,
	toolsChoosesAmongSeveralToolsTest,
	toolsReadsAToolResultBackTest,
	toolsAnswersWithoutACallWhenNoneIsNeededTest,
];
