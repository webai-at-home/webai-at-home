// local imports
import { JsonResponseReader } from '../../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatBasicTest — a basic completion returns a well-formed message and a finish_reason
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a basic completion returns HTTP 200, non-empty `choices[0].message.content`, and a
 * `finish_reason`.
 *
 * The content is never graded against what it says, only that it exists — this package proves
 * the protocol was followed, never whether the answer given was a good one.
 */
class ChatBasicTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const content = JsonResponseReader.messageContent(json);
		if (content === undefined || content.trim() === '') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		const finishReason = JsonResponseReader.firstChoice(json)?.['finish_reason'];
		if (typeof finishReason !== 'string') {
			return { verdict: 'FAIL', detail: `no finish_reason: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `finish_reason=${finishReason}, content=${JSON.stringify(content)}` };
	}
}

export const chatBasicTest: ConformanceTest = {
	id: 'chat.basic',
	name: 'basic completion',
	group: 'chat',
	run: ChatBasicTest.run,
};
