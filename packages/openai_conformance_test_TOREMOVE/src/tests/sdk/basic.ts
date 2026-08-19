// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SdkBasicTest — `client.chat.completions.create()` through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a non-streamed `chat.completions.create` returns a completion the official package
 * parsed into its own types without throwing, carrying a message and a `finish_reason`.
 */
class SdkBasicTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const completion = await context.openaiPackageClient.client.chat.completions.create({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
		});
		const choice = completion.choices[0];
		if (choice === undefined) {
			return { verdict: 'FAIL', detail: 'the completion carried no choices' };
		}
		if (typeof choice.message.content !== 'string' || choice.message.content.trim() === '') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(choice.message)}` };
		}
		if (typeof choice.finish_reason !== 'string') {
			return { verdict: 'FAIL', detail: `no finish_reason: ${JSON.stringify(choice)}` };
		}
		return { verdict: 'PASS', detail: `finish_reason=${choice.finish_reason}, content=${JSON.stringify(choice.message.content)}` };
	}
}

export const sdkBasicTest: ConformanceTest = {
	id: 'sdk.node.basic',
	name: 'chat.completions.create()',
	group: 'sdk',
	run: SdkBasicTest.run,
};
