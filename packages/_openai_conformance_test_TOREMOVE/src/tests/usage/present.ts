// local imports
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	UsagePresentTest — a completion's response body carries a `usage` object
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that a completion's response body carries a `usage` object at all. */
class UsagePresentTest {
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
		const usage = JsonResponseReader.usage(json);
		if (usage === undefined) {
			return { verdict: 'FAIL', detail: `no usage object: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `usage present: ${JSON.stringify(usage)}` };
	}
}

export const usagePresentTest: ConformanceTest = {
	id: 'usage.present',
	name: 'prompt_tokens, completion_tokens',
	group: 'usage',
	run: UsagePresentTest.run,
};
