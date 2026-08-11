import OpenAI from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Shows the complete Qwen3.5-0.8B model's answer arriving as it is written
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_streamed_llm_qwen3_5_0_8b_full --workspace @webai/consumer-openai
//
// The model `llm_qwen3_5_0_8b_full` is the complete Qwen3.5-0.8B language model, downloaded
// directly from Hugging Face and held entirely by one worker browser tab.
//
// It needs the gateway running and one worker browser tab open in a browser with WebGPU and
// 16-bit float shader support, for example the page
// http://localhost:8787/debug_iframe_llm_qwen3_5_0_8b_full.
//
// A request that asks for `stream: true` is answered as the answer is written, as server-sent
// events: one chunk per piece of the answer, ended by a `[DONE]` line. Joining the pieces gives
// the same text the request would have been answered with in one piece.
//
// Asking for a stream is what makes the cluster send pieces at all. It costs a scheduling round
// for every piece, so a request that does not ask for one is answered with the fewest messages
// the pipeline can manage, which `examples/chat_completion_nostream_llm_qwen3_5_0_8b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
});

const stream = await client.chat.completions.create({
	model: 'llm_qwen3_5_0_8b_full',
	messages: [
		{
			role: 'user',
			content: 'What is the capital of France?',
		},
	],
	stream: true,
});

let answer = '';
let pieceCount = 0;
for await (const chunk of stream) {
	const piece = chunk.choices[0]?.delta.content ?? '';
	if (piece === '') {
		continue;
	}
	pieceCount += 1;
	answer += piece;
	process.stdout.write(piece);
}
process.stdout.write('\n');
console.log(`arrived in ${pieceCount} pieces, ${answer.length} characters in all`);
