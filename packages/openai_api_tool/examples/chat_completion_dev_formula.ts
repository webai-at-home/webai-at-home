import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Runs the development formula task through the OpenAI completion interface
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run example:chat_completion_dev_formula --workspace @webai/consumer-openai
//
// This is the example to run first. The model `dev_formula` is the cluster's development
// formula task: it multiplies the submitted number by two in one stage and adds seven in the
// next, so the number 5 comes back as 17. It downloads no model and needs no graphics
// processor, so it proves the whole path — this server, the central gateway, stage scheduling
// across two worker browser tabs, and the answer — with nothing else in the way.
//
// It needs the gateway running and at least one worker browser tab open, for example the page
// http://localhost:8787/debug_iframe_dev_formula, which opens the two tabs the task uses.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 120_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'dev_formula',
		// A request carrying one message sends that message's content unchanged, which is what
		// lets this model receive a number. Several messages would be labelled with their roles
		// and joined, and the resulting text would not be a number.
		messages: [
			{
				role: 'user',
				content: '5',
			},
		],
	});
	console.log(`answer: ${completion.choices[0]?.message.content}`);
	console.log(JSON.stringify(completion, null, 2));
} catch (error: unknown) {
	// A refusal is reported in words rather than as a stack trace, because in a cluster of
	// volunteer browsers the everyday reason a request fails is that no browser tab is
	// currently offering the work, which is an answer and not a fault in this example.
	if (error instanceof APIError) {
		console.error(
			`The request was refused with HTTP ${error.status} (${String(error.code)}): ${error.message}`,
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
