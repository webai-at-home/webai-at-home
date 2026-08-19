// local imports
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	UsageTotalIsSumTest — `usage.total_tokens` equals `usage.prompt_tokens + usage.completion_tokens`
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that `usage.total_tokens` equals `usage.prompt_tokens + usage.completion_tokens`. */
class UsageTotalIsSumTest {
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
		const promptTokens = usage?.['prompt_tokens'];
		const completionTokens = usage?.['completion_tokens'];
		const totalTokens = usage?.['total_tokens'];
		if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number') {
			return { verdict: 'FAIL', detail: `usage missing or not numeric: ${JSON.stringify(usage)}` };
		}
		if (totalTokens !== promptTokens + completionTokens) {
			return { verdict: 'FAIL', detail: `${totalTokens} !== ${promptTokens} + ${completionTokens}` };
		}
		return { verdict: 'PASS', detail: `${promptTokens} + ${completionTokens} = ${totalTokens}` };
	}
}

export const usageTotalIsSumTest: ConformanceTest = {
	id: 'usage.total_is_sum',
	name: 'total_tokens is prompt_tokens + completion_tokens',
	group: 'usage',
	run: UsageTotalIsSumTest.run,
};
