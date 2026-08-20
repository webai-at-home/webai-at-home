import type { HistoryInput, GenerationSettings, ToolDeclaration } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiApiClient — talks to one local server that speaks the OpenAI-compatible API
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How long the model list request may take before it is given up on, in milliseconds. */
const modelListTimeoutMs = 10_000;

/**
 * One entry of the model list a server returns from `GET /v1/models`.
 *
 * Only the identifier is read here. LM Studio returns more fields than this,
 * and neither set is part of what this worker relies on.
 */
type ModelListEntry = {
	/** The identifier a completion request names in its `model` field, such as `llama-3.2-3b-instruct`. */
	id: string;
};

/** The answer to `GET /v1/models`, as LM Studio returns it. */
type ModelListResponse = {
	/** The models the server currently offers. */
	data: ModelListEntry[];
};

/**
 * One fragment of a tool call, as one streamed event carries it.
 *
 * A tool call arrives in pieces the same way text does: the name arrives once and the arguments
 * arrive a fragment at a time, each fragment carrying the `index` of the tool call it belongs to so
 * that several tool calls can be streamed at once and interleaved. Measured live against LM Studio
 * 0.4.20 serving `qwen_qwen3.5-0.8b` in milestone 0's de-risk gate for
 * https://github.com/webai-at-home/webai-at-home/issues/190: one fragment carried the identifier and
 * the name with empty arguments, and a later fragment of the same `index` carried
 * `{"city":"Paris"}`.
 */
type ChatCompletionToolCallFragment = {
	index: number;
	function?: {
		name?: string;
		arguments?: string;
	};
};

/** The shape of one Chat Completions streaming event this client reads, and ignores the rest of. */
type ChatCompletionChunk = {
	choices?: {
		delta?: {
			content?: string;
			tool_calls?: ChatCompletionToolCallFragment[];
		};
		finish_reason?: string | null;
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
};

/**
 * The usage and finish reason a Chat Completions stream carries once it has finished, read from
 * whichever streamed event happened to carry them.
 *
 * Milestone 0's de-risk gate for https://github.com/webai-at-home/webai-at-home/issues/150 found
 * LM Studio sends an exact `usage` and a real `finish_reason` (`stop` or `length`) already, but
 * split across events: a `finish_reason`-carrying event with an empty delta, and — only when the
 * request asks for it — a further, `choices`-empty event carrying `usage`. This client
 * accumulates both across the whole stream rather than reading either from a single expected
 * event. Re-confirmed live against LM Studio 0.4.20 serving `llama-3.2-3b-instruct`: the same
 * request sent without `stream_options` carried no `choices`-empty usage event at all, and sent
 * with it carried exactly one.
 */
export type ChatCompletionStreamUsage = {
	/** The exact number of tokens the prompt was encoded into, once the server has reported it. */
	promptTokenCount: number | undefined;
	/** The exact number of tokens the server generated for this answer, once it has reported it. */
	completionTokenCount: number | undefined;
	/** The server's own OpenAI `finish_reason` value, once an event has carried one. */
	finishReason: string | undefined;
};

/**
 * One tool call this client read out of a stream, assembled from every fragment that carried it.
 *
 * It carries no identifier, because the protocol carries none: `ToolCallSchema` in
 * `@webai/protocol` states why. The identifier the local server issued is read past rather than
 * kept, and the identifier this client sends back in a later history is minted by
 * {@link OpenaiApiClient} rather than remembered from here.
 */
export type StreamedToolCall = {
	/** The name of the tool the model asked to have called. */
	name: string;
	/** The arguments the model filled in, as the string of JSON this interface carries them as. */
	argumentsJson: string;
};

/**
 * The tool calls one Chat Completions stream carries, assembled as the stream is read and complete
 * only once it has closed.
 *
 * Keyed by the `index` each fragment names rather than held as a list, because fragments of
 * several tool calls can be interleaved. {@link OpenaiApiClient.orderedToolCallsOf} puts them back
 * into the order the model asked for them in.
 */
export type ChatCompletionStreamToolCalls = {
	/** The tool calls assembled so far, keyed by the index the local server gave each one. */
	byIndex: Map<number, StreamedToolCall>;
};

/**
 * One tool declaration of the request this client sends to the local server, spelled the way the
 * OpenAI Chat Completions interface spells it on the connection.
 *
 * These spellings are part of a format the local server reads, so they are not renamed to match
 * this repository's own naming rules, for the same reason {@link OutgoingGenerationControls} is not.
 */
type OutgoingToolDeclaration = {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
};

/**
 * One tool call of an outgoing assistant message, in the shape the local server reads it in.
 *
 * The identifier is minted by this client. The local server refuses a message list whose tool call
 * carries none — measured live in milestone 0's de-risk gate for
 * https://github.com/webai-at-home/webai-at-home/issues/190, where a round trip sent without one
 * was answered with HTTP 400 and `Invalid 'messages' in payload` — while the protocol deliberately
 * carries no identifier at all. Minting one here is what closes that gap, and the same gate proved
 * a minted identifier the server never issued is accepted.
 */
type OutgoingToolCall = {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
};

/** One message of the request this client sends to the local server, in the shape it expects. */
type OutgoingMessage = {
	role: string;
	content: string;
	/** The tools an assistant message asked to have called, absent on every other message. */
	tool_calls?: OutgoingToolCall[];
	/** The tool call a `tool` message answers, absent on every other message. */
	tool_call_id?: string;
};

/**
 * The generation controls of one request to the local server, each spelled the way the OpenAI
 * Chat Completions interface spells it on the connection.
 *
 * These five spellings and `temperature` are part of the format the local server reads, so they
 * are not renamed to match this repository's own naming rules, and every field is left out
 * entirely rather than sent as `null` when the consumer asked for nothing, so that a server's own
 * default is what applies.
 */
type OutgoingGenerationControls = {
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stop?: string[];
	seed?: number;
	reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

/**
 * The response format of one request to the local server, in the shape the OpenAI Chat Completions
 * interface reads it in.
 *
 * `json_schema` is the only type here, and a consumer asking for `json_object` is carried in it as
 * the schema that means the same thing. Milestone 4 of
 * https://github.com/webai-at-home/webai-at-home/issues/219 measured why: LM Studio 0.4.20 answers
 * a `json_object` request with HTTP 400 and `'response_format.type' must be 'json_schema' or
 * 'text'`, while Ollama 0.32.14 answers it correctly. Both answer a `json_schema` request carrying
 * the schema `{ "type": "object" }` with a JSON object, so that one form is the one this client
 * sends and neither server has to be told apart from the other.
 *
 * A consumer asking for `json_schema` itself is refused instead, because it names a schema of its
 * own and the protocol carries no schema to put here. See milestone 6 of that issue.
 */
type OutgoingResponseFormat = {
	type: 'json_schema';
	json_schema: {
		/** A label for the schema, which the OpenAI Chat Completions interface requires. */
		name: string;
		/** Whether the server must hold the model to the schema rather than merely suggest it. */
		strict: true;
		/** The schema the answer must satisfy, as a JSON Schema document. */
		schema: Record<string, unknown>;
	};
};

/**
 * Talks to one locally running server that speaks the OpenAI-compatible API, such as LM Studio.
 *
 * The server is named by a base URL rather than chosen here, because which server a worker
 * talks to is decided by whoever starts the worker process. The client holds that base URL, so
 * it has state and its methods are instance methods.
 *
 * Confirmed live against a running local server before this class was written (see the de-risk
 * gate recorded in https://github.com/webai-at-home/webai-at-home/issues/103), and re-confirmed
 * against LM Studio 0.4.20 serving `llama-3.2-3b-instruct`: `POST /v1/chat/completions` with
 * `stream: true` delivers one piece of the answer per streamed event, each carrying its piece in
 * `choices[0].delta.content`, and ends with an event whose `finish_reason` is set followed by a
 * literal `data: [DONE]` line.
 */
export class OpenaiApiClient {
	/**
	 * @param baseUrl The base URL of the local server's OpenAI-compatible API, without a
	 * trailing slash, such as `http://localhost:1234/v1`.
	 * @param apiKey The bearer token to present to that server, or `undefined` to send no
	 * `Authorization` header at all, which is what a local server such as LM Studio expects,
	 * since it requires no key. A hosted server behind `OPENAI_BASE_URL`, such as the OpenAI
	 * API itself, requires this to be set.
	 */
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string | undefined = undefined,
	) {
	}

	/**
	 * Builds the `Authorization` header to send with every request, from the API key this
	 * client was constructed with.
	 *
	 * @returns The header to spread into a request's headers, empty when this client was
	 * constructed with no API key.
	 */
	private authorizationHeader(): Record<string, string> {
		if (this.apiKey === undefined) {
			return {};
		}
		return {
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	/**
	 * Lists the models the local server currently offers.
	 *
	 * @returns The model identifiers, in the order the server listed them.
	 * @throws If the server cannot be reached, answers with a failure status, or answers with
	 * something that is not a model list.
	 */
	async listModelIds(): Promise<string[]> {
		const response = await fetch(`${this.baseUrl}/models`, {
			headers: this.authorizationHeader(),
			signal: AbortSignal.timeout(modelListTimeoutMs),
		}).catch((error: unknown) => {
			throw new Error(`The server at ${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (response.ok === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list with status ${response.status}`);
		}
		const body = await response.json() as ModelListResponse;
		if (Array.isArray(body.data) === false) {
			throw new Error(`The server at ${this.baseUrl} answered its model list without a "data" array`);
		}
		return body.data.map((entry) => entry.id);
	}

	/**
	 * Starts a Chat Completions request and returns the pieces of the answer as they stream in,
	 * together with the usage and finish reason the server reports for the whole answer.
	 *
	 * Sends `stream_options: { include_usage: true }`, confirmed live against LM Studio (see
	 * milestone 0's de-risk gate for https://github.com/webai-at-home/webai-at-home/issues/150) to
	 * be what makes it send the further, `choices`-empty event that carries `usage`; without it,
	 * only `finish_reason` arrives.
	 *
	 * @param modelId The model to ask for, exactly as the local server names it.
	 * @param promptOrHistory The prompt to answer, or the whole history to continue when
	 * the task carries one instead of a single prompt.
	 * @param abortController Aborts the request when the answer is no longer wanted. The stream's
	 * own `cancel` calls this, so cancelling the reader stops the request to the local server
	 * rather than only stopping this side from reading it.
	 * @param generationSettings What the consumer asked for about how the answer is generated. Its
	 * five generation controls become the fields of the same meaning in the request body; a
	 * setting the consumer did not state is left out of the body entirely.
	 * @returns The stream of text pieces the model produces, in order, the usage object, and the
	 * tool calls the model asked for. The usage object and the tool calls are both filled in as the
	 * stream is read and are only complete once the stream has closed.
	 * @throws If the server cannot be reached, or answers with a failure status.
	 */
	async chatCompletionStream(
		modelId: string,
		promptOrHistory: string | HistoryInput,
		abortController: AbortController,
		generationSettings?: GenerationSettings,
	): Promise<{ stream: ReadableStream<string>; usage: ChatCompletionStreamUsage; toolCalls: ChatCompletionStreamToolCalls }> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...this.authorizationHeader(),
			},
			body: JSON.stringify({
				model: modelId,
				stream: true,
				stream_options: { include_usage: true },
				messages: OpenaiApiClient.messagesOf(promptOrHistory),
				...OpenaiApiClient.toolFieldsOf(promptOrHistory),
				...OpenaiApiClient.generationControlsOf(generationSettings),
				...OpenaiApiClient.responseFormatFieldOf(generationSettings),
			}),
			signal: abortController.signal,
		}).catch((error: unknown) => {
			throw new Error(`The server at ${this.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		});
		if (response.ok === false) {
			throw new Error(`The server at ${this.baseUrl} answered the chat completion with status ${response.status}`);
		}
		if (response.body === null) {
			throw new Error(`The server at ${this.baseUrl} answered the chat completion with no body`);
		}
		const usage: ChatCompletionStreamUsage = { promptTokenCount: undefined, completionTokenCount: undefined, finishReason: undefined };
		const toolCalls: ChatCompletionStreamToolCalls = { byIndex: new Map<number, StreamedToolCall>() };
		return { stream: OpenaiApiClient.textPiecesOf(response.body, abortController, usage, toolCalls), usage, toolCalls };
	}

	/**
	 * Puts the tool calls read from a stream back into the order the model asked for them in.
	 *
	 * @param toolCalls The tool calls assembled while the stream was read.
	 * @returns The tool calls, ordered by the index the local server gave each one, empty when the
	 * model asked for no tool.
	 */
	static orderedToolCallsOf(toolCalls: ChatCompletionStreamToolCalls): StreamedToolCall[] {
		return [...toolCalls.byIndex.entries()]
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.map(([, toolCall]) => toolCall);
	}

	/**
	 * Builds the generation controls of the request body, from what the consumer asked for.
	 *
	 * Every one of the six is a field of the request this local server already reads, so this
	 * worker can forward whichever of them reaches it. Milestone 0's de-risk gate for
	 * https://github.com/webai-at-home/webai-at-home/issues/151 proved all five live against
	 * LM Studio 0.4.20 serving `llama-3.2-3b-instruct`, one at a time: `temperature: 0` repeated one
	 * answer word for word three times where `temperature: 1.6` gave three different answers,
	 * `top_p: 0.01` collapsed `temperature: 1.6` back onto that same answer, `max_tokens: 8` cut
	 * the answer at eight completion tokens and reported `finish_reason: length`, `stop: ["3"]` cut
	 * `"1 2 3 4 5 6 7 8 9"` down to `"1 2 "`, and `seed: 42` repeated an answer that `seed: 43`
	 * changed.
	 *
	 * A setting the consumer did not state produces no field at all, rather than a field set to
	 * `null`, so that the local server applies its own default exactly as it did before this
	 * cluster carried any of these controls.
	 *
	 * Only the controls the task type's own contract names ever arrive here. A task type's
	 * contract is the intersection of what all of its workers can honour, so a control this
	 * native worker could honour but the worker browser tab running the same task type cannot is
	 * refused by `packages/consumer_openai` at submission and never reaches this method. The six
	 * branches below therefore stay written out in full while fewer than six are reachable. See
	 * step 1 of https://github.com/webai-at-home/webai-at-home/issues/196.
	 *
	 * `reasoning_effort` was proved live against LM Studio 0.4.20 serving `qwen_qwen3.5-0.8b` for
	 * https://github.com/webai-at-home/webai-at-home/issues/192. A two-turn question that spent all
	 * 8153 of its tokens thinking and returned an empty answer was answered in 42 tokens with 0
	 * reasoning tokens once `"none"` was sent; `"low"` and `"medium"` both still ran to the context
	 * limit. The six levels are the ones that server names itself when it refuses a seventh. Sending
	 * the field to a model that does not think is harmless: `llama-3.2-1b-instruct` accepted it,
	 * ignored it, and answered correctly.
	 *
	 * @param generationSettings What the consumer asked for, or `undefined` when it asked for
	 * nothing.
	 * @returns The fields to spread into the request body, empty when no control was asked for.
	 */
	private static generationControlsOf(generationSettings: GenerationSettings | undefined): OutgoingGenerationControls {
		const controls: OutgoingGenerationControls = {};
		if (generationSettings === undefined) {
			return controls;
		}
		if (generationSettings.temperature !== undefined) {
			controls.temperature = generationSettings.temperature;
		}
		if (generationSettings.topP !== undefined) {
			controls.top_p = generationSettings.topP;
		}
		if (generationSettings.maximumOutputTokenCount !== undefined) {
			controls.max_tokens = generationSettings.maximumOutputTokenCount;
		}
		if (generationSettings.stopSequences !== undefined) {
			controls.stop = [...generationSettings.stopSequences];
		}
		if (generationSettings.randomSeed !== undefined) {
			controls.seed = generationSettings.randomSeed;
		}
		if (generationSettings.reasoningEffort !== undefined) {
			controls.reasoning_effort = generationSettings.reasoningEffort;
		}
		return controls;
	}

	/**
	 * Builds the response format field of the request body, from the shape the consumer asked for.
	 *
	 * The local server enforces the shape, and this client only asks for it. Milestone 4 of
	 * https://github.com/webai-at-home/webai-at-home/issues/219 measured that live through this
	 * worker rather than against either server directly, against LM Studio 0.4.20 serving
	 * `google/gemma-4-e2b` and Ollama 0.32.14 serving `gemma4:e2b`. One question, asked with no field
	 * sent and then with it: both servers answered in prose without it, which `JSON.parse` refuses,
	 * and both answered with a JSON object with it, whole and in pieces alike, every piece joining
	 * back to exactly the object the finished answer carried.
	 *
	 * The two servers disagree about what a shape costs, and both answers are correct. LM Studio
	 * stopped the model thinking altogether — 219 completion tokens in 5.7 seconds became 19 in 0.5,
	 * with the prompt counted at the same 33 tokens. Ollama let it go on thinking and counted that
	 * thinking as prompt tokens rather than completion tokens: 33 and 221 became 281 and 39. Both
	 * counts reach the consumer as its `usage`, so this is worth knowing before reading anything into
	 * either.
	 *
	 * Beside declared tools the two disagree in a way that matters more. Ollama still asked for the
	 * tool. LM Studio asked for no tool at all and answered `{"city": "Paris", "weather": "Sunny"}`,
	 * inventing the very reading the tool exists to fetch. Neither is reachable: the worker browser
	 * tab running this same task type refuses a shape beside tools outright, and a task type promises
	 * only what all of its workers can keep.
	 *
	 * @param generationSettings What the consumer asked for, or `undefined` when it asked for
	 * nothing.
	 * @returns The field to spread into the request body, empty when no shape was asked for.
	 * @throws If the consumer asked for `json_schema`, which this client cannot express.
	 */
	private static responseFormatFieldOf(generationSettings: GenerationSettings | undefined): { response_format?: OutgoingResponseFormat } {
		if (generationSettings === undefined || generationSettings.responseFormat === undefined) {
			return {};
		}
		if (generationSettings.responseFormat === 'json_schema') {
			throw new Error('This worker cannot ask the local server for a json_schema answer, because the protocol carries no schema to send with it.');
		}
		return {
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'json_object',
					strict: true,
					schema: {
						type: 'object',
					},
				},
			},
		};
	}

	/**
	 * Builds the tool declaration field of the request body, from the tools the history declared.
	 *
	 * The local server reads the declarations and renders them through the model's own chat
	 * template, which is what puts them in front of the model at all. Milestone 0's de-risk gate for
	 * https://github.com/webai-at-home/webai-at-home/issues/190 proved this live against LM Studio
	 * 0.4.20 serving `qwen_qwen3.5-0.8b`: the same question sent with one `get_weather` declaration
	 * was counted as 275 prompt tokens and answered with `finish_reason: tool_calls`, where the
	 * request built without this field was counted as 17 and answered in words. Those 17 tokens are
	 * the defect this method exists to fix.
	 *
	 * A history that declared no tool, and every task submitted as a single prompt, produce no
	 * field at all, so every request this worker sent before it carried tools is byte for byte the
	 * request it still sends.
	 *
	 * There is deliberately no `tool_choice` beside it. The protocol carries no such value, for the
	 * reason `HistoryInputSchema` states, and `packages/consumer_openai` refuses at submission a
	 * `tool_choice` it cannot enforce.
	 *
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The fields to spread into the request body, empty when no tool was declared.
	 */
	private static toolFieldsOf(promptOrHistory: string | HistoryInput): { tools?: OutgoingToolDeclaration[] } {
		if (typeof promptOrHistory === 'string' || promptOrHistory.tools === undefined || promptOrHistory.tools.length === 0) {
			return {};
		}
		return {
			tools: promptOrHistory.tools.map((tool: ToolDeclaration): OutgoingToolDeclaration => ({
				type: 'function',
				function: {
					name: tool.name,
					...(tool.description === undefined ? {} : { description: tool.description }),
					parameters: tool.parametersJsonSchema,
				},
			})),
		};
	}

	/**
	 * Builds the message list to send to the local server, from either a prompt or a history.
	 *
	 * A single prompt becomes the one user message this client has always sent. A history
	 * becomes its messages, each carrying the role it was given, so the local server's own chat
	 * template can place a system message and an earlier assistant turn where they belong instead
	 * of receiving one user message whose content happens to be a transcript.
	 *
	 * An assistant message that asked for tools is sent with those tool calls beside its content,
	 * so a history carrying a finished tool round trip can be answered: the model reads its own
	 * earlier request in the form its chat template writes, rather than a rewriting of it. Each
	 * call is given an identifier minted here, and the `tool` messages that follow it answer the
	 * calls in order, which is all the protocol says about which result answers which call — see
	 * `ToolCallSchema` in `@webai/protocol` for why there is no identifier to carry instead.
	 *
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The message list to send in the request body.
	 */
	private static messagesOf(promptOrHistory: string | HistoryInput): OutgoingMessage[] {
		if (typeof promptOrHistory === 'string') {
			return [{ role: 'user', content: promptOrHistory }];
		}
		// The identifiers minted for the tool calls of the most recent assistant message, in the
		// order that message asked for them, waiting for the `tool` messages that answer them.
		let awaitedToolCallIds: string[] = [];
		let mintedToolCallCount = 0;
		return promptOrHistory.messages.map((message): OutgoingMessage => {
			if (message.role === 'tool') {
				// A result with no call left to answer is sent without an identifier and refused by
				// the local server, which is the right outcome: a history that answers a call it
				// never made is not a history this worker can repair.
				const answeredToolCallId = awaitedToolCallIds.shift();
				return {
					role: message.role,
					content: message.content,
					...(answeredToolCallId === undefined ? {} : { tool_call_id: answeredToolCallId }),
				};
			}
			if (message.toolCalls === undefined) {
				return { role: message.role, content: message.content };
			}
			const toolCalls = message.toolCalls.map((toolCall): OutgoingToolCall => {
				const id = `call_${mintedToolCallCount}`;
				mintedToolCallCount += 1;
				return {
					id,
					type: 'function',
					function: {
						name: toolCall.name,
						// The protocol carries every argument value as the text the model wrote, so
						// the string of JSON this interface asks for is built here rather than
						// carried through.
						arguments: JSON.stringify(toolCall.argumentValues),
					},
				};
			});
			awaitedToolCallIds = toolCalls.map((toolCall) => toolCall.id);
			return {
				role: message.role,
				content: message.content,
				tool_calls: toolCalls,
			};
		});
	}

	/**
	 * Merges the tool call fragments of one streamed event into the tool calls assembled so far.
	 *
	 * @param fragments The tool call fragments of one event, `undefined` when it carried none.
	 * @param toolCalls The tool calls assembled so far, updated in place.
	 * @returns Nothing.
	 */
	private static collectToolCallFragments(fragments: ChatCompletionToolCallFragment[] | undefined, toolCalls: ChatCompletionStreamToolCalls): void {
		if (fragments === undefined) {
			return;
		}
		for (const fragment of fragments) {
			const assembled = toolCalls.byIndex.get(fragment.index) ?? {
				name: '',
				argumentsJson: '',
			};
			if (fragment.function?.name !== undefined) {
				assembled.name += fragment.function.name;
			}
			if (fragment.function?.arguments !== undefined) {
				assembled.argumentsJson += fragment.function.arguments;
			}
			toolCalls.byIndex.set(fragment.index, assembled);
		}
	}

	/**
	 * Reads a Chat Completions streaming response body and delivers the text piece of each event,
	 * as `server-sent events` carrying the shape of {@link ChatCompletionChunk}.
	 *
	 * @param body The response body, a stream of raw bytes.
	 * @param abortController Aborted when the returned stream is cancelled, so a reader giving up
	 * on the answer stops the request rather than only stopping its own read.
	 * @param usage Filled in with whatever `usage` and `finish_reason` fields each event carries,
	 * as they arrive. Complete only once the returned stream has closed.
	 * @param toolCalls Filled in with the tool call fragments each event carries, as they arrive.
	 * Complete only once the returned stream has closed.
	 * @returns A stream of the pieces of text the events carry, skipping events that carry none.
	 */
	private static textPiecesOf(body: ReadableStream<Uint8Array>, abortController: AbortController, usage: ChatCompletionStreamUsage, toolCalls: ChatCompletionStreamToolCalls): ReadableStream<string> {
		const bodyReader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		return new ReadableStream<string>({
			// This must not return until it has enqueued a piece, closed the stream, or failed.
			// A pull that returns having done none of the three is never called again while a
			// read is outstanding, which deadlocks the stream: the reader waits for a piece that
			// only another pull could deliver. Reading more bytes from the body is therefore part
			// of this loop rather than a step that ends the pull.
			async pull(controller) {
				for (;;) {
					const newlineIndex = buffer.indexOf('\n');
					if (newlineIndex === -1) {
						const { value, done } = await bodyReader.read();
						if (done) {
							controller.close();
							return;
						}
						buffer += decoder.decode(value, { stream: true });
						continue;
					}
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (line.startsWith('data:') === false) {
						continue;
					}
					const data = line.slice('data:'.length).trim();
					if (data === '[DONE]') {
						controller.close();
						return;
					}
					if (data === '') {
						continue;
					}
					const chunk = JSON.parse(data) as ChatCompletionChunk;
					if (chunk.usage?.prompt_tokens !== undefined) {
						usage.promptTokenCount = chunk.usage.prompt_tokens;
					}
					if (chunk.usage?.completion_tokens !== undefined) {
						usage.completionTokenCount = chunk.usage.completion_tokens;
					}
					const finishReason = chunk.choices?.[0]?.finish_reason;
					if (typeof finishReason === 'string') {
						usage.finishReason = finishReason;
					}
					OpenaiApiClient.collectToolCallFragments(chunk.choices?.[0]?.delta?.tool_calls, toolCalls);
					const content = chunk.choices?.[0]?.delta?.content;
					if (typeof content === 'string' && content !== '') {
						controller.enqueue(content);
						return;
					}
				}
			},
			cancel() {
				abortController.abort();
				return bodyReader.cancel().catch(() => undefined);
			},
		});
	}
}
