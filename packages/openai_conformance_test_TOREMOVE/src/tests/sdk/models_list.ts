// local imports
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SdkModelsListTest — `client.models.list()` through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Checks that `client.models.list()` returns without throwing and lists the requested model.
 *
 * The raw test `models.list` already asked the same question of the wire format. This one asks the
 * different question section 21 of issue #181 cares about: does the official package itself get
 * through. A response can look correct when read by hand and still make the package throw.
 */
class SdkModelsListTest {
	/**
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const page = await context.openaiPackageClient.client.models.list();
		const modelIds = page.data.map((model) => model.id);
		if (modelIds.includes(context.modelId) === false) {
			return { verdict: 'FAIL', detail: `"${context.modelId}" not in ${JSON.stringify(modelIds)}` };
		}
		return { verdict: 'PASS', detail: `models.list() returned ${modelIds.length} model(s), including "${context.modelId}"` };
	}
}

export const sdkModelsListTest: ConformanceTest = {
	id: 'sdk.node.models_list',
	name: 'models.list()',
	group: 'sdk',
	run: SdkModelsListTest.run,
};
