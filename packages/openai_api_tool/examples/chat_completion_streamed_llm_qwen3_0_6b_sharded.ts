import OpenAI from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Shows Qwen3-0.6B's answer arriving as it is written, one token at a time
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_streamed_llm_qwen3_0_6b_sharded --workspace @webai/consumer-openai
//
// The model `llm_qwen3_0_6b_sharded` is the Qwen3-0.6B language model split into three
// consecutive shards, each held and run by a different worker browser tab. The three stages
// together produce one token, and the gateway runs them again for each further token, so an
// answer of many tokens is many rounds of three stages.
//
// It needs the gateway running and worker browser tabs that between them offer all three shard
// stages, for example the page http://localhost:8787/debug_iframe_llm_qwen3_0_6b_sharded. The
// three shard files are about 860 megabytes together and are not in version control, so they
// have to be generated once first; `docs/tasks_and_stages.md` says how.
//
// A request that asks for `stream: true` is answered as the answer is written, as server-sent
// events: one chunk per piece of the answer, ended by a `[DONE]` line. Joining the pieces gives
// the same text the request would have been answered with in one piece. Every piece here is one
// token, which is the smallest piece this model produces regardless of whether a stream was
// asked for, so streaming costs no extra scheduling round for this model the way it does for
// `examples/chat_completion_streamed_llm_gemma_nano_chrome_full.ts`.
//
// This is the slowest example by a wide margin. Generation stops at the end-of-sequence token or
// at 160 tokens.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

const stream = await client.chat.completions.create({
	model: 'llm_qwen3_0_6b_sharded',
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
