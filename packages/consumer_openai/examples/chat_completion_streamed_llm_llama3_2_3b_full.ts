import OpenAI from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Shows Llama 3.2 3B's answer arriving as it is written
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_streamed_llm_llama3_2_3b_full --workspace @webai/consumer-openai
//
// The model `llm_llama3_2_3b_full` is the complete Llama 3.2 3B language model, held and run by a
// server already running on the worker's own device that speaks the OpenAI-compatible Chat
// Completions API, such as LM Studio.
//
// Unlike every other model here, its worker is not a browser tab. It needs the gateway running
// and one worker process from `@webai/worker-openai`, started with:
//   lms server start
//   npm run sample:lmstudio --workspace @webai/worker-openai
//
// A request that asks for `stream: true` is answered as the answer is written, as server-sent
// events: one chunk per piece of the answer, ended by a `[DONE]` line. Joining the pieces gives
// the same text the request would have been answered with in one piece.
//
// Asking for a stream is what makes the cluster send pieces at all. It costs a scheduling round
// for every piece, so a request that does not ask for one is answered with the fewest messages
// the pipeline can manage, which `examples/chat_completion_nostream_llm_llama3_2_3b_full.ts` shows.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
});

const stream = await client.chat.completions.create({
	model: 'llm_llama3_2_3b_full',
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
