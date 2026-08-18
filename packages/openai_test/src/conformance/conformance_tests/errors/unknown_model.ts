// local imports
import { JsonResponseReader } from '../../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ErrorsUnknownModelTest — an unrecognised model identifier is refused with an error, not answered
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that an unrecognised model identifier is refused with an HTTP error status and an `error` body. */
class ErrorsUnknownModelTest {
	/** A model identifier no real endpoint under test is expected to recognise. */
	private static readonly _unknownModelId = 'this-model-does-not-exist-openai-conformance-test';

	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: ErrorsUnknownModelTest._unknownModelId,
			messages: [{ role: 'user', content: 'Hello' }],
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

export const errorsUnknownModelTest: ConformanceTest = {
	id: 'errors.unknown_model',
	name: 'unknown model returns an error',
	group: 'errors',
	run: ErrorsUnknownModelTest.run,
};
