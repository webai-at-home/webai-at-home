import OpenAI from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Shows the complete Gemma 4 E2B instruction-tuned model's answer arriving as it is written
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_streamed_llm_gemma_4_e2b_full --workspace @webai/openai-test
//
// The model `llm_gemma_4_e2b_full` is the complete Gemma 4 E2B instruction-tuned language model,
// downloaded directly from Hugging Face and held entirely by one worker browser tab.
//
// It needs the gateway running and one worker browser tab open in a browser with a WebGPU adapter
// carrying the `shader-f16` feature, for example the page
// http://localhost:8787/debug_iframe_llm_gemma_4_e2b_full. This stage has no WebAssembly fallback,
// so a tab without such an adapter does not offer it at all.
//
// A request that asks for `stream: true` is answered as the answer is written, as server-sent
// events: one chunk per piece of the answer, ended by a `[DONE]` line. Joining the pieces gives
// the same text the request would have been answered with in one piece.
//
// Asking for a stream is what makes the cluster send pieces at all. It costs a scheduling round
// for every piece, so a request that does not ask for one is answered with the fewest messages
// the pipeline can manage, which `examples/chat_completion_nostream_llm_gemma_4_e2b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
});

const stream = await client.chat.completions.create({
	model: 'llm_gemma_4_e2b_full',
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
