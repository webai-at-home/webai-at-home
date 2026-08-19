import { z } from 'zod';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponsesTypes — the request body of POST /v1/responses and the answer bodies it returns
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Every field name below is spelled the way the OpenAI Responses interface spells it on the
// connection, such as `output_text` and `input_tokens`. Those spellings are part of the format an
// existing client reads, so they are not renamed to match this repository's own naming rules.
//
// The shapes here are not guessed. They are the shapes recorded byte for byte between the Codex
// command-line program and a server it accepts, in `exp_03_prompt_size_measure` of
// [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Request Body
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One piece of a message's content. `input_text` is what a client writes, `output_text` is what a
 * model wrote and the client hands back, and both carry one piece of text.
 */
export const ResponsesContentPartSchema = z.object({
	type: z.enum(['input_text', 'output_text', 'text']),
	text: z.string(),
});
/** One piece of a message's content. */
export type ResponsesContentPart = z.infer<typeof ResponsesContentPartSchema>;

/**
 * One message of the history, as this interface carries it. The content is a list of parts rather
 * than one piece of text, and the `developer` role is this interface's name for what a chat
 * completion request calls `system`.
 */
export const ResponsesMessageItemSchema = z.object({
	type: z.literal('message'),
	role: z.enum(['system', 'developer', 'user', 'assistant']),
	content: z.union([z.string(), z.array(ResponsesContentPartSchema)]),
});

/**
 * One block of a model's own thinking, handed back to it in the history. Nothing in this cluster
 * carries thinking, so it is read and left out of the history rather than refused: a client that
 * sends it back is doing what its interface says, and refusing the request would make every second
 * turn fail.
 */
export const ResponsesReasoningItemSchema = z.object({
	type: z.literal('reasoning'),
	summary: z.array(z.unknown()).optional(),
	content: z.array(z.unknown()).optional(),
});

/**
 * One tool call the model asked for, handed back in the history. `arguments` is a string of JSON
 * rather than an object, which is this interface's own choice, for the same reason the chat
 * completion interface makes it: a model does not always write valid JSON.
 */
export const ResponsesFunctionCallItemSchema = z.object({
	type: z.literal('function_call'),
	name: z.string().min(1),
	arguments: z.string(),
	call_id: z.string().optional(),
	id: z.string().optional(),
});

/** The answer of one tool call, handed back in the history. */
export const ResponsesFunctionCallOutputItemSchema = z.object({
	type: z.literal('function_call_output'),
	call_id: z.string(),
	output: z.string(),
});

/**
 * Any other kind of item, read but carried nowhere.
 *
 * The Responses interface has a growing list of item kinds, and a client hands back every item it
 * was given. An item kind this server has never seen is read and left out of the history rather
 * than refused, because refusing it would fail the second turn of a conversation over an item this
 * cluster could not have produced in the first place.
 */
export const ResponsesOtherItemSchema = z.object({
	type: z.string(),
}).passthrough();

/** One item of the history a request carries in its `input` field. */
export const ResponsesInputItemSchema = z.union([
	ResponsesMessageItemSchema,
	ResponsesFunctionCallItemSchema,
	ResponsesFunctionCallOutputItemSchema,
	ResponsesReasoningItemSchema,
	ResponsesOtherItemSchema,
]);
/** One item of the history a request carries. */
export type ResponsesInputItem = z.infer<typeof ResponsesInputItemSchema>;

/**
 * One tool a request declares by naming a function the caller runs. This interface writes such a
 * tool flat, with the name and the parameters at the top level, where the chat completion interface
 * nests them under `function`.
 */
export const ResponsesFunctionToolSchema = z.object({
	type: z.literal('function'),
	name: z.string().min(1),
	description: z.string().nullish(),
	parameters: z.record(z.string(), z.unknown()).nullish(),
	strict: z.boolean().nullish(),
});
/** One tool a request declares by naming a function the caller runs. */
export type ResponsesFunctionTool = z.infer<typeof ResponsesFunctionToolSchema>;

/**
 * Any other kind of tool a request declares.
 *
 * Two of them arrive from the Codex command-line program alone: a `web_search` tool, which is one
 * the server is expected to perform itself and this cluster cannot, and a `namespace` tool, which
 * carries a nested list of tools for spawning sub-agents. Both are read and carried nowhere, which
 * is what the server the Codex command-line program does accept was measured doing with them, and
 * which of them were left out is reported in the `X-Webai-Unsupported-Tool-Kinds` response header.
 *
 * This is not the same as dropping a function tool. A function tool left out would have the model
 * answer in words where the caller expected a call, which is the failure
 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) closed. A tool the caller
 * cannot run either is a feature this server does not have, and refusing the whole request over it
 * would leave the Codex command-line program unable to send anything at all.
 */
export const ResponsesOtherToolSchema = z.object({
	type: z.string(),
}).passthrough();

/** One tool a request declares, of any kind. */
export const ResponsesToolSchema = z.union([ResponsesFunctionToolSchema, ResponsesOtherToolSchema]);
/** One tool a request declares, of any kind. */
export type ResponsesTool = z.infer<typeof ResponsesToolSchema>;

/**
 * The body of a request to `POST /v1/responses`.
 *
 * The twelve fields the Codex command-line program sends are all read here, and the ones this
 * cluster cannot act on are read and ignored rather than refused: `reasoning`, `store`, `include`,
 * `prompt_cache_key`, and `client_metadata` ask for nothing this server can withhold. The schema
 * deliberately does not refuse unknown fields, exactly as the chat completion one does not, so a
 * client sending more than this reads no failure.
 *
 * No generation control appears here, because the Codex command-line program sends none: no
 * `max_output_tokens`, no `stop`, no `seed`, no `top_p`, and no `temperature`, measured in
 * `exp_03_prompt_size_measure` of
 * [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).
 */
export const ResponsesRequestSchema = z.object({
	model: z.string().min(1),
	input: z.union([z.string(), z.array(ResponsesInputItemSchema)]),
	instructions: z.string().nullish(),
	stream: z.boolean().nullish(),
	tools: z.array(ResponsesToolSchema).nullish(),
	tool_choice: z.union([
		z.enum(['auto', 'none', 'required']),
		z.object({
			type: z.literal('function'),
			name: z.string(),
		}),
	]).nullish(),
	parallel_tool_calls: z.boolean().nullish(),
});
/** The body of a request to `POST /v1/responses`. */
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Answer Bodies
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * How many tokens one answer cost, under the names this interface uses. The chat completion
 * interface calls the same three numbers `prompt_tokens`, `completion_tokens`, and `total_tokens`.
 */
export type ResponsesUsage = {
	/** How many tokens the prompt held, as the worker reported it. */
	input_tokens: number;
	/** How many tokens were generated, as the worker reported it. */
	output_tokens: number;
	/** The two above added together. */
	total_tokens: number;
};

/** One piece of an answer message's content. */
export type ResponsesOutputTextPart = {
	/** Always `output_text`, which is the only kind of content this cluster produces. */
	type: 'output_text';
	/** The generated text. */
	text: string;
	/** Always empty: nothing in this cluster annotates an answer. */
	annotations: unknown[];
};

/** One message the model wrote, as this interface carries it in an answer. */
export type ResponsesMessageOutputItem = {
	/** The identifier of this item, minted here because no model in this cluster writes one. */
	id: string;
	/** Always `message`. */
	type: 'message';
	/** Always `assistant`. */
	role: 'assistant';
	/** Whether this item is finished. */
	status: 'in_progress' | 'completed';
	/** The content of the message, always one `output_text` part. */
	content: ResponsesOutputTextPart[];
};

/** One tool call the model asked for, as this interface carries it in an answer. */
export type ResponsesFunctionCallOutputItem = {
	/** The identifier of this item, minted here. */
	id: string;
	/** Always `function_call`. */
	type: 'function_call';
	/** The identifier the answer of this call must carry back, minted here. */
	call_id: string;
	/** The name of the tool the model asked for. */
	name: string;
	/** The arguments it asked for, as a string of JSON. */
	arguments: string;
	/** Whether this item is finished. */
	status: 'in_progress' | 'completed';
};

/** One item of an answer: either a message the model wrote or a tool call it asked for. */
export type ResponsesOutputItem = ResponsesMessageOutputItem | ResponsesFunctionCallOutputItem;

/**
 * The whole answer of one `POST /v1/responses` request, which is both the body of an answer that
 * was not streamed and the object carried by the `response.created`, `response.in_progress`,
 * `response.completed`, and `response.failed` events of one that was.
 */
export type ResponsesResponse = {
	/** The identifier of this answer. */
	id: string;
	/** Always `response`. */
	object: 'response';
	/** When this answer was started, as whole seconds since the start of 1970. */
	created_at: number;
	/** When this answer was finished, absent while it is still being written. */
	completed_at: number | null;
	/** Where this answer has got to. */
	status: 'in_progress' | 'completed' | 'failed';
	/** Why an answer stopped early, always null here: this server fails rather than truncating. */
	incomplete_details: null;
	/** The model that wrote it, which is the model identifier the request asked for. */
	model: string;
	/** The items the model wrote, empty until it has written any. */
	output: ResponsesOutputItem[];
	/** What went wrong, when the status is `failed`. */
	error: { code: string, message: string, } | null;
	/** What the request asked about tool choice, repeated back. */
	tool_choice: string;
	/** What the request asked about parallel tool calls, repeated back. */
	parallel_tool_calls: boolean;
	/** How many tokens the answer cost, absent until the worker has reported them. */
	usage: ResponsesUsage | null;
};
