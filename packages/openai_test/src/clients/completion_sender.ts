// npm imports
import OpenAI, { APIError } from 'openai';

// local imports
import type {
	ChatCompletionToolCall,
	ChatCompletionUsage,
	StreamSetting,
	ThinkingSetting,
	CompletionResult,
	CompletionTarget,
	GenerationControls,
	ToolChoice,
	ToolDeclaration,
} from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CompletionSender — the one way this package sends a chat completion request and times it
//
//	Every subcommand goes through this class, so `conformance`, `benchmark`, and `chat` cannot
//	drift apart in how they talk to an endpoint or in what their timings mean.
//	Nothing in this file builds a request body, parses a server-sent event, or reads a response
//	body by hand: the `openai` npm package does all of that. Reaching an endpoint any other way
//	belongs in `raw_http_client.ts`, and nowhere else.
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
	readonly streamSetting: StreamSetting;
	/**
	 * Whether to let the model think before it answers. Left out by every caller other than
	 * `benchmark`, so `conformance` and `chat` keep sending the exact request they always have.
	 */
	readonly thinkingSetting?: ThinkingSetting;
	/**
	 * Called with each piece of the answer as it arrives, so a subcommand that shows the answer
	 * to a person can write it out while it is being produced. Left out by the benchmark, which
	 * measures rather than shows.
	 */
	readonly writePiece?: (piece: string) => void;
	/**
	 * Whether to ask a streamed answer for its final, choice-less usage chunk with
	 * `stream_options: { include_usage: true }`. Left out by every caller other than the `usage`
	 * subcommand, so `completion`, `history`, and `benchmark` keep sending the exact request they
	 * always have. Has no effect with streaming off, which reports `usage` in its response body
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
	/**
	 * The tools to declare to the model, each spelled the way the OpenAI Chat Completions interface
	 * spells it. Left out by every caller other than the `tool_calls` subcommand, so `completion`,
	 * `history`, `benchmark`, `usage`, and `generation_controls` keep sending the exact request they
	 * always have.
	 */
	readonly tools?: readonly ToolDeclaration[];
	/**
	 * How much choice the request leaves the model about asking for a tool. Sent only alongside
	 * `tools`, since this interface defines it only for a request that declares tools.
	 */
	readonly toolChoice?: ToolChoice;
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
	 * Sends one chat completion request in the requested stream setting and measures when its first and
	 * last character arrived.
	 *
	 * @param options The client, the model identifier, the messages, the stream setting, and where to write
	 * each piece of the answer as it arrives.
	 * @returns The answer and when its characters arrived.
	 * @throws {Error} If the endpoint returned no answer text at all, or if it answered as a model
	 * other than the one that was requested.
	 */
	static async send(options: SendCompletionOptions): Promise<CompletionResult> {
		let result: CompletionResult;
		if (options.streamSetting === 'on') {
			result = await CompletionSender._sendStreamed(options);
		} else {
			result = await CompletionSender._sendNostream(options);
		}
		CompletionSender.assertReportedModelId(options.modelId, result.reportedModelId);
		return result;
	}

	/**
	 * Fails the request when the endpoint answered as a model other than the one that was requested.
	 *
	 * This exists because an endpoint answering as the wrong model is not always an error the
	 * endpoint reports. LM Studio 0.4.20 answers a request naming a model it cannot serve with
	 * HTTP 200 generated by whichever model is loaded, and the only sign of it is the `model` field
	 * of the answer. Without this check every measurement this package produces could be recorded
	 * under a model that never produced it. See
	 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
	 *
	 * @param requestedModelId The model identifier the request named.
	 * @param reportedModelId The model identifier the endpoint named in its answer, `undefined` when
	 * it named none.
	 * @returns Nothing.
	 * @throws {Error} If the endpoint named a model that is neither the requested one nor a longer
	 * form of it.
	 */
	static assertReportedModelId(requestedModelId: string, reportedModelId: string | undefined): void {
		if (CompletionSender.isReportedModelIdAcceptable(requestedModelId, reportedModelId) === true) {
			return;
		}
		throw new Error(
			`the endpoint answered as "${String(reportedModelId)}" for a request naming "${requestedModelId}", so this answer was produced by a model nobody asked for`,
		);
	}

	/**
	 * Reports whether the model identifier the endpoint named answers for the one that was requested.
	 *
	 * Two forms are accepted. An endpoint that names exactly the requested identifier answers for it.
	 * An endpoint that names the requested identifier followed by a dash and more characters also
	 * answers for it, which is how a provider resolves an alias to a dated release — `gpt-4.1-mini`
	 * answered as `gpt-4.1-mini-2025-04-14`.
	 *
	 * That second form is confirmed against `api.openai.com` itself: a request naming `gpt-4.1-mini`
	 * is answered with `"model": "gpt-4.1-mini-2025-04-14"`, which would otherwise fail this check
	 * and throw away a measurement the endpoint made correctly. See Milestone 7 of
	 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208) for the raw answer.
	 * LM Studio names the requested identifier exactly, so it never exercises this form.
	 *
	 * A shorter identifier than the one requested is never accepted, since `gpt-4.1-mini` answering
	 * a request for `gpt-4.1-mini-2025-04-14` names a model other than the one that was asked for.
	 *
	 * @param requestedModelId The model identifier the request named.
	 * @param reportedModelId The model identifier the endpoint named in its answer, `undefined` when
	 * it named none.
	 * @returns `true` when the answer may be recorded under the requested identifier.
	 */
	static isReportedModelIdAcceptable(requestedModelId: string, reportedModelId: string | undefined): boolean {
		// An endpoint that names no model at all cannot be caught out, and there is nothing to compare.
		if (reportedModelId === undefined) {
			return true;
		}
		if (reportedModelId === requestedModelId) {
			return true;
		}
		return reportedModelId.startsWith(`${requestedModelId}-`);
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
	 * Reads which request field the endpoint named as the one at fault, when it named one.
	 *
	 * This is how a refusal of the tool declarations themselves is told apart from a request that
	 * failed for any other reason: an endpoint that will not take tools at all answers naming
	 * `tools` or `tool_choice`, which is a correct answer about that endpoint rather than a fault in
	 * the run that asked.
	 *
	 * @param error The error caught around one request.
	 * @returns The endpoint's own `param`, or `undefined` when the failure named no field.
	 */
	static failureParam(error: unknown): string | undefined {
		if (error instanceof APIError && typeof error.param === 'string') {
			return error.param;
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
	 * Builds the thinking field of one request body.
	 *
	 * `off` sends `reasoning_effort: "none"`, which is the one spelling both Ollama 0.17 and LM
	 * Studio 0.4.20 honour: measured live against `gemma4:e2b` on both, four requests each produced
	 * no reasoning at all and reached their first character in under 600 ms, against 2662 to 4618 ms
	 * and 366 to 523 characters of reasoning without it. `think: false`, `reasoning_effort: "low"`,
	 * `reasoning_effort: "minimal"`, and `chat_template_kwargs: { enable_thinking: false }` were all
	 * tried against the same model and left it thinking.
	 *
	 * `on`, and a caller that names no setting at all, send no field whatsoever, so that every
	 * request `conformance` and `chat` sent before this existed is byte for byte the request they
	 * still send.
	 *
	 * @param thinkingSetting Whether to let the model think, or `undefined` to leave it to the
	 * endpoint's own default.
	 * @returns The fields to spread into the request body, empty unless thinking is turned off.
	 */
	private static _thinkingFieldsOf(thinkingSetting: ThinkingSetting | undefined): Record<string, unknown> {
		if (thinkingSetting !== 'off') {
			return {};
		}
		// Typed as a loose record rather than passed as a literal, because `openai` 4.104.0 types
		// `reasoning_effort` as low, medium, or high alone, and `none` is what these endpoints read.
		return {
			reasoning_effort: 'none',
		};
	}

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
	 * Builds the tool declaration fields of one request body.
	 *
	 * A caller that declared no tool produces no field at all, so every request this package sent
	 * before tool calling existed is byte for byte the request it still sends. `tool_choice` is sent
	 * only alongside `tools`, because this interface defines it only for a request that declares
	 * tools.
	 *
	 * @param tools The tools to declare, or `undefined` when the caller declared none.
	 * @param toolChoice How much choice to leave the model, or `undefined` to let the endpoint apply
	 * its own default.
	 * @returns The fields to spread into the request body, empty when no tool was declared.
	 */
	private static _toolFieldsOf(tools: readonly ToolDeclaration[] | undefined, toolChoice: ToolChoice | undefined): Record<string, unknown> {
		if (tools === undefined || tools.length === 0) {
			return {};
		}
		if (toolChoice === undefined) {
			return {
				tools,
			};
		}
		return {
			tools,
			tool_choice: toolChoice,
		};
	}

	/**
	 * Camel-cases the `openai` npm package's own tool call objects into `ChatCompletionToolCall`.
	 *
	 * @param toolCalls The tool calls read from a response body, `undefined` when the model asked for
	 * none.
	 * @returns The camelCased tool calls, empty when the model asked for none.
	 */
	private static _toToolCalls(toolCalls: OpenAI.ChatCompletionMessageToolCall[] | undefined): ChatCompletionToolCall[] {
		if (toolCalls === undefined) {
			return [];
		}
		return toolCalls.map((toolCall) => ({
			id: toolCall.id,
			name: toolCall.function.name,
			argumentsJson: toolCall.function.arguments,
		}));
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
			...CompletionSender._thinkingFieldsOf(options.thinkingSetting),
			...CompletionSender._controlFieldsOf(options.controls),
			...CompletionSender._toolFieldsOf(options.tools, options.toolChoice),
		}).withResponse();
		const clusterTimeToFirstPieceMs = CompletionSender._readMsHeader(response, 'x-webai-time-to-first-piece-ms');

		let answer = '';
		let reportedModelId: string | undefined;
		let timeToFirstCharacterMs: number | undefined;
		let usage: ChatCompletionUsage | undefined;
		let finishReason: string | undefined;
		const toolCallsByIndex = new Map<number, { id: string; name: string; argumentsJson: string }>();
		for await (const chunk of stream) {
			// Read before the empty-piece check below, since a chunk carrying no text still names its model.
			if (reportedModelId === undefined) {
				reportedModelId = chunk.model;
			}
			const finishReasonOfChunk = chunk.choices[0]?.finish_reason;
			if (finishReasonOfChunk !== undefined && finishReasonOfChunk !== null) {
				finishReason = finishReasonOfChunk;
			}
			const usageOfChunk = CompletionSender._toUsage(chunk.usage);
			if (usageOfChunk !== undefined) {
				usage = usageOfChunk;
			}
			CompletionSender._collectToolCallFragments(chunk.choices[0]?.delta.tool_calls, toolCallsByIndex);
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

		// A model that asked for a tool wrote no text at all, and that is a complete answer rather
		// than an empty one. Only a stream that carried neither text nor a tool call is retried as one
		// whole request, which is what an endpoint ignoring `stream: true` produces.
		const toolCalls = [...toolCallsByIndex.entries()].sort(([left], [right]) => left - right).map(([, toolCall]) => toolCall);
		if (answer === '' && toolCalls.length === 0) {
			return await CompletionSender._sendNostream(options);
		}

		return {
			answer,
			reportedModelId,
			timeToFirstCharacterMs: timeToFirstCharacterMs ?? timeToLastCharacterMs,
			timeToLastCharacterMs,
			clusterGenerationTimeMs: undefined,
			clusterTimeToFirstPieceMs,
			usage,
			finishReason,
			toolCalls,
		};
	}

	/**
	 * Merges the tool call fragments of one streamed chunk into the tool calls assembled so far.
	 *
	 * This interface streams a tool call in pieces the same way it streams text: the name arrives
	 * once and the arguments arrive a fragment at a time, each carrying the `index` of the tool call
	 * it belongs to, so several tool calls can be streamed at once and interleaved.
	 *
	 * @param fragments The tool call fragments of one chunk, `undefined` when it carried none.
	 * @param toolCallsByIndex The tool calls assembled so far, keyed by their index, updated in place.
	 * @returns Nothing.
	 */
	private static _collectToolCallFragments(
		fragments: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined,
		toolCallsByIndex: Map<number, { id: string; name: string; argumentsJson: string }>,
	): void {
		if (fragments === undefined) {
			return;
		}
		for (const fragment of fragments) {
			const assembled = toolCallsByIndex.get(fragment.index) ?? {
				id: '',
				name: '',
				argumentsJson: '',
			};
			if (fragment.id !== undefined) {
				assembled.id = fragment.id;
			}
			if (fragment.function?.name !== undefined) {
				assembled.name += fragment.function.name;
			}
			if (fragment.function?.arguments !== undefined) {
				assembled.argumentsJson += fragment.function.arguments;
			}
			toolCallsByIndex.set(fragment.index, assembled);
		}
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
			...CompletionSender._thinkingFieldsOf(options.thinkingSetting),
			...CompletionSender._controlFieldsOf(options.controls),
			...CompletionSender._toolFieldsOf(options.tools, options.toolChoice),
		}).withResponse();
		const elapsedMs = performance.now() - startedAt;
		const answer = completion.choices[0]?.message.content ?? '';
		const toolCalls = CompletionSender._toToolCalls(completion.choices[0]?.message.tool_calls);
		// A model that asked for a tool wrote no text at all, which is a complete answer and not a
		// missing one, so only an answer carrying neither text nor a tool call is a failure.
		if (answer === '' && toolCalls.length === 0) {
			throw new Error('the endpoint returned no answer text');
		}
		if (options.writePiece !== undefined && answer !== '') {
			options.writePiece(answer);
		}

		return {
			answer,
			reportedModelId: completion.model,
			timeToFirstCharacterMs: elapsedMs,
			timeToLastCharacterMs: elapsedMs,
			clusterGenerationTimeMs: CompletionSender._readMsHeader(response, 'x-webai-generation-time-ms'),
			clusterTimeToFirstPieceMs: undefined,
			usage: CompletionSender._toUsage(completion.usage),
			finishReason: completion.choices[0]?.finish_reason,
			toolCalls,
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
