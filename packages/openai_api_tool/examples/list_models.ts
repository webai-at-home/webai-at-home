import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Asks this server which models the cluster offers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run example:list_models --workspace @webai/consumer-openai
//
// This is the cheapest example. It reaches this server only, so it answers even when no
// gateway is running and no volunteer browser is connected.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	// This server requires no key unless it was started with --api-key, and the openai package
	// refuses to run without one, so a placeholder is passed here.
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	// Every failure is shown rather than being quietly retried.
	maxRetries: 0,
});

try {
	const models = await client.models.list();
	for (const model of models.data) {
		console.log(`${model.id} (owned by ${model.owned_by})`);
	}
} catch (error: unknown) {
	// The likeliest failure here is that this server is not running at all, which the openai
	// package reports as a connection error rather than as an answer from the server.
	if (error instanceof APIError) {
		console.error(
			`The request was refused with HTTP ${error.status} (${String(error.code)}): ${error.message}`,
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
