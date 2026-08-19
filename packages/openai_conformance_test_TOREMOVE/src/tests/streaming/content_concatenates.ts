// local imports
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import { SseEventReader } from '../../readers/sse_event_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingContentConcatenatesTest — the delta chunks concatenate into a non-empty answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that concatenating every chunk's `choices[0].delta.content`, in arrival order, produces
 * a non-empty answer. The content is never graded against what it says, only that it exists.
 */
class StreamingContentConcatenatesTest {
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
		const content = response.events
			.filter((event) => SseEventReader.isDoneSentinel(event.rawText) === false)
			.map((event) => JsonResponseReader.deltaContent(SseEventReader.parseDataJson(event.rawText)))
			.filter((piece): piece is string => piece !== undefined)
			.join('');
		if (content.trim() === '') {
			return { verdict: 'FAIL', detail: 'no chunk carried delta.content, or every one was empty' };
		}
		return { verdict: 'PASS', detail: `concatenated content=${JSON.stringify(content)}` };
	}
}

export const streamingContentConcatenatesTest: ConformanceTest = {
	id: 'streaming.content_concatenates',
	name: 'incremental content chunks',
	group: 'streaming',
	run: StreamingContentConcatenatesTest.run,
};
