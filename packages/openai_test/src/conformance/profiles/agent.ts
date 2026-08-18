// local imports
import { chatBasicTest } from '../conformance_tests/chat/basic.js';
import { chatMultiTurnTest } from '../conformance_tests/chat/multi_turn.js';
import { chatSystemMessageTest } from '../conformance_tests/chat/system_message.js';
import { sdkBasicTest } from '../conformance_tests/sdk/basic.js';
import { sdkStreamingTest } from '../conformance_tests/sdk/streaming.js';
import { sdkToolsTest } from '../conformance_tests/sdk/tools.js';
import { streamingBasicTest } from '../conformance_tests/streaming/basic.js';
import { streamingContentConcatenatesTest } from '../conformance_tests/streaming/content_concatenates.js';
import { streamingDoneTest } from '../conformance_tests/streaming/done.js';
import { structuredOutputJsonObjectTest } from '../conformance_tests/structured_output/json_object.js';
import { toolsFillsInTheArgumentsTest } from '../conformance_tests/tools/fills_in_the_arguments.js';
import { toolsGeneratesACallTest } from '../conformance_tests/tools/generates_a_call.js';
import { toolsReadsAToolResultBackTest } from '../conformance_tests/tools/reads_a_tool_result_back.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	agent — what an agent framework needs, and nothing else
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `agent` profile of section 5 of issue #181: the features an agent framework such as the
 * OpenAI Agents SDK, LangChain, or the Vercel AI SDK actually leans on — chat, streaming, system
 * instructions, tools, tool results, structured JSON, multi-turn history, and the official
 * `openai` Node.js package.
 *
 * This is a selection from the other profiles, never a new test. It is deliberately narrower than
 * `full`: `models.list` and the error group matter for compatibility in general and not for
 * whether an agent loop can run, and the generation controls are a preference rather than a
 * requirement.
 */
export const agentProfile: readonly ConformanceTest[] = [
	chatBasicTest,
	chatSystemMessageTest,
	chatMultiTurnTest,
	streamingBasicTest,
	streamingContentConcatenatesTest,
	streamingDoneTest,
	toolsGeneratesACallTest,
	toolsFillsInTheArgumentsTest,
	toolsReadsAToolResultBackTest,
	structuredOutputJsonObjectTest,
	sdkBasicTest,
	sdkStreamingTest,
	sdkToolsTest,
];
