import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generates text with Llama 3.2 3B, run by a local server, through the cluster
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_nostream_llm_llama3_2_3b_full --workspace @webai/consumer-openai
//
// The model `llm_llama3_2_3b_full` is the complete Llama 3.2 3B language model, held and run by a
// server already running on the worker's own device that speaks the OpenAI-compatible Chat
// Completions API, such as LM Studio. Nothing about the model is downloaded, held, or
// run by this project.
//
// Unlike every other model here, its worker is not a browser tab. It needs the gateway running
// and one worker process from `@webai/worker-openai`, started with:
//   lms server start
//   npm run sample:lmstudio --workspace @webai/worker-openai
//
// There is no model download to wait for on the first request, unlike
// `examples/chat_completion_nostream_llm_qwen3_5_0_8b_full.ts`, but the local server does load the model
// into memory on the first request of a task, which takes a few seconds.
//
// The whole answer is generated before this server answers, one piece of the answer per stage
// run, so expect to wait. Ask for `stream: true` to be answered as the answer is written instead,
// which `examples/chat_completion_streamed_llm_llama3_2_3b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'llm_llama3_2_3b_full',
		messages: [
			{
				role: 'user',
				content: 'What is the capital of France? Answer in one short sentence.',
			},
		],
	});
	console.log(completion.choices[0]?.message.content);
} catch (error: unknown) {
	// A refusal is reported in words rather than as a stack trace, because in a cluster of
	// volunteer devices the everyday reason a request fails is that no worker is currently
	// offering the work, which is an answer and not a fault in this example. For this model that
	// usually means no worker process is running, or the one that is could not reach its local
	// server or found it did not hold the model.
	if (error instanceof APIError) {
		console.error(
			`The request was refused with HTTP ${error.status} (${String(error.code)}): ${error.message}`,
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
