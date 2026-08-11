import OpenAI, { APIError } from 'openai';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generates text with Qwen3-0.6B split across three worker browser tabs
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Run with:
//   npm run example:chat_completion_nostream_llm_qwen3_0_6b_sharded --workspace @webai/consumer-openai
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
// This is the slowest example by a wide margin. The whole answer is generated before this
// server answers, and generation stops at the end-of-sequence token or at 160 tokens.

const client = new OpenAI({
	baseURL: process.env.WEBAI_OPENAI_BASE_URL ?? 'http://localhost:8788/v1',
	apiKey: process.env.OPENAI_API_KEY ?? 'no-key-required',
	maxRetries: 0,
	timeout: 600_000,
});

try {
	const completion = await client.chat.completions.create({
		model: 'llm_qwen3_0_6b_sharded',
		messages: [
			{
				role: 'user',
				content: 'What is the capital of France?',
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
