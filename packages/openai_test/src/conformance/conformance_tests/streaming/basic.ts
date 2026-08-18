// local imports
import { JsonResponseReader } from '../../../readers/json_response_reader.js';
import { SseEventReader } from '../../../readers/sse_event_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingBasicTest — the stream is well-formed server-sent events carrying OpenAI-shaped chunks
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that every event of a streamed completion begins with `data:`, parses as JSON, and that
 * at least one chunk carries `choices[0].delta`.
 */
class StreamingBasicTest {
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
		const contentEvents = response.events.filter((event) => SseEventReader.isDoneSentinel(event.rawText) === false);
		if (contentEvents.length === 0) {
			return { verdict: 'FAIL', detail: 'no server-sent events were received' };
		}
		for (const event of contentEvents) {
			if (SseEventReader.beginsWithData(event.rawText) === false) {
				return { verdict: 'FAIL', detail: `an event did not begin with "data:": ${JSON.stringify(event.rawText)}` };
			}
		}
		const chunks = contentEvents.map((event) => SseEventReader.parseDataJson(event.rawText));
		if (chunks.some((chunk) => chunk === undefined)) {
			return { verdict: 'FAIL', detail: 'a "data:" payload was not valid JSON' };
		}
		const hasChoiceWithDelta = chunks.some((chunk) => JsonResponseReader.firstChoice(chunk)?.['delta'] !== undefined);
		if (hasChoiceWithDelta === false) {
			return { verdict: 'FAIL', detail: 'no chunk carried choices[0].delta' };
		}
		return { verdict: 'PASS', detail: `${contentEvents.length} chunk(s), each a well-formed "data:" event carrying choices[0].delta` };
	}
}

export const streamingBasicTest: ConformanceTest = {
	id: 'streaming.basic',
	name: 'SSE response',
	group: 'streaming',
	run: StreamingBasicTest.run,
};
