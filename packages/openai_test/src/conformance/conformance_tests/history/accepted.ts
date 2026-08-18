// local imports
import { JsonResponseReader } from '../../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryAcceptedTest — a previous assistant message is accepted back into a later request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a request whose history already carries a previous `assistant` message is accepted.
 *
 * Protocol acceptance and nothing else, per section 9 of issue #181. Whether the model then uses
 * what the history says is the separate question `history.recalled` asks, and the two are kept
 * apart on purpose: an endpoint can accept a history perfectly and the model behind it still
 * ignore every word of it.
 */
class HistoryAcceptedTest {
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

export const historyAcceptedTest: ConformanceTest = {
	id: 'history.accepted',
	name: 'a previous assistant message is accepted',
	group: 'history',
	run: HistoryAcceptedTest.run,
};
