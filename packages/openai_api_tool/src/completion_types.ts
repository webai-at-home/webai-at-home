///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	completion_types — every data shape the three subcommands share
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sending One Request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One mode a chat completion request can be sent in. */
export type CompletionMode = 'nostream' | 'streamed';

/** Every mode a subcommand can sweep through, in the order they run for one model. */
export const completionModes: readonly CompletionMode[] = ['nostream', 'streamed'];

/** The endpoint one request is sent to. */
export type CompletionTarget = {
	/** The base URL of the OpenAI-compatible API, without `/chat/completions`. */
	readonly baseUrl: string;
	/** The bearer token sent to the endpoint. */
	readonly apiKey: string;
	/** How long one request may take before it is given up on, in milliseconds. */
	readonly timeoutMs: number;
};

/**
 * One chat completion answer's token usage, camelCased from the OpenAI-compatible response body's
 * own `prompt_tokens`/`completion_tokens`/`total_tokens` object.
 */
export type ChatCompletionUsage = {
	/** The number of tokens in the prompt sent. */
	readonly promptTokens: number;
	/** The number of tokens the answer was generated as. */
	readonly completionTokens: number;
	/** The sum of `promptTokens` and `completionTokens`. */
	readonly totalTokens: number;
};

/** What sending one request, given a full list of messages, produced. */
export type CompletionResult = {
	/** The complete assistant answer, concatenated from every streamed piece in the streamed mode. */
	readonly answer: string;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode, and equal to it as well
	 * when the endpoint ignored the streaming request and answered in one piece.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. */
	readonly timeToLastCharacterMs: number;
	/**
	 * How much of `timeToLastCharacterMs` was spent generating the whole answer inside the
	 * cluster, read from the `X-Webai-Generation-Time-Ms` response header, rather than measured
	 * by this tool's own stopwatch. Set only in the nostream mode, since only a whole-answer
	 * response can carry it — a streamed response sends its headers before the cluster has
	 * finished generating the rest of the answer. `undefined` when the endpoint sent no such
	 * header, which every endpoint other than this project's own `consumer_openai` server does.
	 */
	readonly clusterGenerationTimeMs: number | undefined;
	/**
	 * How much of `timeToFirstCharacterMs` was spent inside the cluster before its first piece
	 * was ready, read from the `X-Webai-Time-To-First-Piece-Ms` response header. Set only in the
	 * streamed mode. `undefined` when the endpoint sent no such header.
	 */
	readonly clusterTimeToFirstPieceMs: number | undefined;
	/**
	 * The answer's token usage, read straight from the response body in the nostream mode, or from
	 * the final, choice-less streamed chunk when the streamed mode asked for it with `stream_options:
	 * { include_usage: true }`. `undefined` when the worker that produced the answer reported no
	 * usage, or when the streamed mode did not ask for it.
	 */
	readonly usage: ChatCompletionUsage | undefined;
	/**
	 * The OpenAI Chat Completions interface's own reason the answer stopped, such as `stop` or
	 * `length`. `undefined` when the endpoint reported none.
	 */
	readonly finishReason: string | undefined;
	/**
	 * The tool calls the model asked for, in the order the endpoint reported them, assembled from
	 * the streamed fragments in the streamed mode. Empty when the model answered in words instead,
	 * which is every request that declared no tool at all.
	 */
	readonly toolCalls: readonly ChatCompletionToolCall[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Sweeping Across Models
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How one swept model and mode pair turned out. */
export type SweepStatus = 'ok' | 'failed' | 'skipped';

/** One message of a conversation `history` sent, in the order it was sent. */
export type SweepTurn = {
	/** Who sent the message. */
	readonly role: 'user' | 'assistant';
	/** The message text. */
	readonly content: string;
};

/** What sweeping one model and one mode produced, for `completion` and `history`. */
export type SweepOutcome = {
	/** The model identifier swept. */
	readonly modelId: string;
	/** The mode swept. */
	readonly mode: CompletionMode;
	/**
	 * `ok` once the model answered with usable text, `failed` once it did not, and `skipped`
	 * for a pairing known ahead of the request not to work, such as `dev_formula` asked to
	 * stream, so that a permanent, documented restriction of the cluster does not read as a
	 * failure of this run.
	 */
	readonly status: SweepStatus;
	/**
	 * Elapsed time, in milliseconds, from the request being sent until the first character
	 * arrived. Equal to `timeToLastCharacterMs` in the nostream mode. `0` when skipped.
	 */
	readonly timeToFirstCharacterMs: number;
	/** Elapsed time, in milliseconds, from the request being sent until the final character arrived. `0` when skipped. */
	readonly timeToLastCharacterMs: number;
	/** The number of characters of the answer, `0` when not `ok`. */
	readonly characterCount: number;
	/** The raw answer text, already printed as it was produced. Empty when not `ok`. */
	readonly answer: string;
	/**
	 * How much of `timeToLastCharacterMs` the cluster reported spending on generation, carried
	 * over from `CompletionResult.clusterGenerationTimeMs`. Set only for an `ok` pairing in the
	 * nostream mode, against an endpoint that sent the header. `undefined` otherwise.
	 */
	readonly clusterGenerationTimeMs?: number | undefined;
	/**
	 * How much of `timeToFirstCharacterMs` the cluster reported spending before its first piece
	 * was ready, carried over from `CompletionResult.clusterTimeToFirstPieceMs`. Set only for an
	 * `ok` pairing in the streamed mode, against an endpoint that sent the header. `undefined`
	 * otherwise.
	 */
	readonly clusterTimeToFirstPieceMs?: number | undefined;
	/** Why the pair failed or was skipped, `undefined` on success. */
	readonly failureMessage: string | undefined;
	/**
	 * Every message of the conversation, in the order it was sent, as far as the sweep got. Only
	 * `history` sets this, since it is the only subcommand that sends a whole conversation rather
	 * than one prompt; left out entirely for `completion`, rather than set to `undefined`, so it
	 * does not appear in a `completion` sweep's JSON report.
	 */
	readonly turns?: readonly SweepTurn[];
};

/** What sweeping one model and one mode produced, for `usage`. */
export type UsageOutcome = {
	/** The model identifier swept. */
	readonly modelId: string;
	/** The mode swept. */
	readonly mode: CompletionMode;
	/**
	 * `ok` once the model answered with usable text, `failed` once it did not, and `skipped`
	 * for a pairing known ahead of the request not to work, such as `dev_formula` asked to
	 * stream, so that a permanent, documented restriction of the cluster does not read as a
	 * failure of this run.
	 */
	readonly status: SweepStatus;
	/** Whether the answer carried a `usage` object at all. `false` when not `ok`. */
	readonly usagePresent: boolean;
	/** The answer's token usage, `undefined` when not `ok` or when the answer carried no `usage` object. */
	readonly usage: ChatCompletionUsage | undefined;
	/** The OpenAI Chat Completions interface's own reason the answer stopped, `undefined` when not `ok`. */
	readonly finishReason: string | undefined;
	/** Why the pair failed or was skipped, `undefined` on success. */
	readonly failureMessage: string | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Measuring Latency
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One statistic computed over a set of measured samples. */
export type MetricStatistics = {
	/** The arithmetic mean of the measured values. */
	readonly average: number;
	/** The middle measured value, or the mean of the two middle values. */
	readonly median: number;
	/** The smallest measured value. */
	readonly minimum: number;
	/** The largest measured value. */
	readonly maximum: number;
};

/**
 * The result of one measured request.
 *
 * These five figures are all directly observable from the client side: none of them needs
 * knowledge of the model or its tokenizer, which is what keeps them comparable across
 * different providers and APIs.
 */
export type BenchmarkSample = {
	/** The one-based measured request number. */
	readonly run: number;
	/**
	 * Time to First Character: elapsed time, in milliseconds, from the request being sent until
	 * the first streamed character arrived. Measures perceived responsiveness.
	 */
	readonly timeToFirstCharacterMs: number;
	/**
	 * Time to Last Character: elapsed time, in milliseconds, from the request being sent until
	 * the final character arrived. Measures end-to-end request latency.
	 */
	readonly timeToLastCharacterMs: number;
	/**
	 * Output Characters per Second: the speed at which the endpoint streamed the answer after
	 * its first character, computed as `outputCharacters / (the Time to Last Character minus
	 * the Time to First Character, in seconds)`.
	 */
	readonly outputCharactersPerSecond: number;
	/** Input Characters: the number of characters sent in the request prompt. */
	readonly inputCharacters: number;
	/** Output Characters: the number of characters generated in the response. */
	readonly outputCharacters: number;
};

/** The aggregate measurements for one measured model on one endpoint. */
export type BenchmarkSummary = {
	/** The base URL of the endpoint measured. */
	readonly baseUrl: string;
	/** The model identifier measured on that endpoint. */
	readonly modelId: string;
	/** The measured samples, in request order. */
	readonly samples: readonly BenchmarkSample[];
	/** Time to First Character, across the measured samples. */
	readonly timeToFirstCharacterMs: MetricStatistics;
	/** Time to Last Character, across the measured samples. */
	readonly timeToLastCharacterMs: MetricStatistics;
	/** Output Characters per Second, across the measured samples. */
	readonly outputCharactersPerSecond: MetricStatistics;
	/** Input Characters sent in the prompt, the same for every sample since one prompt is sent every time. */
	readonly inputCharacters: number;
	/** Output Characters generated in the response, across the measured samples. */
	readonly outputCharacters: MetricStatistics;
};

/** The full benchmark report, holding one summary per measured model. */
export type BenchmarkReport = {
	/** The benchmark settings that affect comparability with another run. */
	readonly settings: {
		/** The one prompt sent to the endpoint. */
		readonly prompt: string;
		/** The number of measured requests per model. */
		readonly runs: number;
		/** The number of unreported warm-up requests per model. */
		readonly warmupRuns: number;
		/** The number of requests in flight at any moment, always one. */
		readonly parallelism: 1;
	};
	/** The aggregate measurements, one entry per measured model, in the order they were measured. */
	readonly summaries: readonly BenchmarkSummary[];
};

/** The ways a benchmark report, or a completion/history sweep report, can be written out. */
export type ReportFormat = 'text' | 'markdown' | 'json';

/** Every format all three subcommands accept, in the order the help text lists them. */
export const reportFormats: readonly ReportFormat[] = ['text', 'markdown', 'json'];

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Generation Controls
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The generation controls one request asks for, each spelled the way the OpenAI Chat Completions
 * interface spells it on the connection.
 *
 * These spellings are what the endpoint reads, so they are not renamed to match this
 * repository's own naming rules, exactly as the response body field names above are not.
 */
export type GenerationControls = {
	/** How much the model may prefer a less likely next token, from `0` to `2`. */
	readonly temperature?: number;
	/** The share of the probability mass the next token is drawn from, from just above `0` to `1`. */
	readonly top_p?: number;
	/** The largest number of tokens the whole answer may be generated as. */
	readonly max_completion_tokens?: number;
	/**
	 * The older spelling of `max_completion_tokens` on this interface.
	 *
	 * Both spellings are sent because an endpoint may read one and not the other. LM Studio 0.4.20
	 * reads both; an endpoint that reads only the older one still honours this control, which the
	 * `generation_controls` probe finds and reports rather than concluding the endpoint honours
	 * neither.
	 */
	readonly max_tokens?: number;
	/** The pieces of text that end the answer as soon as the model writes one of them. */
	readonly stop?: readonly string[];
	/** The number that decides every random choice made while the answer is generated. */
	readonly seed?: number;
};

/** Every generation control `openai_api_tool` probes, named as the request field it is sent in. */
export const generationControlFields = ['temperature', 'top_p', 'max_completion_tokens', 'stop', 'seed'] as const;

/** One generation control this tool probes, named as the request field it is sent in. */
export type GenerationControlField = typeof generationControlFields[number];

/**
 * What probing one generation control against one model and one mode concluded.
 *
 * - `honoured` — the answers changed in the way the control is supposed to change them.
 * - `not_honoured` — the endpoint accepted the control and the answers did not change, which is
 *   the failure this probe exists to catch: a control accepted and quietly ignored looks exactly
 *   like a control that works until it is measured.
 * - `refused` — the endpoint answered that this model cannot honour the control. That is a
 *   correct answer, not a fault: it is what this project's own `consumer_openai` server does
 *   rather than ignoring a control. See milestone 4 of
 *   [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
 * - `inconclusive` — the runs cannot tell the two apart, such as a model answering identically
 *   whatever seed it is given, so nothing is claimed either way.
 * - `failed` — a request did not produce an answer at all, so the control was never tested.
 */
export const generationControlStatuses = ['honoured', 'not_honoured', 'refused', 'inconclusive', 'failed'] as const;

/** What probing one generation control against one model and one mode concluded. */
export type GenerationControlStatus = typeof generationControlStatuses[number];

/** What probing one generation control against one model and one mode produced. */
export type GenerationControlOutcome = {
	/** The model identifier probed. */
	readonly modelId: string;
	/** The mode probed. */
	readonly mode: CompletionMode;
	/** The control probed, named as the request field it was sent in. */
	readonly control: GenerationControlField;
	/** What the probe concluded. */
	readonly status: GenerationControlStatus;
	/** What was observed, in words, naming the numbers the conclusion was drawn from. */
	readonly observation: string;
	/** The answers the probe's requests produced, in the order they were sent, so a reader can check the conclusion. */
	readonly answers: readonly string[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tool Calls
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One tool a request declares, spelled the way the OpenAI Chat Completions interface spells it on
 * the connection.
 *
 * These spellings are what the endpoint reads, so they are not renamed to match this repository's
 * own naming rules, exactly as the generation control field names above are not.
 */
export type ToolDeclaration = {
	/** The kind of tool. This interface defines only `function`. */
	readonly type: 'function';
	/** The function the model may ask to have called. */
	readonly function: {
		/** The name the model writes when it asks for this tool. */
		readonly name: string;
		/** What the tool does, in the words the model reads when it decides whether to ask for it. */
		readonly description: string;
		/** The arguments the tool takes, as a JSON Schema object. */
		readonly parameters: Record<string, unknown>;
	};
};

/**
 * How much choice the request leaves the model about asking for a tool, spelled the way the OpenAI
 * Chat Completions interface spells it.
 *
 * - `auto` — the model decides whether to ask for a tool or to answer in words.
 * - `required` — the model must ask for a tool. This is the value that tells a model that chose
 *   plain text apart from a server that never offered the model the choice at all.
 * - `none` — the model must answer in words even though tools were declared.
 */
export type ToolChoice = 'auto' | 'required' | 'none';

/** One tool call the model asked for, camelCased from the OpenAI-compatible response body. */
export type ChatCompletionToolCall = {
	/** The identifier the tool's result is sent back under, in a message whose role is `tool`. */
	readonly id: string;
	/** The name of the function the model asked to have called. */
	readonly name: string;
	/**
	 * The arguments the model filled in, exactly as it generated them, which this interface carries
	 * as a string of JSON rather than as an object. It is left unparsed here because a model does
	 * not always generate valid JSON, and whether it did is one of the things the probes report.
	 */
	readonly argumentsJson: string;
};

/**
 * Every ability `openai_api_tool` probes a model for, in the order the probes run.
 *
 * They are separate abilities rather than one, which is the whole reason this subcommand exists:
 * the de-risk gate of [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) found
 * one server that read the tool wire format correctly, accepted the tool declarations without
 * complaining, and still never generated a single tool call — so "tool calling works" is not a
 * question with one answer.
 *
 * - `generates_a_call` — asked a question a declared tool answers, the model asks for that tool
 *   rather than answering in words.
 * - `generates_a_call_when_forced` — the same, with `tool_choice: "required"`, which leaves the
 *   model no choice. This is the decisive probe: a model that writes plain text here was never
 *   given the option of not calling a tool, so the failure cannot be explained as the model having
 *   preferred to answer in words.
 * - `fills_in_the_arguments` — the tool call it generated carries arguments that parse as JSON and
 *   hold the value the question named.
 * - `chooses_among_several_tools` — with more than one tool declared, it asks for the one that
 *   answers the question rather than one of the others.
 * - `reads_a_tool_result_back` — given a conversation that already contains a tool call and that
 *   tool's result, it answers from the result. Generating a call and reading one back are two
 *   different abilities, and a model can have the second without the first.
 * - `answers_without_a_call_when_none_is_needed` — with a tool declared and a question that needs
 *   no tool, it answers in words. This is the negative control that proves the endpoint read the
 *   request at all, so that an endpoint failing every other probe is not mistaken for one that is
 *   refusing the tool wire format outright.
 */
export const toolCallAbilities = [
	'generates_a_call',
	'generates_a_call_when_forced',
	'fills_in_the_arguments',
	'chooses_among_several_tools',
	'reads_a_tool_result_back',
	'answers_without_a_call_when_none_is_needed',
] as const;

/** One ability `openai_api_tool` probes a model for. */
export type ToolCallAbility = typeof toolCallAbilities[number];

/**
 * What probing one tool call ability against one model and one mode concluded.
 *
 * - `supported` — the model did what the ability names.
 * - `unsupported` — the endpoint accepted the request and the model did not. This is the finding
 *   this subcommand exists to catch, and the one the de-risk gate of
 *   [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) reached.
 * - `refused` — the endpoint answered that it will not take tool declarations at all, naming
 *   `tools` or `tool_choice` as the field at fault. That is a correct answer about the endpoint,
 *   not a fault in this run.
 * - `inconclusive` — the run cannot tell the two apart, such as an arguments probe against a model
 *   that generated no tool call for the arguments to be read from.
 * - `failed` — a request did not produce an answer at all, so the ability was never tested.
 */
export const toolCallStatuses = ['supported', 'unsupported', 'refused', 'inconclusive', 'failed'] as const;

/** What probing one tool call ability against one model and one mode concluded. */
export type ToolCallStatus = typeof toolCallStatuses[number];

/** What probing one tool call ability against one model and one mode produced. */
export type ToolCallOutcome = {
	/** The model identifier probed. */
	readonly modelId: string;
	/** The mode probed. */
	readonly mode: CompletionMode;
	/** The ability probed. */
	readonly ability: ToolCallAbility;
	/** What the probe concluded. */
	readonly status: ToolCallStatus;
	/** What was observed, in words, naming what the conclusion was drawn from. */
	readonly observation: string;
	/**
	 * Every answer the probe's requests produced, in the order they were sent, so a reader can check
	 * the conclusion against what the model really wrote rather than taking it on trust. A request
	 * the model answered with a tool call is recorded as the call it asked for.
	 */
	readonly answers: readonly string[];
};
