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
 * One tool call, as this interface spells it both in a request's history and in an answer.
 *
 * `arguments` is a string of JSON rather than an object, which is this interface's own choice and
 * not this project's: it is defined that way because a model does not always generate valid JSON,
 * so the field has to be able to carry whatever it wrote.
 */
export const ChatCompletionToolCallSchema = z.object({
	id: z.string(),
	type: z.literal('function'),
	function: z.object({
		name: z.string(),
		arguments: z.string(),
	}),
});
/** One tool call, as this interface spells it. */
export type ChatCompletionToolCall = z.infer<typeof ChatCompletionToolCallSchema>;

/**
 * One tool a request declares, as this interface spells it.
 */
export const ChatCompletionToolSchema = z.object({
	type: z.literal('function'),
	function: z.object({
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
	}),
});
/** One tool a request declares. */
export type ChatCompletionTool = z.infer<typeof ChatCompletionToolSchema>;

/**
 * The shape a request asks its answer to be written in, as this interface spells it.
 *
 * The three values are the three that interface defines: `text`, which is its own default and asks
 * for nothing unusual, `json_object`, which asks for any JSON object, and `json_schema`, which asks
 * for an object matching a schema the request carries.
 *
 * The field is read rather than accepted and dropped, since
 * [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191). It belongs with `tools`
 * and not with `n`: `n` tunes an answer, while this changes an answer's shape, and a client that
 * asked for JSON and received prose has no way to know its request was dropped before it calls
 * `JSON.parse` on an English sentence.
 */
export const ChatCompletionResponseFormatSchema = z.union([
	z.object({ type: z.literal('text') }),
	z.object({ type: z.literal('json_object') }),
	z.object({
		type: z.literal('json_schema'),
		json_schema: z.object({
			name: z.string().min(1),
			description: z.string().optional(),
			schema: z.record(z.string(), z.unknown()).optional(),
			strict: z.boolean().nullish(),
		}),
	}),
]);
/** The shape a request asks its answer to be written in. */
export type ChatCompletionResponseFormat = z.infer<typeof ChatCompletionResponseFormatSchema>;

/**
 * One message of a history, as a chat completion request carries it.
 *
 * The content must be a single piece of text. The OpenAI completion interface also allows a
 * list of content parts, for a request carrying images or audio, and such a request is
 * refused here rather than having its parts joined together, because a task in this cluster
 * carries one piece of text and nothing else.
 *
 * The `tool` role is accepted, since
 * [issue #115](https://github.com/webai-at-home/webai-at-home/issues/115): a history carrying
 * a tool's answer can now be continued, because a worker that can ask for a tool can also read the
 * answer of one back out of the history it is given. `content` may be absent on an assistant
 * message carrying `tool_calls`, because a model that asks for a tool writes no text at all, and
 * an OpenAI client hands back the message it was given.
 */
export const ChatCompletionMessageSchema = z.object({
	role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
	content: z.string().nullish(),
	name: z.string().optional(),
	tool_calls: z.array(ChatCompletionToolCallSchema).optional(),
	tool_call_id: z.string().optional(),
});
/** One message of a history, as a chat completion request carries it. */
export type ChatCompletionMessage = z.infer<typeof ChatCompletionMessageSchema>;

/**
 * The body of a request to `POST /v1/chat/completions`.
 *
 * The six generation controls — `temperature`, `top_p`, `max_completion_tokens` and its older
 * spelling `max_tokens`, `stop`, `seed`, and `reasoning_effort` — are read here and carried to the
 * cluster as generation settings, for whichever task types honour them. See
 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), and
 * [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) for `reasoning_effort`.
 *
 * `tools` and `tool_choice` are read too, since
 * [issue #115](https://github.com/webai-at-home/webai-at-home/issues/115), and carried to the
 * cluster for whichever task types can act on them. A request declaring tools to a model that
 * cannot read them is refused rather than answered as though it had declared none.
 *
 * `response_format` is read too, since
 * [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191), and for the same reason
 * as `tools`: it changes the shape of an answer rather than tuning it. A request asking a task type
 * for a shape it cannot produce is refused rather than answered in prose.
 *
 * Every other field an OpenAI client may send — `n`, `logprobs`, `presence_penalty`,
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
	reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullish(),
	response_format: ChatCompletionResponseFormatSchema.nullish(),
	tools: z.array(ChatCompletionToolSchema).nullish(),
	tool_choice: z.union([
		z.enum(['auto', 'none', 'required']),
		z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
	]).nullish(),
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
 * This server produces `stop`, `length`, or `tool_calls`. Nothing in this cluster filters content
 * and nothing here ever ran the older function interface, so `content_filter` and `function_call`
 * never occur, but the field is still typed as the whole closed set the OpenAI Chat Completions
 * interface defines, since that is the set a reader is entitled to expect and to nothing outside it.
 *
 * `tool_calls` means what it says on this interface: the model asked for a tool rather than writing
 * an answer, and the caller is expected to run the tool and send the result back. The cluster never
 * runs the tool itself — see
 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) for why running a caller's
 * tool on a volunteer's machine is a security problem before it is an engineering one.
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
	/**
	 * The answer the model wrote, and the tools it asked to have called.
	 *
	 * `tool_calls` is present only when the model asked for a tool, and `content` is then the empty
	 * string, because a model that asks for a tool writes no text at all. It is stated as empty
	 * rather than as `null` so that a client joining `content` never has to check which of the two
	 * kinds of answer it received.
	 */
	message: { role: 'assistant'; content: string; tool_calls?: ChatCompletionToolCall[] };
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
 * One tool call, as this interface spells it inside a chunk of an answer sent as it is written.
 *
 * The same fields as `ChatCompletionToolCall`, plus the `index` that says which tool call of the
 * answer this is. That index exists because this interface allows a tool call to arrive in pieces,
 * spread over several chunks, with the name in one and parts of the arguments in later ones — a
 * reader joins the pieces that share an index. This server never sends a tool call in pieces: a
 * worker reports a whole tool call or none, because a piece of a `<function=…>` block is
 * indistinguishable from ordinary text until it is complete. So every tool call here arrives whole,
 * in one chunk, and the index only ever says which call it is.
 */
export type ChatCompletionChunkToolCall = {
	index: number;
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

/**
 * One answer inside a chunk of a chat completion sent as the answer is written.
 *
 * `delta` carries only what this chunk adds. The first chunk of an answer states the role and
 * adds no text, every chunk after it adds text and states no role, and the last chunk adds
 * nothing and says why the answer stopped. A reader joins the `content` it is given in order.
 *
 * A model that asked for a tool writes no text at all, so its answer is a first chunk stating the
 * role, one chunk carrying every tool call it asked for, and a last chunk saying `tool_calls`.
 */
export type ChatCompletionChunkChoice = {
	index: number;
	delta: { role?: 'assistant'; content?: string; tool_calls?: ChatCompletionChunkToolCall[] };
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
