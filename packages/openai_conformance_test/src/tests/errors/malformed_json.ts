// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ErrorsMalformedJsonTest — a request body that is not valid JSON at all returns HTTP 400
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that a request body that is not valid JSON at all is refused with an HTTP 4xx status.
 *
 * A `500` is refused here too, as `FAIL` rather than `PASS`: a malformed request is a client
 * mistake, and an OpenAI-compatible server is expected to say so with a `4xx`, not fall over.
 */
class ErrorsMalformedJsonTest {
	/** A request body deliberately broken before the first closing brace. */
	private static readonly _malformedBody = '{ "model": "placeholder", "messages": [ this is not valid JSON';

	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postMalformedChatCompletion(ErrorsMalformedJsonTest._malformedBody);
		if (status < 400 || status >= 500) {
			return { verdict: 'FAIL', detail: `expected a 4xx status, got HTTP ${status}: ${JSON.stringify(json)}` };
		}
		return { verdict: 'PASS', detail: `HTTP ${status}` };
	}
}

export const errorsMalformedJsonTest: ConformanceTest = {
	id: 'errors.malformed_json',
	name: 'malformed JSON returns HTTP 400',
	group: 'errors',
	run: ErrorsMalformedJsonTest.run,
};
