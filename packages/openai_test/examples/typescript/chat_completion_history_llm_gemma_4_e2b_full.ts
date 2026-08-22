import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Carries a real history across two turns, with the complete Gemma 4 E2B instruction-tuned model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:ts:chat_completion_history_llm_gemma_4_e2b_full --workspace @webai/openai-test
//
// The model `llm_gemma_4_e2b_full` is one of the three models whose task type accepts a whole
// history rather than only one prompt (`llm_qwen3_5_0_8b_full` and `llm_llama3_2_1b_full` are the
// other two; see `examples/typescript/chat_completion_history_llm_qwen3_5_0_8b_full.ts` and
// `examples/typescript/chat_completion_history_llm_llama3_2_1b_full.ts`). Sending several messages here does
// not flatten them into lines of `role: content` text the way `llm_gemma_nano_chrome_full` and
// `llm_qwen3_0_6b_sharded` still do — this server submits the messages as they are, and
// `@huggingface/transformers` applies the model's own chat template to real turns. Gemma 4 E2B
// ships both `chat_template.jinja` and a `chat_template` in `tokenizer_config.json`, which is what
// makes that possible for this model.
//
// This example shows what that is worth: the first request states a fact and nothing else, the
// second sends the whole history so far, including the model's own first answer, and asks a
// question that can only be answered by recalling what the first turn said. A caller builds the
// second request's `messages` array itself; this server keeps no history state between
// requests, so every request still carries the whole history.
//
// It needs the gateway running and one worker browser tab open in a browser with a WebGPU adapter
// carrying the `shader-f16` feature, for example the page
// http://localhost:8787/debug_iframe_llm_gemma_4_e2b_full. This stage has no WebAssembly fallback.
// The first request on a fresh browser profile downloads about 3111 MB of model files; later
// requests, including the second one below, reuse the browser's cache.

const client = new OpenAI({
	baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

const model = 'llm_gemma_4_e2b_full';

try {
	const firstQuestion = 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.';
	console.log(`user: ${firstQuestion}`);
	const firstTurn = await client.chat.completions.create({
		model,
		messages: [
			{
				role: 'user',
				content: firstQuestion,
			},
		],
	});
	const firstAnswer = firstTurn.choices[0]?.message.content ?? '';
	console.log(`assistant: ${firstAnswer}`);

	const secondQuestion = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';
	console.log(`user: ${secondQuestion}`);
	const secondTurn = await client.chat.completions.create({
		model,
		messages: [
			{
				role: 'user',
				content: firstQuestion,
			},
			{
				role: 'assistant',
				content: firstAnswer,
			},
			{
				role: 'user',
				content: secondQuestion,
			},
		],
	});
	console.log(`assistant: ${secondTurn.choices[0]?.message.content}`);
} catch (error: unknown) {
	// A refusal is reported in words rather than as a stack trace, because in a cluster of
	// volunteer browsers the everyday reason a request fails is that no browser tab is currently
	// offering the work, which is an answer and not a fault in this example.
	if (error instanceof APIError) {
		console.error(
			`The request was refused with HTTP ${error.status} (${String(error.code)}): ${error.message}`,
		);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
