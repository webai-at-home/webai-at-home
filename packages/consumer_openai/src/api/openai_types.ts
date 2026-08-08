import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiTypes — the request bodies this server accepts and the response bodies it returns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every field name in a response body below is spelled the way the OpenAI completion
// interface spells it on the connection, such as `finish_reason` and `owned_by`. Those
// spellings are part of the format an existing client reads, so they are not renamed to
// match this repository's own naming rules.

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Request Bodies
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One message of a conversation, as a chat completion request carries it.
 *
 * The content must be a single piece of text. The OpenAI completion interface also allows a
 * list of content parts, for a request carrying images or audio, and such a request is
 * refused here rather than having its parts joined together, because a task in this cluster
 * carries one piece of text and nothing else.
 *
 * The `tool` role is refused for the same reason: this server ignores the tool settings of a
 * request, so a conversation containing the answer of a tool could not be continued sensibly.
 */
export const ChatCompletionMessageSchema = z.object({
	role: z.enum(['system', 'developer', 'user', 'assistant']),
	content: z.string(),
	name: z.string().optional(),
});
/** One message of a conversation, as a chat completion request carries it. */
export type ChatCompletionMessage = z.infer<typeof ChatCompletionMessageSchema>;

/**
 * The body of a request to `POST /v1/chat/completions`.
 *
 * The five generation controls — `temperature`, `top_p`, `max_completion_tokens` and its older
 * spelling `max_tokens`, `stop`, and `seed` — are read here and carried to the cluster as
 * generation settings, for whichever task types honour them. See
 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
 *
 * Every other field an OpenAI client may send — `n`, `tools`, `logprobs`, `presence_penalty`,
 * `frequency_penalty`, and the rest — is still accepted and then ignored, so the schema
 * deliberately does not refuse unknown fields.
 *
 * Each control accepts `null` as well as being absent, because an OpenAI client that holds no
 * value for a control commonly sends the field set to `null` rather than leaving it out, and both
 * mean the same thing: nothing was asked for.
 */
export const ChatCompletionRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(ChatCompletionMessageSchema).min(1),
	stream: z.boolean().optional(),
	stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
	temperature: z.number().min(0).max(2).nullish(),
	top_p: z.number().gt(0).max(1).nullish(),
	max_tokens: z.number().int().positive().nullish(),
	max_completion_tokens: z.number().int().positive().nullish(),
	stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
	seed: z.number().int().nullish(),
});
/** The body of a request to `POST /v1/chat/completions`. */
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Response Bodies
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Why an answer stopped, spelled the way the OpenAI Chat Completions interface spells it.
 *
 * This server only ever produces `stop` or `length`: nothing in this cluster runs tools or
 * filters content, so `tool_calls`, `content_filter`, and `function_call` never occur, but the
 * field is still typed as the whole closed set the OpenAI Chat Completions interface defines,
 * since that is the set a reader is entitled to expect and to nothing outside it.
 */
export type ChatCompletionFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';

/**
 * One answer inside a chat completion response.
 *
 * This server always returns exactly one, because one request runs one cluster task, and a
 * request asking for several answers has that setting ignored.
 */
export type ChatCompletionChoice = {
	index: number;
	message: { role: 'assistant'; content: string };
	logprobs: null;
	finish_reason: ChatCompletionFinishReason;
};

/**
 * The token counts for one answer, present only when the worker that produced it reported them.
 *
 * Rule 1 of this project's OpenAI compatibility requirement, from
 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150): `usage` is present
 * only when the counts are known, and absent rather than filled with an invented or estimated
 * number when they are not.
 */
export type ChatCompletionUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
};

/**
 * The body returned by `POST /v1/chat/completions`.
 *
 * `usage` is present only when the worker that produced the answer reported both the prompt and
 * the completion token counts. The three language-model task types this cluster runs sit on
 * three engines with three different levels of self-knowledge, so a request answered by one
 * worker may carry `usage` while the same request answered by another does not.
 */
export type ChatCompletionResponse = {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: ChatCompletionChoice[];
	usage?: ChatCompletionUsage;
};

/**
 * One answer inside a chunk of a chat completion sent as the answer is written.
 *
 * `delta` carries only what this chunk adds. The first chunk of an answer states the role and
 * adds no text, every chunk after it adds text and states no role, and the last chunk adds
 * nothing and says why the answer stopped. A reader joins the `content` it is given in order.
 */
export type ChatCompletionChunkChoice = {
	index: number;
	delta: { role?: 'assistant'; content?: string };
	logprobs: null;
	finish_reason: ChatCompletionFinishReason | null;
};

/**
 * One chunk of a chat completion sent as the answer is written, carrying one choice and no
 * usage.
 *
 * Every chunk that carries a piece of the answer, or the `finish_reason` that ends it, has this
 * shape. `usage` is stated as `null` on every one of these rather than left out, which is what
 * the OpenAI Chat Completions interface does when a caller asked for a usage chunk with
 * `stream_options: { include_usage: true }` — a caller reading each chunk's `usage` field in
 * order sees `null` until the final chunk, never a field that is sometimes present and
 * sometimes absent.
 */
export type ChatCompletionAnswerChunk = {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: ChatCompletionChunkChoice[];
	usage: null;
};

/**
 * The final chunk of a chat completion stream, carrying usage and no answer.
 *
 * Sent only when the request asked for it with `stream_options: { include_usage: true }`, after
 * the chunk that carried `finish_reason` and before the `data: [DONE]` line, exactly as the
 * OpenAI Chat Completions interface defines it. See milestone 4 of
 * [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
 */
export type ChatCompletionUsageChunk = {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: [];
	usage: ChatCompletionUsage;
};

/**
 * One chunk of a chat completion sent as the answer is written.
 *
 * The stream is a sequence of these, each on its own `data:` line, ended by a `data: [DONE]`
 * line. `id`, `created`, and `model` repeat on every chunk and are the same throughout one
 * answer, which is what lets a reader tell one answer's chunks from another's. Every chunk is
 * either an answer chunk, carrying one choice and `usage: null`, or the final usage chunk,
 * carrying no choices and a `usage` object.
 */
export type ChatCompletionChunk = ChatCompletionAnswerChunk | ChatCompletionUsageChunk;

/** One model in the list returned by `GET /v1/models`. */
export type ModelDescription = {
	id: string;
	object: 'model';
	created: number;
	owned_by: string;
};

/** The body returned by `GET /v1/models`. */
export type ModelListResponse = {
	object: 'list';
	data: ModelDescription[];
};

/** The body returned by `GET /health`. */
export type HealthResponse = {
	/** Whether this server is healthy, which is the same value as {@link isGatewayConnected}. */
	isHealthy: boolean;
	/** Whether this server currently holds a registered connection to the central gateway. */
	isGatewayConnected: boolean;
	/** How many requests are waiting for a cluster task to finish. */
	tasksInFlight: number;
	/** The git commit this server was built from. */
	commitSha: string;
};
