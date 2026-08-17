// local imports
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SdkToolsTest — a tool declaration sent through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a tool declaration written in the official package's own types is accepted, and
 * that whatever comes back — a tool call or an answer in words — the package parsed it without
 * throwing.
 *
 * This test is about the package getting through, not about the model calling the tool. Whether
 * the model asks for a tool is what the whole `tools` group already measures, six ways, so a
 * model answering in words here is `PASS`: the request was accepted and the answer parsed. Only a
 * refusal or a parse failure is a finding, and a declared-unsupported refusal is `SKIP`.
 */
class SdkToolsTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		try {
			const completion = await context.openaiPackageClient.client.chat.completions.create({
				model: context.modelId,
				messages: [{ role: 'user', content: 'What is the current weather in Paris?' }],
				tools: [
					{
						type: 'function',
						function: {
							name: 'get_current_weather',
							description: 'Reports the current weather in one city.',
							parameters: {
								type: 'object',
								properties: {
									city: {
										type: 'string',
									},
								},
								required: ['city'],
							},
						},
					},
				],
			});
			const choice = completion.choices[0];
			if (choice === undefined) {
				return { verdict: 'FAIL', detail: 'the completion carried no choices' };
			}
			const toolCalls = choice.message.tool_calls ?? [];
			if (toolCalls.length > 0) {
				return { verdict: 'PASS', detail: `the package parsed ${toolCalls.length} tool call(s), finish_reason=${String(choice.finish_reason)}` };
			}
			if (typeof choice.message.content === 'string' && choice.message.content.trim() !== '') {
				return { verdict: 'PASS', detail: 'the tool declaration was accepted and the answer parsed; the model chose to answer in words, which the tools group measures' };
			}
			return { verdict: 'FAIL', detail: `neither a tool call nor an answer came back: ${JSON.stringify(choice.message)}` };
		} catch (error) {
			return SdkToolsTest._readFailure(error);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads a thrown error from the official package, separating a declared-unsupported refusal
	 * from a real failure.
	 *
	 * @param error What the package threw.
	 * @returns `SKIP` when the endpoint refused the tool declaration with a 4xx, `FAIL` otherwise.
	 */
	private static _readFailure(error: unknown): TestResult {
		const record = JsonResponseReader.asRecord(error);
		const status = record?.['status'];
		const message = error instanceof Error ? error.message : String(error);
		if (typeof status === 'number' && status >= 400 && status < 500) {
			return { verdict: 'SKIP', detail: `the endpoint refused the tool declaration: HTTP ${status}, ${message}` };
		}
		return { verdict: 'FAIL', detail: `the package threw: ${message}` };
	}
}

export const sdkToolsTest: ConformanceTest = {
	id: 'sdk.node.tools',
	name: 'chat.completions.create({ tools })',
	group: 'sdk',
	run: SdkToolsTest.run,
};
