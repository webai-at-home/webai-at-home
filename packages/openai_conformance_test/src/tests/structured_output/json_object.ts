// local imports
import { JsonContentExtractor } from '../../json_content_extractor.js';
import { JsonResponseReader } from '../../json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StructuredOutputJsonObjectTest — `response_format: { type: "json_object" }` yields JSON
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that `response_format: { type: "json_object" }` is accepted and answered with content
 * that is a JSON object.
 *
 * A model that wrapped its JSON in a markdown code fence reports `WARN`, not `FAIL`: the content
 * is JSON and the request was honoured, but a client calling `JSON.parse` on the content as it
 * stands would break, which is precisely what `WARN` is for. Milestone zero of issue #182 found
 * `llm_llama3_2_1b_full` doing this in nine of ten tries, and it was the one unstable verdict in
 * that gate.
 */
class StructuredOutputJsonObjectTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Reply with a JSON object holding one field, "greeting", set to "hello".' }],
			response_format: { type: 'json_object' },
		});
		if (status !== 200) {
			// A 4xx here is the endpoint declining an optional feature, which is `SKIP` rather than
			// `FAIL`, on the same rule `json_schema.ts` follows. The refusal is read from the status
			// alone and never from the error body's shape, because LM Studio answers this one with
			// `{"error": "'response_format.type' must be 'json_schema' or 'text'"}` — `error` as a
			// bare string, carrying no `code` to key on.
			if (status >= 400 && status < 500) {
				const errorBody = JsonResponseReader.errorBody(json);
				const message = errorBody === undefined ? JSON.stringify(json) : String(errorBody['message']);
				return { verdict: 'SKIP', detail: `json_object is not supported: HTTP ${status}, ${message}` };
			}
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const content = JsonResponseReader.messageContent(json);
		if (content === undefined) {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		const { parsed, wasFenced } = JsonContentExtractor.extract(content);
		if (parsed === undefined) {
			return { verdict: 'FAIL', detail: `content is not JSON: ${JSON.stringify(content)}` };
		}
		if (wasFenced === true) {
			return { verdict: 'WARN', detail: `the content is JSON, but wrapped in a markdown code fence, so JSON.parse on it as it stands would fail: ${JSON.stringify(content)}` };
		}
		return { verdict: 'PASS', detail: `content is JSON: ${JSON.stringify(content)}` };
	}
}

export const structuredOutputJsonObjectTest: ConformanceTest = {
	id: 'structured_output.json_object',
	name: 'response_format=json_object',
	group: 'structured_output',
	run: StructuredOutputJsonObjectTest.run,
};
