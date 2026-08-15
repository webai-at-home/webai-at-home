// local imports
import { JsonResponseReader } from '../../json_response_reader.js';
import { SseEventReader } from '../../sse_event_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingFinishReasonTest — some chunk of the stream carries a finish_reason
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that at least one streamed chunk carries a `finish_reason`. */
class StreamingFinishReasonTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const response = await context.rawHttpClient.postStreamingChatCompletion({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Count from one to five.' }],
		});
		if (response.status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${response.status}` };
		}
		const finishReasons = response.events
			.filter((event) => SseEventReader.isDoneSentinel(event.rawText) === false)
			.map((event) => JsonResponseReader.finishReason(SseEventReader.parseDataJson(event.rawText)))
			.filter((finishReason): finishReason is string => finishReason !== undefined);
		if (finishReasons.length === 0) {
			return { verdict: 'FAIL', detail: 'no chunk carried a finish_reason' };
		}
		return { verdict: 'PASS', detail: `finish_reason=${finishReasons[finishReasons.length - 1]}` };
	}
}

export const streamingFinishReasonTest: ConformanceTest = {
	id: 'streaming.finish_reason',
	name: 'finish_reason',
	group: 'streaming',
	run: StreamingFinishReasonTest.run,
};
