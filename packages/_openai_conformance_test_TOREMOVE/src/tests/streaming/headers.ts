// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingHeadersTest — a streamed request answers with Content-Type: text/event-stream
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that `stream: true` is answered with HTTP 200 and `Content-Type: text/event-stream`. */
class StreamingHeadersTest {
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
		const contentType = response.headers['content-type'];
		if (contentType === undefined || contentType.includes('text/event-stream') === false) {
			return { verdict: 'FAIL', detail: `Content-Type is ${JSON.stringify(contentType)}, expected text/event-stream` };
		}
		return { verdict: 'PASS', detail: `Content-Type: ${contentType}` };
	}
}

export const streamingHeadersTest: ConformanceTest = {
	id: 'streaming.headers',
	name: 'SSE headers',
	group: 'streaming',
	run: StreamingHeadersTest.run,
};
