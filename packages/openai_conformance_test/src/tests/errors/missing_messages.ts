// local imports
import { JsonResponseReader } from '../../json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ErrorsMissingMessagesTest — a request with no `messages` field is refused with an error
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that a request with no `messages` field is refused with an HTTP error status and an `error` body. */
class ErrorsMissingMessagesTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
		});
		if (status < 400) {
			return { verdict: 'FAIL', detail: `expected an error status, got HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const errorBody = JsonResponseReader.errorBody(json);
		if (errorBody === undefined) {
			return { verdict: 'FAIL', detail: `HTTP ${status} but no "error" object: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `HTTP ${status}, error.message=${JSON.stringify(errorBody['message'])}` };
	}
}

export const errorsMissingMessagesTest: ConformanceTest = {
	id: 'errors.missing_messages',
	name: 'missing messages returns an error',
	group: 'errors',
	run: ErrorsMissingMessagesTest.run,
};
