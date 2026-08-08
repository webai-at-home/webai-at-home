// npm imports
import OpenAI, { APIError } from 'openai';

// local imports
import type { ChatCompletionUsage, CompletionMode, CompletionResult, CompletionTarget, GenerationControls } from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender — the one way this package sends a chat completion request and times it
//
//	Every subcommand goes through this class, so `completion`, `history`, and `benchmark` cannot
//	drift apart in how they talk to an endpoint or in what their timings mean.
//	The `openai` npm package is the single transport: nothing here builds a request body, parses
//	server-sent events, or reads a response body by hand.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one call to `CompletionSender.send` needs. */
export type SendCompletionOptions = {
	/** The OpenAI client pointed at the endpoint under test. */
	readonly client: OpenAI;
	/** The model identifier to request. */
	readonly modelId: string;
	/** The full list of messages to send. */
	readonly messages: OpenAI.ChatCompletionMessageParam[];
	/** Whether to ask for the answer as it is written, or in one piece. */
	readonly mode: CompletionMode;
	/**
	 * Called with each piece of the answer as it arrives, so a subcommand that shows the answer
	 * to a person can write it out while it is being produced. Left out by the benchmark, which
	 * measures rather than shows.
	 */
	readonly writePiece?: (piece: string) => void;
	/**
	 * Whether to ask the streamed mode for its final, choice-less usage chunk with
	 * `stream_options: { include_usage: true }`. Left out by every caller other than the `usage`
	 * subcommand, so `completion`, `history`, and `benchmark` keep sending the exact request they
	 * always have. Has no effect in the nostream mode, which reports `usage` in its response body
	 * regardless of this option.
	 */
	readonly includeUsage?: boolean;
	/**
	 * The generation controls to ask for, each spelled the way the OpenAI Chat Completions
	 * interface spells it. Left out by every caller other than the `generation_controls`
	 * subcommand, so `completion`, `history`, `benchmark`, and `usage` keep sending the exact
	 * request they always have.
	 */
	readonly controls?: GenerationControls;
};

/** The completion request a benchmark run uses, replaceable for deterministic tests. */
export type CompletionRequester = (modelId: string, prompt: string) => Promise<CompletionResult>;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Sends one chat completion request to an OpenAI-compatible endpoint and measures it. */
export class CompletionSender {
	/**
	 * Builds the OpenAI client every request of one run goes through.
	 *
	 * Retries are turned off, because a retried request would be timed as though it were the
	 * first one, which would make every measurement this package produces untrustworthy.
	 *
	 * @param target The endpoint to send requests to.
	 * @returns The client, ready to be handed to `send`.
	 */
	static createClient(target: CompletionTarget): OpenAI {
		return new OpenAI({
			baseURL: target.baseUrl,
			apiKey: target.apiKey,
			maxRetries: 0,
			timeout: target.timeoutMs,
		});
	}

	/**
	 * Sends one chat completion request in the requested mode and measures when its first and
	 * last character arrived.
	 *
	 * @param options The client, the model identifier, the messages, the mode, and where to write
	 * each piece of the answer as it arrives.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If the endpoint returned no answer text at all.
	 */
	static async send(options: SendCompletionOptions): Promise<CompletionResult> {
		if (options.mode === 'streamed') {
			return await CompletionSender._sendStreamed(options);
		}
		return await CompletionSender._sendNostream(options);
	}

	/**
	 * Turns a caught error into one line of text, reporting a refusal from the endpoint in words
	 * rather than as a stack trace. In a cluster of volunteer devices the everyday reason a
	 * request fails is that no worker is currently offering the work, which is an answer and not
	 * a fault in the program that asked.
	 *
	 * @param error The error caught around one request.
	 * @returns The message to print and to record in the outcome.
	 */
	static describeFailure(error: unknown): string {
		if (error instanceof APIError) {
			return `HTTP ${error.status} (${String(error.code)}): ${error.message}`;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	/**
	 * Reads the endpoint's own short name for why it refused a request, when it sent one.
	 *
	 * This is what tells a refusal that is an answer apart from a refusal that is a fault. This
	 * project's own `consumer_openai` server refuses a request asking a model for a generation
	 * control it cannot honour with the code `unhonourable_generation_control`, rather than
	 * ignoring the control, so a prober reading that code learns the model's real answer.
	 *
	 * @param error The error caught around one request.
	 * @returns The endpoint's own `code`, or `undefined` when the failure carried none.
	 */
	static failureCode(error: unknown): string | undefined {
		if (error instanceof APIError && typeof error.code === 'string') {
			return error.code;
		}
		return undefined;
	}

	/**
	 * Reads the endpoint's own explanation of a failure, in its own words and nothing else.
	 *
	 * Unlike {@link describeFailure}, this adds no status and no code, and it removes the status
	 * the `openai` npm package puts at the front of its message, so a caller that already reports
	 * the status itself does not print it twice.
	 *
	 * @param error The error caught around one request.
	 * @returns The endpoint's own words.
	 */
	static failureExplanation(error: unknown): string {
		if (error instanceof APIError) {
			return error.message.startsWith(`${error.status} `) ? error.message.slice(String(error.status).length + 1) : error.message;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the generation control fields of one request body.
	 *
	 * A control the caller did not ask for produces no field at all, rather than a field set to
	 * `null`, so that the endpoint applies its own default and a probe measures the control it
	 * named and nothing else.
	 *
	 * @param controls The controls to ask for, or `undefined` when the caller asked for none.
	 * @returns The fields to spread into the request body, empty when no control was asked for.
	 */
	private static _controlFieldsOf(controls: GenerationControls | undefined): Record<string, unknown> {
		if (controls === undefined) {
			return {};
		}
		const fields: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(controls)) {
			if (value !== undefined) {
				fields[field] = value;
			}
		}
		return fields;
	}

	/**
	 * Sends one streamed chat completion request, writing each piece out as it arrives rather
	 * than waiting for the whole answer, and measuring when its characters arrived.
	 *
	 * An endpoint that ignores `stream: true` and answers with one whole JSON body instead is
	 * still measured rather than reported as a failure: the `openai` npm package reads such a
	 * body as a stream carrying no pieces at all, so an empty stream is followed by one whole
	 * request, whose first and last character then arrive at the same moment. The extra request
	 * is only ever sent to an endpoint that produced nothing the first time.
	 *
	 * @param options The client, the model identifier, the messages, and where to write each piece.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If neither the stream nor the whole request that follows it carried text.
	 */
	private static async _sendStreamed(options: SendCompletionOptions): Promise<CompletionResult> {
		const startedAt = performance.now();
		const { data: stream, response } = await options.client.chat.completions.create({
			model: options.modelId,
			messages: options.messages,
			stream: true,
			...(options.includeUsage === true ? { stream_options: { include_usage: true } } : {}),
			...CompletionSender._controlFieldsOf(options.controls),
		}).withResponse();
		const clusterTimeToFirstPieceMs = CompletionSender._readMsHeader(response, 'x-webai-time-to-first-piece-ms');

		let answer = '';
		let timeToFirstCharacterMs: number | undefined;
		let usage: ChatCompletionUsage | undefined;
		let finishReason: string | undefined;
		for await (const chunk of stream) {
			const finishReasonOfChunk = chunk.choices[0]?.finish_reason;
			if (finishReasonOfChunk !== undefined && finishReasonOfChunk !== null) {
				finishReason = finishReasonOfChunk;
			}
			const usageOfChunk = CompletionSender._toUsage(chunk.usage);
			if (usageOfChunk !== undefined) {
				usage = usageOfChunk;
			}
			const piece = chunk.choices[0]?.delta.content ?? '';
			if (piece === '') {
				continue;
			}
			if (timeToFirstCharacterMs === undefined) {
				timeToFirstCharacterMs = performance.now() - startedAt;
			}
			answer += piece;
			if (options.writePiece !== undefined) {
				options.writePiece(piece);
			}
		}
		const timeToLastCharacterMs = performance.now() - startedAt;

		if (answer === '') {
			return await CompletionSender._sendNostream(options);
		}

		return {
			answer,
			timeToFirstCharacterMs: timeToFirstCharacterMs ?? timeToLastCharacterMs,
			timeToLastCharacterMs,
			clusterGenerationTimeMs: undefined,
			clusterTimeToFirstPieceMs,
			usage,
			finishReason,
		};
	}

	/**
	 * Sends one whole chat completion request and measures how long the whole answer took. Its
	 * first and last character arrive at the same moment, because the endpoint sent the answer in
	 * one piece.
	 *
	 * @param options The client, the model identifier, the messages, and where to write the answer.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If the endpoint returned no answer text.
	 */
	private static async _sendNostream(options: SendCompletionOptions): Promise<CompletionResult> {
		const startedAt = performance.now();
		const { data: completion, response } = await options.client.chat.completions.create({
			model: options.modelId,
			messages: options.messages,
			...CompletionSender._controlFieldsOf(options.controls),
		}).withResponse();
		const elapsedMs = performance.now() - startedAt;
		const answer = completion.choices[0]?.message.content ?? '';
		if (answer === '') {
			throw new Error('the endpoint returned no answer text');
		}
		if (options.writePiece !== undefined) {
			options.writePiece(answer);
		}

		return {
			answer,
			timeToFirstCharacterMs: elapsedMs,
			timeToLastCharacterMs: elapsedMs,
			clusterGenerationTimeMs: CompletionSender._readMsHeader(response, 'x-webai-generation-time-ms'),
			clusterTimeToFirstPieceMs: undefined,
			usage: CompletionSender._toUsage(completion.usage),
			finishReason: completion.choices[0]?.finish_reason,
		};
	}

	/**
	 * Reads one millisecond figure this project's own `consumer_openai` server reports in a
	 * response header, under Rule 3 of its OpenAI compatibility requirement.
	 *
	 * @param response The raw response the `openai` npm package's transport received. Typed by
	 * the one method this needs, rather than by that transport's own `Response` type, since the
	 * `openai` npm package resolves to a different `Response` type than the rest of this
	 * repository depending on which fetch implementation Node.js chose.
	 * @param headerName The header to read.
	 * @returns The header's value, or `undefined` when the endpoint sent no such header, or sent
	 * one this tool cannot read as a plain number — which every endpoint other than this
	 * project's own `consumer_openai` server does.
	 */
	private static _readMsHeader(response: { headers: { get(name: string): string | null } }, headerName: string): number | undefined {
		const rawValue = response.headers.get(headerName);
		if (rawValue === null) {
			return undefined;
		}
		const value = Number(rawValue);
		return Number.isFinite(value) ? value : undefined;
	}

	/**
	 * Camel-cases the `openai` npm package's own usage object into `ChatCompletionUsage`.
	 *
	 * @param usage The usage object read from a response body or from a streamed chunk, `undefined`
	 * or `null` when the worker that produced the answer reported no usage.
	 * @returns The camelCased usage, or `undefined` when `usage` was `undefined` or `null`.
	 */
	private static _toUsage(usage: OpenAI.CompletionUsage | null | undefined): ChatCompletionUsage | undefined {
		if (usage === null || usage === undefined) {
			return undefined;
		}
		return {
			promptTokens: usage.prompt_tokens,
			completionTokens: usage.completion_tokens,
			totalTokens: usage.total_tokens,
		};
	}
}
