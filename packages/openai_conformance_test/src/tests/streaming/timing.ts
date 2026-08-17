// local imports
import { SseEventReader } from '../../readers/sse_event_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StreamingTimingTest — detects an endpoint that generates the whole answer first, and only
//	then splits it into chunks, per section 12 of issue #181
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reports the spread between the first and the last chunk's arrival, and warns when every chunk
 * arrived within {@link StreamingTimingTest.bufferedThresholdMs} of the first — a strong sign the
 * whole answer was generated before any of it was sent, rather than streamed as it was produced.
 *
 * This is a `WARN`, never a `FAIL`: the server answered correctly, and buffering is a
 * compatibility concern, not a protocol violation, per section 12 of issue #181.
 */
class StreamingTimingTest {
	/** Below this spread between the first and the last chunk, the response looks buffered rather than streamed. */
	static readonly bufferedThresholdMs = 5;

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
		if (contentEvents.length < 2) {
			return { verdict: 'WARN', detail: `only ${contentEvents.length} chunk(s) arrived; too few to judge whether the answer was streamed as it was generated` };
		}
		const firstArrivedAtMs = contentEvents[0]?.arrivedAtMs ?? 0;
		const lastArrivedAtMs = contentEvents[contentEvents.length - 1]?.arrivedAtMs ?? 0;
		const spreadMs = lastArrivedAtMs - firstArrivedAtMs;
		if (spreadMs <= StreamingTimingTest.bufferedThresholdMs) {
			return {
				verdict: 'WARN',
				detail: `all ${contentEvents.length} chunks arrived within ${spreadMs} ms of the first. The server may be buffering the complete response instead of streaming generation.`,
			};
		}
		return { verdict: 'PASS', detail: `time to first chunk ${firstArrivedAtMs} ms, ${contentEvents.length} chunks spread over ${spreadMs} ms` };
	}
}

export const streamingTimingTest: ConformanceTest = {
	id: 'streaming.timing',
	name: 'streaming timing',
	group: 'streaming',
	run: StreamingTimingTest.run,
};
