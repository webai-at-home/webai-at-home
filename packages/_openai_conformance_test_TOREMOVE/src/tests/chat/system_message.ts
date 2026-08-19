// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatSystemMessageTest — a `system` role message ahead of a `user` message is accepted
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that a `system` role message is accepted, and a completion still comes back. */
class ChatSystemMessageTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages: [
				{ role: 'system', content: 'You are concise.' },
				{ role: 'user', content: 'Hello' },
			],
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: 'system message accepted' };
	}
}

export const chatSystemMessageTest: ConformanceTest = {
	id: 'chat.system_message',
	name: 'system message',
	group: 'chat',
	run: ChatSystemMessageTest.run,
};
