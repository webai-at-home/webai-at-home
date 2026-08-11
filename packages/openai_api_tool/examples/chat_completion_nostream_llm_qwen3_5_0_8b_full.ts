import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generates text with the complete Qwen3.5-0.8B model, through the cluster
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_nostream_llm_qwen3_5_0_8b_full --workspace @webai/consumer-openai
//
// The model `llm_qwen3_5_0_8b_full` is the complete Qwen3.5-0.8B language model, downloaded
// directly from Hugging Face (onnx-community/Qwen3.5-0.8B-ONNX, an ONNX export of
// Qwen/Qwen3.5-0.8B) and held entirely by one worker browser tab.
//
// It needs the gateway running and one worker browser tab open in a browser with WebGPU and
// 16-bit float shader support, for example the page
// http://localhost:8787/debug_iframe_llm_qwen3_5_0_8b_full. The first request on a fresh
// browser profile downloads about 600 MB of model files, which took about 163 seconds in
// testing; later requests reuse the browser's cache.
//
// The whole answer is generated before this server answers, one piece of the answer per stage
// run, so expect to wait. Ask for `stream: true` to be answered as the answer is written instead,
// which `examples/chat_completion_streamed_llm_qwen3_5_0_8b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'llm_qwen3_5_0_8b_full',
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
