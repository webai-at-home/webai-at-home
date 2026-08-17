// local imports
import { JsonContentExtractor } from '../../readers/json_content_extractor.js';
import { JsonResponseReader } from '../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StructuredOutputJsonSchemaTest — `response_format: { type: "json_schema" }` yields an object
//	matching the schema that was sent
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that `response_format: { type: "json_schema" }` is accepted and answered with an object
 * carrying the field the schema declared as required.
 *
 * Section 17 of issue #181 asks for this to be reported separately from `json_object`, because
 * supporting the first says nothing about supporting the second.
 */
class StructuredOutputJsonSchemaTest {
	/** The schema sent, kept small so that a model of any size can satisfy it. */
	private static readonly _schema = {
		type: 'json_schema',
		json_schema: {
			name: 'greeting_object',
			strict: true,
			schema: {
				type: 'object',
				properties: {
					greeting: {
						type: 'string',
					},
				},
				required: ['greeting'],
				additionalProperties: false,
			},
		},
	};

	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages: [{ role: 'user', content: 'Reply with a greeting object whose greeting is "hello".' }],
			response_format: StructuredOutputJsonSchemaTest._schema,
		});
		if (status !== 200) {
			const errorBody = JsonResponseReader.errorBody(json);
			if (status >= 400 && status < 500) {
				const message = errorBody === undefined ? JSON.stringify(json) : String(errorBody['message']);
				return { verdict: 'SKIP', detail: `json_schema is not supported: HTTP ${status}, ${message}` };
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
		const greeting = JsonResponseReader.asRecord(parsed)?.['greeting'];
		if (typeof greeting !== 'string') {
			return { verdict: 'FAIL', detail: `the schema declared "greeting" required, and the answer has none: ${JSON.stringify(content)}` };
		}
		if (wasFenced === true) {
			return { verdict: 'WARN', detail: `the object matches the schema, but is wrapped in a markdown code fence: ${JSON.stringify(content)}` };
		}
		return { verdict: 'PASS', detail: `the answer matches the schema: ${JSON.stringify(content)}` };
	}
}

export const structuredOutputJsonSchemaTest: ConformanceTest = {
	id: 'structured_output.json_schema',
	name: 'response_format=json_schema',
	group: 'structured_output',
	run: StructuredOutputJsonSchemaTest.run,
};
