// local imports
import { SseEventReader } from '../../../readers/sse_event_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingDoneTest — the stream ends with `data: [DONE]`, and the connection then closes
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that the final event of the stream is the `data: [DONE]` sentinel. Reading the response
 * to its end without hanging is itself proof that the connection closed cleanly afterward — a
 * server that left the connection open would have this test time out instead of passing.
 */
class StreamingDoneTest {
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
		if (response.events.length === 0) {
			return { verdict: 'FAIL', detail: 'no server-sent events were received' };
		}
		const lastEvent = response.events[response.events.length - 1];
		if (lastEvent === undefined || SseEventReader.isDoneSentinel(lastEvent.rawText) === false) {
			return { verdict: 'FAIL', detail: `the last event was not "data: [DONE]": ${JSON.stringify(lastEvent?.rawText)}` };
		}
		return { verdict: 'PASS', detail: 'stream ended with "data: [DONE]", and the connection closed' };
	}
}

export const streamingDoneTest: ConformanceTest = {
	id: 'streaming.done',
	name: '[DONE]',
	group: 'streaming',
	run: StreamingDoneTest.run,
};
