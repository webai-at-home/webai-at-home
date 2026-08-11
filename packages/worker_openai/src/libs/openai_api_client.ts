import type { HistoryInput, GenerationSettings } from '@webai/protocol';

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

/** The shape of one Chat Completions streaming event this client reads, and ignores the rest of. */
type ChatCompletionChunk = {
	choices?: {
		delta?: {
			content?: string;
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

/** One message of the request this client sends to the local server, in the shape it expects. */
type OutgoingMessage = {
	role: string;
	content: string;
};

/**
 * The generation controls of one request to the local server, each spelled the way the OpenAI
 * Chat Completions interface spells it on the connection.
 *
 * These four spellings and `temperature` are part of the format the local server reads, so they
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
	 */
	constructor(private readonly baseUrl: string) {
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
	 * @returns The stream of text pieces the model produces, in order, and the usage object that
	 * is filled in as the stream is read and is only complete once the stream has closed.
	 * @throws If the server cannot be reached, or answers with a failure status.
	 */
	async chatCompletionStream(
		modelId: string,
		promptOrHistory: string | HistoryInput,
		abortController: AbortController,
		generationSettings?: GenerationSettings,
	): Promise<{ stream: ReadableStream<string>; usage: ChatCompletionStreamUsage }> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: modelId,
				stream: true,
				stream_options: { include_usage: true },
				messages: OpenaiApiClient.messagesOf(promptOrHistory),
				...OpenaiApiClient.generationControlsOf(generationSettings),
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
		return { stream: OpenaiApiClient.textPiecesOf(response.body, abortController, usage), usage };
	}

	/**
	 * Builds the generation controls of the request body, from what the consumer asked for.
	 *
	 * Every one of the five is native here, which is what makes this task type the one that
	 * honours all of them. Milestone 0's de-risk gate for
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
		return controls;
	}

	/**
	 * Builds the message list to send to the local server, from either a prompt or a history.
	 *
	 * A single prompt becomes the one user message this client has always sent. A history
	 * becomes its messages, each carrying the role it was given, so the local server's own chat
	 * template can place a system message and an earlier assistant turn where they belong instead
	 * of receiving one user message whose content happens to be a transcript.
	 *
	 * @param promptOrHistory The prompt or history submitted with the task.
	 * @returns The message list to send in the request body.
	 */
	private static messagesOf(promptOrHistory: string | HistoryInput): OutgoingMessage[] {
		if (typeof promptOrHistory === 'string') {
			return [{ role: 'user', content: promptOrHistory }];
		}
		return promptOrHistory.messages.map((message) => ({ role: message.role, content: message.content }));
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
	 * @returns A stream of the pieces of text the events carry, skipping events that carry none.
	 */
	private static textPiecesOf(body: ReadableStream<Uint8Array>, abortController: AbortController, usage: ChatCompletionStreamUsage): ReadableStream<string> {
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
