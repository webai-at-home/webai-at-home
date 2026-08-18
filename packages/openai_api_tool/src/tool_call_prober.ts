// npm imports
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from './completion_sender.js';
import type {
	ChatCompletionToolCall,
	CompletionMode,
	ToolCallAbility,
	ToolCallOutcome,
	ToolChoice,
	ToolDeclaration,
} from './completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallProber — proves, one ability at a time, whether a model really calls tools
//
//	The de-risk gate of
//	[issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) failed against one server
//	and one model build, and the finding was precise: the tool wire format was read correctly, the
//	tool declarations were accepted without complaint, `tool_choice: "required"` was accepted too,
//	and the model still never generated a single tool call. That is why this class probes six
//	separate abilities rather than asking one question. An endpoint that accepts a tool declaration
//	and never calls a tool looks exactly like an endpoint that supports tool calling, until a call
//	is asked for and counted.
//
//	No probe here sends a generation control. This project's own `consumer_openai` server refuses a
//	request asking a model for a control it cannot honour, so a `temperature: 0` added for
//	determinism would turn every probe against the cluster into a refusal about temperature, which
//	says nothing whatever about tool calls.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one run of {@link ToolCallProber.probeAll} needs. */
export type ToolCallProbeOptions = {
	/** The OpenAI client pointed at the endpoint under test. */
	readonly client: OpenAI;
	/** The model identifier to request. */
	readonly modelId: string;
	/** Whether to ask for the answer as it is written, or in one piece. */
	readonly mode: CompletionMode;
	/**
	 * How many times a probe that needs a tool call, or that needs the answer to carry a particular
	 * word, sends its prompt before giving up on getting one.
	 *
	 * Whether a model asks for a tool is a choice it makes afresh each time, so one request that
	 * produced no call is weak evidence where one request that produced a call is strong evidence.
	 * Sending the prompt several times and reporting how many of them produced a call is the
	 * difference between "this model cannot call tools" and "this model calls tools once in three
	 * tries", which are two very different findings and look identical after a single request.
	 *
	 * Whether an answer repeats a word the tool result gave it is the same kind of choice, made
	 * afresh each time, which is why `_probeReadsAToolResultBack` repeats its prompt too.
	 */
	readonly repeats: number;
};

/** One answer, or the failure that came instead of it. */
type ProbeAnswer = {
	/** The answer text, empty when the model asked for a tool instead of writing words, or when the request failed. */
	readonly text: string;
	/** The tool calls the model asked for, empty when it answered in words or when the request failed. */
	readonly toolCalls: readonly ChatCompletionToolCall[];
	/** The OpenAI `finish_reason` the endpoint reported, `undefined` when it reported none. */
	readonly finishReason: string | undefined;
	/** Why the request failed, `undefined` when it succeeded. */
	readonly failureMessage: string | undefined;
	/** The endpoint's own explanation of the failure, in its own words, `undefined` when it succeeded. */
	readonly failureExplanation: string | undefined;
	/** The request field the endpoint named as the one at fault, `undefined` when it named none. */
	readonly failureParam: string | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Tools Declared, And The Questions Asked About Them
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The city every probe asks about, so the arguments probe knows the value it is looking for. */
const probedCity = 'Paris';

/** The temperature in degrees celsius the tool result probe feeds back, chosen so no model could have known it. */
const probedTemperatureCelsius = '31';

/** The one word the negative control asks for, short enough that any model can write it exactly. */
const probedWord = 'hello';

/** The tool the elicitation and arguments probes declare, which answers the question they ask. */
const weatherTool: ToolDeclaration = {
	type: 'function',
	function: {
		name: 'get_current_weather',
		description: 'Reports the current weather in one city. Call this whenever the current weather somewhere is asked about.',
		parameters: {
			type: 'object',
			properties: {
				city: {
					type: 'string',
					description: 'The name of the city to report the current weather in, such as Paris.',
				},
			},
			required: ['city'],
		},
	},
};

/** The tool the selection probe's question is about, declared beside two that it is not about. */
const timeTool: ToolDeclaration = {
	type: 'function',
	function: {
		name: 'get_current_time',
		description: 'Reports the current time of day in one city. Call this whenever the current time somewhere is asked about.',
		parameters: {
			type: 'object',
			properties: {
				city: {
					type: 'string',
					description: 'The name of the city to report the current time in, such as Paris.',
				},
			},
			required: ['city'],
		},
	},
};

/** A third tool, declared only so that the selection probe offers a wrong answer to choose. */
const stockPriceTool: ToolDeclaration = {
	type: 'function',
	function: {
		name: 'get_stock_price',
		description: 'Reports the latest traded price of one company share. Call this whenever a share price is asked about.',
		parameters: {
			type: 'object',
			properties: {
				ticker: {
					type: 'string',
					description: 'The stock market symbol of the company, such as ACME.',
				},
			},
			required: ['ticker'],
		},
	},
};

/** The questions the probes ask. */
const prompts = {
	/** A question the declared weather tool answers and the model cannot answer on its own. */
	weather: `What is the current weather in ${probedCity}?`,
	/** A question the declared time tool answers, asked with three tools declared. */
	time: `What is the current time in ${probedCity}?`,
	/** A question that needs no tool at all, which the negative control asks with a tool declared. */
	noToolNeeded: `Reply with exactly the word ${probedWord}, and nothing else.`,
} as const;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Proves, one ability at a time, whether a model really calls tools through an OpenAI-compatible endpoint. */
export class ToolCallProber {
	/**
	 * Probes all six tool call abilities against one model and one mode, in the order they are
	 * declared, and reports what each probe concluded.
	 *
	 * The probes run one after another rather than together, because a shared endpoint answering
	 * several at once would queue them behind each other anyway, and a model held on one device can
	 * only generate one answer at a time.
	 *
	 * @param options The client, the model identifier, the mode, and how many times a probe that
	 * needs a tool call sends its prompt before giving up on getting one.
	 * @returns One outcome per ability, in the order the abilities are declared.
	 */
	static async probeAll(options: ToolCallProbeOptions): Promise<ToolCallOutcome[]> {
		return [
			await ToolCallProber._probeGeneratesACall(options),
			await ToolCallProber._probeGeneratesACallWhenForced(options),
			await ToolCallProber._probeFillsInTheArguments(options),
			await ToolCallProber._probeChoosesAmongSeveralTools(options),
			await ToolCallProber._probeReadsAToolResultBack(options),
			await ToolCallProber._probeAnswersWithoutACallWhenNoneIsNeeded(options),
		];
	}

	/**
	 * Writes one answer out as the single line recorded in an outcome: the tool calls it asked for,
	 * or the text it wrote when it asked for none.
	 *
	 * @param text The answer text, empty when the model asked for a tool instead.
	 * @param toolCalls The tool calls the model asked for, empty when it answered in words.
	 * @returns The one line to record.
	 */
	static describeAnswer(text: string, toolCalls: readonly ChatCompletionToolCall[]): string {
		if (toolCalls.length === 0) {
			return text;
		}
		return toolCalls.map((toolCall) => `tool call ${toolCall.name}(${toolCall.argumentsJson})`).join(' ');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Six Probes
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Probes whether the model asks for a tool at all: one tool declared that answers the question,
	 * and `tool_choice: "auto"`, so the model chooses for itself.
	 *
	 * Sent several times, because asking for a tool is a choice the model makes afresh each time.
	 * Supported once any one of the requests produced a call, and the observation names how many of
	 * them did, so a model that calls tools unreliably is not recorded as a model that cannot.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeGeneratesACall(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		const asked = await ToolCallProber._askRepeatedly(options, [weatherTool], 'auto', prompts.weather);
		const failure = ToolCallProber._failureOf(options, 'generates_a_call', asked);
		if (failure !== undefined) {
			return failure;
		}
		const withACall = asked.filter((answer) => answer.toolCalls.length > 0);
		if (withACall.length === 0) {
			return ToolCallProber._outcome(
				options,
				'generates_a_call',
				'unsupported',
				`the endpoint accepted the tool declaration and the model answered in words all ${asked.length} times, asking for no tool`,
				asked,
			);
		}
		return ToolCallProber._outcome(
			options,
			'generates_a_call',
			'supported',
			`${withACall.length} of ${asked.length} answers asked for ${ToolCallProber._namesOf(withACall)}`,
			asked,
		);
	}

	/**
	 * Probes whether the model asks for a tool when the request leaves it no choice, with
	 * `tool_choice: "required"`.
	 *
	 * This is the decisive probe. A model that writes plain text here was never offered the option
	 * of answering in words, so the result cannot be explained away as the model having preferred
	 * to. It is exactly the request that settled the de-risk gate of
	 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78).
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeGeneratesACallWhenForced(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		const asked = await ToolCallProber._askRepeatedly(options, [weatherTool], 'required', prompts.weather);
		const failure = ToolCallProber._failureOf(options, 'generates_a_call_when_forced', asked);
		if (failure !== undefined) {
			return failure;
		}
		const withACall = asked.filter((answer) => answer.toolCalls.length > 0);
		if (withACall.length === 0) {
			return ToolCallProber._outcome(
				options,
				'generates_a_call_when_forced',
				'unsupported',
				`tool_choice required was accepted and not enforced: the model answered in words all ${asked.length} times, so it was never given the choice it appears to have made`,
				asked,
			);
		}
		return ToolCallProber._outcome(
			options,
			'generates_a_call_when_forced',
			'supported',
			`${withACall.length} of ${asked.length} answers asked for ${ToolCallProber._namesOf(withACall)}`,
			asked,
		);
	}

	/**
	 * Probes whether the tool call the model generated carries usable arguments: that they parse as
	 * JSON, that they hold the argument the tool declared, and that its value is the one the
	 * question named.
	 *
	 * A tool call naming the right tool and filled in with the wrong city is worse than no tool call
	 * at all, because the calling program would run it and answer confidently about the wrong place.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeFillsInTheArguments(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		// Asked with `auto` rather than `required`, unlike the probe above. This probe needs a tool
		// call to read, not a forced one, and an endpoint that refuses to be forced — as this
		// project's own `consumer_openai` server does, because it cannot enforce the request and
		// will not accept what it would have to ignore — would otherwise report `refused` for an
		// ability it can perfectly well demonstrate.
		const asked = await ToolCallProber._askUntilACall(options, [weatherTool], 'auto', prompts.weather);
		const failure = ToolCallProber._failureOf(options, 'fills_in_the_arguments', asked);
		if (failure !== undefined) {
			return failure;
		}
		const toolCall = ToolCallProber._firstToolCallOf(asked);
		if (toolCall === undefined) {
			return ToolCallProber._outcome(
				options,
				'fills_in_the_arguments',
				'inconclusive',
				`the model generated no tool call in ${asked.length} tries, so there were no arguments to read`,
				asked,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(toolCall.argumentsJson);
		} catch {
			return ToolCallProber._outcome(
				options,
				'fills_in_the_arguments',
				'unsupported',
				`the arguments of the ${toolCall.name} call are not valid JSON: ${JSON.stringify(toolCall.argumentsJson)}`,
				asked,
			);
		}
		if (typeof parsed !== 'object' || parsed === null) {
			return ToolCallProber._outcome(
				options,
				'fills_in_the_arguments',
				'unsupported',
				`the arguments of the ${toolCall.name} call parsed as ${JSON.stringify(parsed)} rather than as an object`,
				asked,
			);
		}
		const city = (parsed as Record<string, unknown>).city;
		if (typeof city !== 'string') {
			return ToolCallProber._outcome(
				options,
				'fills_in_the_arguments',
				'unsupported',
				`the arguments of the ${toolCall.name} call carry no city, only ${JSON.stringify(Object.keys(parsed as Record<string, unknown>))}`,
				asked,
			);
		}
		if (city.toLowerCase().includes(probedCity.toLowerCase()) === false) {
			return ToolCallProber._outcome(
				options,
				'fills_in_the_arguments',
				'unsupported',
				`the question asked about ${probedCity} and the ${toolCall.name} call was filled in with ${JSON.stringify(city)}`,
				asked,
			);
		}
		return ToolCallProber._outcome(
			options,
			'fills_in_the_arguments',
			'supported',
			`the ${toolCall.name} call carries valid JSON naming the city the question asked about, ${JSON.stringify(city)}`,
			asked,
		);
	}

	/**
	 * Probes whether the model picks the right tool: three tools declared, and a question only one
	 * of them answers.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeChoosesAmongSeveralTools(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		const declared = [weatherTool, timeTool, stockPriceTool];
		// Asked with `auto`, for the same reason the arguments probe is: what this probe needs is a
		// tool call to read the choice out of, not a forced one.
		const asked = await ToolCallProber._askUntilACall(options, declared, 'auto', prompts.time);
		const failure = ToolCallProber._failureOf(options, 'chooses_among_several_tools', asked);
		if (failure !== undefined) {
			return failure;
		}
		const toolCall = ToolCallProber._firstToolCallOf(asked);
		if (toolCall === undefined) {
			return ToolCallProber._outcome(
				options,
				'chooses_among_several_tools',
				'inconclusive',
				`the model generated no tool call in ${asked.length} tries, so it never chose between the three tools declared`,
				asked,
			);
		}
		const wanted = timeTool.function.name;
		if (toolCall.name !== wanted) {
			return ToolCallProber._outcome(
				options,
				'chooses_among_several_tools',
				'unsupported',
				`the question was about the current time and the model asked for ${toolCall.name} rather than ${wanted}`,
				asked,
			);
		}
		return ToolCallProber._outcome(
			options,
			'chooses_among_several_tools',
			'supported',
			`the model asked for ${wanted} out of the three tools declared, which is the one that answers the question`,
			asked,
		);
	}

	/**
	 * Probes whether the model reads a tool's result back out of a history and answers from it:
	 * a history already carrying the question, the assistant's tool call, and a message whose
	 * role is `tool` holding a temperature no model could have known.
	 *
	 * Generating a tool call and reading one back are two different abilities, and a model can have
	 * the second without the first. Both models measured for
	 * [issue #119](https://github.com/webai-at-home/webai-at-home/issues/119) read a tool result
	 * back, while only one of them generated a call.
	 *
	 * Sent several times, for the same reason `_probeGeneratesACall` is: whether the answer repeats
	 * the temperature or writes around it is a choice the model makes afresh each time. Measured
	 * against `llama-3.2-1b-instruct` on LM Studio 0.4.20, fifteen answers of twenty repeated the
	 * number and five wrote around it, so one request reported an ability the model had every time
	 * as absent about one run in four
	 * ([issue #208](https://github.com/webai-at-home/webai-at-home/issues/208)).
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeReadsAToolResultBack(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		const toolCallId = 'call_probe_weather';
		const asked = await ToolCallProber._askHistoryUntilTheResultIsRead(options, [weatherTool], 'auto', [
			{
				role: 'user',
				content: prompts.weather,
			},
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: toolCallId,
						type: 'function',
						function: {
							name: weatherTool.function.name,
							arguments: JSON.stringify({
								city: probedCity,
							}),
						},
					},
				],
			},
			{
				role: 'tool',
				tool_call_id: toolCallId,
				content: JSON.stringify({
					city: probedCity,
					celsius: Number(probedTemperatureCelsius),
					sky: 'clear',
				}),
			},
			{
				role: 'user',
				content: 'Answer my question using that result. State the temperature in degrees celsius.',
			},
		]);
		const failure = ToolCallProber._failureOf(options, 'reads_a_tool_result_back', asked);
		if (failure !== undefined) {
			return failure;
		}
		const withTheTemperature = asked.filter((answer) => ToolCallProber._readsTheResultBack(answer) === true);
		if (withTheTemperature.length > 0) {
			return ToolCallProber._outcome(
				options,
				'reads_a_tool_result_back',
				'supported',
				`${withTheTemperature.length} of ${asked.length} answers state the ${probedTemperatureCelsius} degrees celsius that only the tool result could have told it`,
				asked,
			);
		}
		const withACall = asked.filter((answer) => answer.toolCalls.length > 0);
		if (withACall.length > 0) {
			return ToolCallProber._outcome(
				options,
				'reads_a_tool_result_back',
				'unsupported',
				`the history already carried the result and ${withACall.length} of ${asked.length} answers asked for ${ToolCallProber._namesOf(withACall)} again rather than answering from it`,
				asked,
			);
		}
		return ToolCallProber._outcome(
			options,
			'reads_a_tool_result_back',
			'unsupported',
			`the tool result said ${probedTemperatureCelsius} degrees celsius and none of the ${asked.length} answers contains ${probedTemperatureCelsius}`,
			asked,
		);
	}

	/**
	 * Probes the negative control: a tool declared, `tool_choice: "auto"`, and a question that needs
	 * no tool at all.
	 *
	 * This is what proves the endpoint read the request rather than choking on it. Without it, an
	 * endpoint that fails every other probe cannot be told apart from one that refuses the tool wire
	 * format outright, and that distinction is the whole finding of the de-risk gate of
	 * [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78): the wire format was
	 * never the obstacle.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @returns What the probe concluded.
	 */
	private static async _probeAnswersWithoutACallWhenNoneIsNeeded(options: ToolCallProbeOptions): Promise<ToolCallOutcome> {
		const answer = await ToolCallProber._ask(options, [weatherTool], 'auto', [
			{
				role: 'user',
				content: prompts.noToolNeeded,
			},
		]);
		const failure = ToolCallProber._failureOf(options, 'answers_without_a_call_when_none_is_needed', [answer]);
		if (failure !== undefined) {
			return failure;
		}
		if (answer.toolCalls.length > 0) {
			return ToolCallProber._outcome(
				options,
				'answers_without_a_call_when_none_is_needed',
				'unsupported',
				`the question needed no tool and the model asked for ${ToolCallProber._namesOf([answer])} anyway`,
				[answer],
			);
		}
		return ToolCallProber._outcome(
			options,
			'answers_without_a_call_when_none_is_needed',
			'supported',
			`the endpoint accepted the tool declaration and answered in words, which proves it read the request rather than refusing the tool wire format: ${JSON.stringify(answer.text)}`,
			[answer],
		);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sending And Judging
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends one history with one set of tools declared, and turns a failure into an answer
	 * rather than throwing, so that a refusal can be read as the endpoint's answer about tool
	 * calling.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param tools The tools to declare.
	 * @param toolChoice How much choice to leave the model.
	 * @param messages The whole history to send.
	 * @returns The answer, or the failure that came instead of it.
	 */
	private static async _ask(
		options: ToolCallProbeOptions,
		tools: readonly ToolDeclaration[],
		toolChoice: ToolChoice,
		messages: OpenAI.ChatCompletionMessageParam[],
	): Promise<ProbeAnswer> {
		try {
			const result = await CompletionSender.send({
				client: options.client,
				modelId: options.modelId,
				messages,
				mode: options.mode,
				tools,
				toolChoice,
			});
			return {
				text: result.answer,
				toolCalls: result.toolCalls,
				finishReason: result.finishReason,
				failureMessage: undefined,
				failureExplanation: undefined,
				failureParam: undefined,
			};
		} catch (error: unknown) {
			return {
				text: '',
				toolCalls: [],
				finishReason: undefined,
				failureMessage: CompletionSender.describeFailure(error),
				failureExplanation: CompletionSender.failureExplanation(error),
				failureParam: CompletionSender.failureParam(error),
			};
		}
	}

	/**
	 * Sends one question with one set of tools declared, as many times as the repeat count says.
	 *
	 * Every request is sent, rather than stopping at the first that produced a call, because how
	 * many of them produced one is the finding.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @param tools The tools to declare on every request.
	 * @param toolChoice How much choice to leave the model.
	 * @param prompt The question to ask every time.
	 * @returns The answers, in the order they were sent. Stops early at the first failed request,
	 * since one failed request already decides the outcome and the rest would only cost time.
	 */
	private static async _askRepeatedly(
		options: ToolCallProbeOptions,
		tools: readonly ToolDeclaration[],
		toolChoice: ToolChoice,
		prompt: string,
	): Promise<ProbeAnswer[]> {
		const answers: ProbeAnswer[] = [];
		for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
			const answer = await ToolCallProber._ask(options, tools, toolChoice, [
				{
					role: 'user',
					content: prompt,
				},
			]);
			answers.push(answer);
			if (answer.failureMessage !== undefined) {
				break;
			}
		}
		return answers;
	}

	/**
	 * Sends one question with one set of tools declared until an answer carries a tool call, or
	 * until the repeat count runs out.
	 *
	 * Used by the probes that read a tool call rather than count them, so a model that calls tools
	 * unreliably is still measured on the call it did produce instead of being reported as
	 * inconclusive because the first try happened not to produce one.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @param tools The tools to declare on every request.
	 * @param toolChoice How much choice to leave the model.
	 * @param prompt The question to ask every time.
	 * @returns The answers, in the order they were sent, ending at the first one that carried a tool
	 * call or at the first that failed.
	 */
	private static async _askUntilACall(
		options: ToolCallProbeOptions,
		tools: readonly ToolDeclaration[],
		toolChoice: ToolChoice,
		prompt: string,
	): Promise<ProbeAnswer[]> {
		const answers: ProbeAnswer[] = [];
		for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
			const answer = await ToolCallProber._ask(options, tools, toolChoice, [
				{
					role: 'user',
					content: prompt,
				},
			]);
			answers.push(answer);
			if (answer.failureMessage !== undefined || answer.toolCalls.length > 0) {
				break;
			}
		}
		return answers;
	}

	/**
	 * Sends one whole history with one set of tools declared until an answer reads the tool result
	 * back, or until the repeat count runs out.
	 *
	 * `_askRepeatedly` and `_askUntilACall` each build their own one-message history out of one
	 * prompt. This one takes the whole history instead, because the probe that uses it has to put a
	 * tool call and that tool's result in front of the model before it can ask anything.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @param tools The tools to declare on every request.
	 * @param toolChoice How much choice to leave the model.
	 * @param messages The whole history to send every time.
	 * @returns The answers, in the order they were sent, ending at the first one that read the tool
	 * result back or at the first that failed.
	 */
	private static async _askHistoryUntilTheResultIsRead(
		options: ToolCallProbeOptions,
		tools: readonly ToolDeclaration[],
		toolChoice: ToolChoice,
		messages: OpenAI.ChatCompletionMessageParam[],
	): Promise<ProbeAnswer[]> {
		const answers: ProbeAnswer[] = [];
		for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
			const answer = await ToolCallProber._ask(options, tools, toolChoice, messages);
			answers.push(answer);
			if (answer.failureMessage !== undefined || ToolCallProber._readsTheResultBack(answer) === true) {
				break;
			}
		}
		return answers;
	}

	/**
	 * Reports whether one answer read the tool result back: it answered in words rather than asking
	 * for the tool again, and those words carry the temperature only the tool result could have
	 * told it.
	 *
	 * @param answer The answer to read.
	 * @returns `true` when the answer states the probed temperature.
	 */
	private static _readsTheResultBack(answer: ProbeAnswer): boolean {
		if (answer.toolCalls.length > 0) {
			return false;
		}
		return answer.text.includes(probedTemperatureCelsius);
	}

	/**
	 * Turns the first failed request of a probe into that probe's outcome, if one failed.
	 *
	 * An endpoint that names `tools` or `tool_choice` as the field at fault is answering that it
	 * will not take tool declarations at all, which is a conclusion about that endpoint rather than
	 * a fault in this run, so it becomes `refused`. Every other failure becomes `failed`, because
	 * the ability was never tested.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param ability The ability being probed.
	 * @param answers The answers this probe produced.
	 * @returns The outcome to report, or `undefined` when every request succeeded.
	 */
	private static _failureOf(options: ToolCallProbeOptions, ability: ToolCallAbility, answers: readonly ProbeAnswer[]): ToolCallOutcome | undefined {
		const failed = answers.find((answer) => answer.failureMessage !== undefined);
		if (failed === undefined) {
			return undefined;
		}
		if (failed.failureParam === 'tools' || failed.failureParam === 'tool_choice') {
			return ToolCallProber._outcome(options, ability, 'refused', String(failed.failureExplanation), answers);
		}
		return ToolCallProber._outcome(options, ability, 'failed', String(failed.failureMessage), answers);
	}

	/**
	 * Reads the first tool call any answer of a probe carried.
	 *
	 * @param answers The answers the probe produced, in the order they were sent.
	 * @returns The first tool call, or `undefined` when no answer carried one.
	 */
	private static _firstToolCallOf(answers: readonly ProbeAnswer[]): ChatCompletionToolCall | undefined {
		for (const answer of answers) {
			const toolCall = answer.toolCalls[0];
			if (toolCall !== undefined) {
				return toolCall;
			}
		}
		return undefined;
	}

	/**
	 * Names the tools a set of answers asked for, without repeating a name.
	 *
	 * @param answers The answers to read the tool calls from.
	 * @returns The tool names, separated by commas.
	 */
	private static _namesOf(answers: readonly ProbeAnswer[]): string {
		const names = new Set(answers.flatMap((answer) => answer.toolCalls.map((toolCall) => toolCall.name)));
		return [...names].join(', ');
	}

	/**
	 * Builds one probe outcome, recording every answer as the text the model wrote or as the tool
	 * call it asked for instead.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param ability The ability probed.
	 * @param status What the probe concluded.
	 * @param observation What was observed, in words.
	 * @param answers The answers the probe's requests produced.
	 * @returns The outcome to report.
	 */
	private static _outcome(
		options: ToolCallProbeOptions,
		ability: ToolCallAbility,
		status: ToolCallOutcome['status'],
		observation: string,
		answers: readonly ProbeAnswer[],
	): ToolCallOutcome {
		return {
			modelId: options.modelId,
			mode: options.mode,
			ability,
			status,
			observation,
			answers: answers.map((answer) => ToolCallProber.describeAnswer(answer.text, answer.toolCalls)),
		};
	}
}
