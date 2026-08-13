import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sends a history of several messages, and shows how they become one prompt
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with: npm run example:chat_completion_system_message --workspace @webai/consumer-openai
//
// A task in the cluster carries one piece of text, so a history of several messages has to
// become one piece of text before it can be submitted. The rule is:
//
// - one message: its content is sent unchanged;
// - several messages: they are labelled with their roles, one message per line, followed by a
//   final `assistant:` line that invites the answer.
//
// The three messages below therefore reach the worker browser tab as:
//
//   system: Answer in one short sentence, and never use more than ten words.
//   user: What is the capital of France?
//   assistant: Paris is the capital of France.
//   user: And of Italy?
//   assistant:
//
// It needs the gateway running and one worker browser tab open in a recent Chrome whose own
// language model is ready, for example the page
// http://localhost:8787/debug_iframe_llm_gemma_nano_chrome_full.

const client = new OpenAI({
	baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_nano_chrome_full',
		messages: [
			{
				role: 'system',
				content: 'Answer in one short sentence, and never use more than ten words.',
			},
			{
				role: 'user',
				content: 'What is the capital of France?',
			},
			{
				role: 'assistant',
				content: 'Paris is the capital of France.',
			},
			{
				role: 'user',
				content: 'And of Italy?',
			},
		],
		// Accepted and then ignored, because the cluster's task input carries only a prompt and
		// the generation limits belong to the worker browser tab that runs the model.
		temperature: 0.2,
		max_tokens: 32,
	});
	console.log(completion.choices[0]?.message.content);
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
