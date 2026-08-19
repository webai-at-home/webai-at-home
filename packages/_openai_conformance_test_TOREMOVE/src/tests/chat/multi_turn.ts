// local imports
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatMultiTurnTest — a previous assistant message is accepted back into a later request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a request whose history already carries a previous `assistant` message is accepted.
 *
 * The primary concern is protocol acceptance, per section 9 of issue #181, not whether the model
 * actually recalls what an earlier turn said — that would grade the answer, which this package
 * never does.
 */
class ChatMultiTurnTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages: [
				{ role: 'user', content: 'Remember the number 42.' },
				{ role: 'assistant', content: 'Okay.' },
				{ role: 'user', content: 'Repeat the number I just gave you, and nothing else.' },
			],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const content = JsonResponseReader.messageContent(json);
		if (content === undefined || content.trim() === '') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `a previous assistant message was accepted, answer=${JSON.stringify(content)}` };
	}
}

export const chatMultiTurnTest: ConformanceTest = {
	id: 'chat.multi_turn',
	name: 'multi-turn conversation',
	group: 'chat',
	run: ChatMultiTurnTest.run,
};
