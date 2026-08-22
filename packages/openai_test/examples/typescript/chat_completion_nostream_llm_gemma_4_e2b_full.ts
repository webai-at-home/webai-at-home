import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generates text with the complete Gemma 4 E2B instruction-tuned model, through the cluster
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_nostream_llm_gemma_4_e2b_full --workspace @webai/openai-test
//
// The model `llm_gemma_4_e2b_full` is the complete Gemma 4 E2B instruction-tuned language model,
// downloaded directly from Hugging Face (onnx-community/gemma-4-E2B-it-ONNX, an ONNX export of
// google/gemma-4-E2B-it) and held entirely by one worker browser tab.
//
// It needs the gateway running and one worker browser tab open, for example the page
// http://localhost:8787/debug_iframe_llm_gemma_4_e2b_full. That tab needs more than any other
// example here asks for:
//
// - A WebGPU adapter with the `shader-f16` feature. This stage has no WebAssembly fallback at all,
//   because WebAssembly is far too slow to carry a model of this size. A tab without one does not
//   offer the stage, and this example is then refused for want of a worker rather than answered
//   some slower way.
// - About 3111 MB of free origin storage for the first request on a fresh browser profile, which
//   is roughly three times what `llm_llama3_2_1b_full` downloads. Later requests reuse the
//   browser's cache. An embedded browser view will not do: it caps an origin well below this.
//
// The whole answer is generated before this server answers, one piece of the answer per stage
// run, so expect to wait. Ask for `stream: true` to be answered as the answer is written instead,
// which `examples/typescript/chat_completion_streamed_llm_gemma_4_e2b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'llm_gemma_4_e2b_full',
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
