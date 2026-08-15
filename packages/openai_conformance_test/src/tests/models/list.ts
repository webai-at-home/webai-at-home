// local imports
import { JsonResponseReader } from '../../json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelsListTest — `GET /models` returns a list, and the requested model appears in it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Checks that `GET /models` returns `object: "list"`, an array `data`, and the requested model. */
class ModelsListTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const { status, json } = await context.rawHttpClient.listModels();
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}` };
		}
		const body = JsonResponseReader.asRecord(json);
		const data = body?.['data'];
		if (body?.['object'] !== 'list' || Array.isArray(data) === false) {
			return { verdict: 'FAIL', detail: `unexpected body shape: ${JSON.stringify(json)}` };
		}
		const modelIds = data.map((entry) => JsonResponseReader.asRecord(entry)?.['id']);
		if (modelIds.includes(context.modelId) === false) {
			return { verdict: 'FAIL', detail: `"${context.modelId}" not in ${JSON.stringify(modelIds)}` };
		}
		return { verdict: 'PASS', detail: `${modelIds.length} model(s) listed, including "${context.modelId}"` };
	}
}

export const modelsListTest: ConformanceTest = {
	id: 'models.list',
	name: 'GET /models lists the requested model',
	group: 'models',
	run: ModelsListTest.run,
};
