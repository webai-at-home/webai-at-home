// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SdkStreamingTest — `stream: true` consumed through the official `openai` Node.js package's
//	own async iterator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a streamed completion can be consumed with `for await` over the official package's
 * own stream, and that the concatenated `delta.content` is not empty.
 *
 * The raw test `streaming.basic` already read the server-sent events by hand. This one asks
 * whether the package's own parser accepts the same stream: a stream can be well-formed enough to
 * read with a regular expression and still trip the package, and the reverse.
 */
class SdkStreamingTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const stream = await context.openaiPackageClient.client.chat.completions.create({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Count from one to five.' }],
			stream: true,
		});
		let content = '';
		let chunkCount = 0;
		for await (const chunk of stream) {
			chunkCount += 1;
			content += chunk.choices[0]?.delta?.content ?? '';
		}
		if (chunkCount === 0) {
			return { verdict: 'FAIL', detail: 'the stream yielded no chunk at all' };
		}
		if (content.trim() === '') {
			return { verdict: 'FAIL', detail: `${chunkCount} chunk(s) arrived and none carried delta.content` };
		}
		return { verdict: 'PASS', detail: `${chunkCount} chunk(s), concatenated content=${JSON.stringify(content)}` };
	}
}

export const sdkStreamingTest: ConformanceTest = {
	id: 'sdk.node.streaming',
	name: 'chat.completions.create({ stream: true })',
	group: 'sdk',
	run: SdkStreamingTest.run,
};
