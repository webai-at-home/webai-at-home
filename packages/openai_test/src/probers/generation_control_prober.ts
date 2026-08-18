// npm imports
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from '../clients/completion_sender.js';
import type { CompletionMode, GenerationControlField, GenerationControlOutcome, GenerationControls } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlProber — proves, one control at a time, whether an endpoint really honours it
//
//	A control that is accepted and quietly ignored looks exactly like a control that works, until
//	the answers are compared. So every probe here sends the same prompt more than once and draws
//	its conclusion from whether the answers changed the way that control is supposed to change
//	them, never from the endpoint having accepted the field without complaining. This is the
//	de-risk gate of
//	[issue #151](https://github.com/webai-at-home/webai-at-home/issues/151), made re-runnable
//	against any endpoint that speaks the OpenAI-compatible API.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one run of {@link GenerationControlProber.probeAll} needs. */
export type GenerationControlProbeOptions = {
	/** The OpenAI client pointed at the endpoint under test. */
	readonly client: OpenAI;
	/** The model identifier to request. */
	readonly modelId: string;
	/** Whether to ask for the answer as it is written, or in one piece. */
	readonly mode: CompletionMode;
	/**
	 * How many times a probe that compares repeated answers sends its prompt. Three is what the
	 * de-risk gate used: two answers agreeing can be chance, and three agreeing where a high
	 * temperature gave three different answers cannot reasonably be.
	 */
	readonly repeats: number;
};

/** One answer, or the failure that came instead of it. */
type ProbeAnswer = {
	/** The answer text, empty when the request failed. */
	readonly text: string;
	/** The OpenAI `finish_reason` the endpoint reported, `undefined` when it reported none. */
	readonly finishReason: string | undefined;
	/** The number of tokens the endpoint said it generated, `undefined` when it reported none. */
	readonly completionTokenCount: number | undefined;
	/** Why the request failed, `undefined` when it succeeded. */
	readonly failureMessage: string | undefined;
	/** The endpoint's own explanation of the failure, in its own words, `undefined` when it succeeded. */
	readonly failureExplanation: string | undefined;
	/** The endpoint's own short name for why it refused, `undefined` when it sent none. */
	readonly failureCode: string | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlProber
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The prompts each probe sends, chosen so that the control under test visibly changes the answer. */
const prompts = {
	/** A prompt with many plausible answers, so a high temperature produces visibly different ones. */
	openEnded: 'Write one short sentence about a cat.',
	/** A prompt with a long, exactly-known answer, so a small output budget visibly cuts it short. */
	long: 'Count from one to fifty in words.',
	/** A prompt whose answer is known to contain the stop sequence probed below. */
	counting: 'Count from 1 to 9, separated by spaces, digits only.',
} as const;

/** The temperature a probe uses when it wants the answers to vary. */
const highTemperature = 1.6;

/** The output budget the maximum-output-length probe asks for, small enough to cut any answer short. */
const smallOutputTokenCount = 8;

/** The stop sequence probed, which `prompts.counting` is otherwise certain to write straight past. */
const probedStopSequence = '3';

/** One control's probe: how to ask about it on its own, and how to measure it. */
type ControlProbe = {
	/** The control probed, named as the request field it is sent in. */
	readonly control: GenerationControlField;
	/**
	 * The request that asks about this control and nothing else, at a value that is not this
	 * interface's own default, so an endpoint that refuses the control names this control.
	 */
	readonly alone: GenerationControls;
	/** Runs the comparison that decides whether the control really changed the answers. */
	readonly run: (options: GenerationControlProbeOptions) => Promise<GenerationControlOutcome>;
};

/** Proves, one control at a time, whether an endpoint really honours it for one model. */
export class GenerationControlProber {
	/** Every control probed, in the order the OpenAI Chat Completions interface documents them. */
	private static readonly _probes: readonly ControlProbe[] = [
		{
			control: 'temperature',
			alone: {
				temperature: 0,
			},
			run: async (options) => await GenerationControlProber._probeTemperature(options),
		},
		{
			control: 'top_p',
			alone: {
				top_p: 0.01,
			},
			run: async (options) => await GenerationControlProber._probeTopP(options),
		},
		{
			control: 'max_completion_tokens',
			alone: {
				max_completion_tokens: smallOutputTokenCount,
			},
			run: async (options) => await GenerationControlProber._probeMaximumOutputTokenCount(options),
		},
		{
			control: 'stop',
			alone: {
				stop: [probedStopSequence],
			},
			run: async (options) => await GenerationControlProber._probeStop(options),
		},
		{
			control: 'seed',
			alone: {
				seed: 42,
			},
			run: async (options) => await GenerationControlProber._probeSeed(options),
		},
	];

	/**
	 * Probes all five generation controls against one model and one mode, in the order they are
	 * declared, and reports what each probe concluded.
	 *
	 * The probes run one after another rather than together, because two of them read the same
	 * model at a high temperature and a shared endpoint answering both at once would make neither
	 * measurement mean anything.
	 *
	 * @param options The client, the model identifier, the mode, and how many times a repeated
	 * probe sends its prompt.
	 * @returns One outcome per control, in the order the controls are declared.
	 */
	static async probeAll(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome[]> {
		const outcomes: GenerationControlOutcome[] = [];
		for (const probe of GenerationControlProber._probes) {
			// Three of the five probes need a temperature beside the control they are measuring —
			// narrowing `top_p` or repeating a `seed` says nothing about a model that was going to
			// answer identically anyway. So each control is first asked about on its own, with no
			// other control in the request, because an endpoint that refuses more than one of them
			// names whichever it checked first and would otherwise report every control as refused
			// for the wrong reason.
			const alone = await GenerationControlProber._ask(options, probe.alone, prompts.openEnded);
			const failure = GenerationControlProber._failureOf(options, probe.control, [alone]);
			if (failure !== undefined) {
				outcomes.push(failure);
				continue;
			}
			outcomes.push(await probe.run(options));
		}
		return outcomes;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Five Probes
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Probes `temperature`: the same prompt at `0` several times, then at a high temperature
	 * several times.
	 *
	 * Honoured when every answer at `0` is the same and the high-temperature answers are not all
	 * the same. Either half alone proves nothing: a model can be deterministic for reasons that
	 * have nothing to do with the temperature it was given.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeTemperature(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome> {
		const cold = await GenerationControlProber._askRepeatedly(options, { temperature: 0 });
		const failure = GenerationControlProber._failureOf(options, 'temperature', cold);
		if (failure !== undefined) {
			return failure;
		}
		const hot = await GenerationControlProber._askRepeatedly(options, { temperature: highTemperature });
		const hotFailure = GenerationControlProber._failureOf(options, 'temperature', hot, cold);
		if (hotFailure !== undefined) {
			return hotFailure;
		}
		const answers = [...cold, ...hot].map((answer) => answer.text);
		const coldAgrees = GenerationControlProber._allTheSame(cold);
		const hotVaries = GenerationControlProber._allTheSame(hot) === false;
		if (coldAgrees === true && hotVaries === true) {
			return GenerationControlProber._outcome(options, 'temperature', 'honoured', `${cold.length} answers at temperature 0 were identical, and ${hot.length} at ${highTemperature} were not`, answers);
		}
		if (coldAgrees === false && hotVaries === true) {
			return GenerationControlProber._outcome(options, 'temperature', 'not_honoured', `the answers varied at temperature 0 as well as at ${highTemperature}, so the value changed nothing`, answers);
		}
		if (coldAgrees === true && hotVaries === false) {
			return GenerationControlProber._outcome(options, 'temperature', 'not_honoured', `every answer was identical at temperature ${highTemperature} as well as at 0, so the value changed nothing`, answers);
		}
		return GenerationControlProber._outcome(options, 'temperature', 'inconclusive', 'the answers varied at temperature 0 and agreed at the high temperature, which is neither of the two things this probe can tell apart', answers);
	}

	/**
	 * Probes `top_p`: the same prompt at a high temperature with `top_p` narrowed to almost
	 * nothing, several times.
	 *
	 * Honoured when every answer is the same, since narrowing the probability mass to the single
	 * most likely token is what makes a high temperature stop mattering. Inconclusive when the
	 * `temperature` probe already found the high temperature produced identical answers, because
	 * then there was no variation for `top_p` to remove.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeTopP(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome> {
		const narrowed = await GenerationControlProber._askRepeatedly(options, { temperature: highTemperature, top_p: 0.01 });
		const failure = GenerationControlProber._failureOf(options, 'top_p', narrowed);
		if (failure !== undefined) {
			return failure;
		}
		const answers = narrowed.map((answer) => answer.text);
		if (GenerationControlProber._allTheSame(narrowed) === true) {
			return GenerationControlProber._outcome(options, 'top_p', 'honoured', `${narrowed.length} answers at temperature ${highTemperature} with top_p 0.01 were identical, so narrowing the probability mass removed the variation that temperature added`, answers);
		}
		return GenerationControlProber._outcome(options, 'top_p', 'not_honoured', `the answers still varied at temperature ${highTemperature} with top_p 0.01, so the value changed nothing`, answers);
	}

	/**
	 * Probes the maximum output length: one long-answer prompt with a small budget, and the same
	 * prompt with none.
	 *
	 * Honoured when the endpoint reports `finish_reason: length`, which is what it says when it
	 * stopped because the budget ran out. A shorter answer alone is accepted as evidence only
	 * when the endpoint reports no finish reason at all.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeMaximumOutputTokenCount(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome> {
		const newSpelling = await GenerationControlProber._ask(options, { temperature: 0, max_completion_tokens: smallOutputTokenCount }, prompts.long);
		const failure = GenerationControlProber._failureOf(options, 'max_completion_tokens', [newSpelling]);
		if (failure !== undefined) {
			return failure;
		}
		const unlimited = await GenerationControlProber._ask(options, { temperature: 0 }, prompts.long);
		const newSpellingVerdict = GenerationControlProber._budgetVerdict(newSpelling, unlimited);
		if (newSpellingVerdict.isShortened === true) {
			return GenerationControlProber._outcome(options, 'max_completion_tokens', 'honoured', newSpellingVerdict.observation, [newSpelling.text, unlimited.text]);
		}

		// An endpoint that ignored `max_completion_tokens` may still read `max_tokens`, this
		// interface's older spelling of the same control. LM Studio 0.4.20 reads both, but an
		// endpoint reading only the older one does honour this control, and reporting which spelling
		// it reads is worth one more request: it is the difference between a useful finding and a
		// false negative.
		const oldSpelling = await GenerationControlProber._ask(options, { temperature: 0, max_tokens: smallOutputTokenCount }, prompts.long);
		const answers = [newSpelling.text, unlimited.text, oldSpelling.text];
		if (oldSpelling.failureMessage !== undefined) {
			return GenerationControlProber._outcome(options, 'max_completion_tokens', 'not_honoured', `${newSpellingVerdict.observation}, and the older spelling max_tokens failed: ${oldSpelling.failureMessage}`, answers);
		}
		const oldSpellingVerdict = GenerationControlProber._budgetVerdict(oldSpelling, unlimited);
		if (oldSpellingVerdict.isShortened === true) {
			return GenerationControlProber._outcome(options, 'max_completion_tokens', 'honoured', `only under this interface's older spelling max_tokens: ${oldSpellingVerdict.observation}, where max_completion_tokens changed nothing`, answers);
		}
		return GenerationControlProber._outcome(options, 'max_completion_tokens', 'not_honoured', `${newSpellingVerdict.observation}, and the older spelling max_tokens changed nothing either`, answers);
	}

	/**
	 * Judges whether one budgeted answer really was cut short by its budget.
	 *
	 * `finish_reason: length` is the endpoint saying so itself and is taken at its word. A shorter
	 * answer is accepted as evidence only when the endpoint reported no finish reason at all,
	 * since an endpoint that reports `stop` is saying the model finished on its own.
	 *
	 * @param budgeted The answer asked for with a small output budget.
	 * @param unlimited The same prompt's answer asked for with no budget.
	 * @returns Whether the budget cut the answer short, and what was observed, in words.
	 */
	private static _budgetVerdict(budgeted: ProbeAnswer, unlimited: ProbeAnswer): { isShortened: boolean; observation: string } {
		const tokenText = budgeted.completionTokenCount === undefined ? '' : `, ${budgeted.completionTokenCount} completion tokens`;
		if (budgeted.finishReason === 'length') {
			return {
				isShortened: true,
				observation: `asking for at most ${smallOutputTokenCount} tokens stopped the answer with finish_reason length${tokenText}`,
			};
		}
		if (budgeted.finishReason === undefined && unlimited.failureMessage === undefined && budgeted.text.length < unlimited.text.length) {
			return {
				isShortened: true,
				observation: `the endpoint reported no finish_reason, and asking for at most ${smallOutputTokenCount} tokens gave ${budgeted.text.length} characters against ${unlimited.text.length} with no budget`,
			};
		}
		return {
			isShortened: false,
			observation: `asking for at most ${smallOutputTokenCount} tokens gave ${budgeted.text.length} characters against ${unlimited.text.length} with no budget, and finish_reason was ${budgeted.finishReason ?? 'not reported'}`,
		};
	}

	/**
	 * Probes `stop`: a prompt whose answer is otherwise certain to contain the stop sequence,
	 * sent with the stop sequence and then without it.
	 *
	 * Honoured when the answer with the stop sequence does not contain it and the answer without
	 * it does. The second half is what makes the first mean anything: a model that never wrote
	 * the sequence in the first place proves nothing.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeStop(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome> {
		const stopped = await GenerationControlProber._ask(options, { temperature: 0, stop: [probedStopSequence] }, prompts.counting);
		const failure = GenerationControlProber._failureOf(options, 'stop', [stopped]);
		if (failure !== undefined) {
			return failure;
		}
		const unstopped = await GenerationControlProber._ask(options, { temperature: 0 }, prompts.counting);
		const answers = [stopped.text, unstopped.text];
		if (unstopped.failureMessage !== undefined || unstopped.text.includes(probedStopSequence) === false) {
			return GenerationControlProber._outcome(options, 'stop', 'inconclusive', `the same prompt without a stop sequence did not write "${probedStopSequence}" either, so there was nothing for the stop sequence to cut`, answers);
		}
		if (stopped.text.includes(probedStopSequence) === false) {
			return GenerationControlProber._outcome(options, 'stop', 'honoured', `the answer stopped before "${probedStopSequence}", which the same prompt wrote straight past without a stop sequence`, answers);
		}
		return GenerationControlProber._outcome(options, 'stop', 'not_honoured', `the answer still contains "${probedStopSequence}", so the stop sequence changed nothing`, answers);
	}

	/**
	 * Probes `seed`: the same prompt at a high temperature with one seed twice, then with a
	 * different seed.
	 *
	 * Honoured when the two runs of the same seed agree and the different seed does not. A model
	 * that answers identically whatever seed it is given is reported as inconclusive rather than
	 * as honouring the seed, because that is what an ignored seed looks like too.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @returns What the probe concluded.
	 */
	private static async _probeSeed(options: GenerationControlProbeOptions): Promise<GenerationControlOutcome> {
		const first = await GenerationControlProber._ask(options, { temperature: highTemperature, seed: 42 }, prompts.openEnded);
		const failure = GenerationControlProber._failureOf(options, 'seed', [first]);
		if (failure !== undefined) {
			return failure;
		}
		const second = await GenerationControlProber._ask(options, { temperature: highTemperature, seed: 42 }, prompts.openEnded);
		const other = await GenerationControlProber._ask(options, { temperature: highTemperature, seed: 43 }, prompts.openEnded);
		const laterFailure = GenerationControlProber._failureOf(options, 'seed', [second, other], [first]);
		if (laterFailure !== undefined) {
			return laterFailure;
		}
		const answers = [first.text, second.text, other.text];
		const sameSeedAgrees = first.text === second.text;
		const otherSeedDiffers = other.text !== first.text;
		if (sameSeedAgrees === true && otherSeedDiffers === true) {
			return GenerationControlProber._outcome(options, 'seed', 'honoured', 'seed 42 gave the same answer twice at a high temperature, and seed 43 gave a different one', answers);
		}
		if (sameSeedAgrees === false) {
			return GenerationControlProber._outcome(options, 'seed', 'not_honoured', 'seed 42 gave two different answers, so the seed decided nothing', answers);
		}
		return GenerationControlProber._outcome(options, 'seed', 'inconclusive', 'every seed gave the same answer, which is what an ignored seed and a deterministic model both look like', answers);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Sending And Judging
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends one prompt with one set of controls, and turns a failure into an answer rather than
	 * throwing, so that a refusal can be read as the endpoint's answer about the control.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param controls The controls to ask for.
	 * @param prompt The prompt to send. Defaults to the open-ended one every repeated probe uses.
	 * @returns The answer, or the failure that came instead of it.
	 */
	private static async _ask(options: GenerationControlProbeOptions, controls: GenerationControls, prompt: string = prompts.openEnded): Promise<ProbeAnswer> {
		try {
			const result = await CompletionSender.send({
				client: options.client,
				modelId: options.modelId,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
				mode: options.mode,
				includeUsage: true,
				controls,
			});
			return {
				text: result.answer,
				finishReason: result.finishReason,
				completionTokenCount: result.usage?.completionTokens,
				failureMessage: undefined,
				failureExplanation: undefined,
				failureCode: undefined,
			};
		} catch (error: unknown) {
			return {
				text: '',
				finishReason: undefined,
				completionTokenCount: undefined,
				failureMessage: CompletionSender.describeFailure(error),
				failureExplanation: CompletionSender.failureExplanation(error),
				failureCode: CompletionSender.failureCode(error),
			};
		}
	}

	/**
	 * Sends the same prompt with the same controls several times.
	 *
	 * Stops at the first failure rather than sending the rest, because one failed request already
	 * decides the outcome and the remaining ones would only cost time.
	 *
	 * @param options The client, the model identifier, the mode, and the repeat count.
	 * @param controls The controls to ask for on every request.
	 * @returns The answers, in the order they were sent.
	 */
	private static async _askRepeatedly(options: GenerationControlProbeOptions, controls: GenerationControls): Promise<ProbeAnswer[]> {
		const answers: ProbeAnswer[] = [];
		for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
			const answer = await GenerationControlProber._ask(options, controls);
			answers.push(answer);
			if (answer.failureMessage !== undefined) {
				break;
			}
		}
		return answers;
	}

	/**
	 * Turns the first failed request of a probe into that probe's outcome, if one failed.
	 *
	 * A refusal carrying `unhonourable_generation_control` is the endpoint answering that this
	 * model cannot honour the control, which is a conclusion rather than a fault, so it becomes
	 * `refused`. Every other failure becomes `failed`, because the control was never tested.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param control The control being probed.
	 * @param newAnswers The answers this step produced.
	 * @param earlierAnswers The answers earlier steps of the same probe produced, so a failure
	 * still reports everything the probe saw.
	 * @returns The outcome to report, or `undefined` when every request succeeded.
	 */
	private static _failureOf(
		options: GenerationControlProbeOptions,
		control: GenerationControlOutcome['control'],
		newAnswers: readonly ProbeAnswer[],
		earlierAnswers: readonly ProbeAnswer[] = [],
	): GenerationControlOutcome | undefined {
		const failed = newAnswers.find((answer) => answer.failureMessage !== undefined);
		if (failed === undefined) {
			return undefined;
		}
		const answers = [...earlierAnswers, ...newAnswers].map((answer) => answer.text);
		if (failed.failureCode === 'unhonourable_generation_control') {
			return GenerationControlProber._outcome(options, control, 'refused', String(failed.failureExplanation), answers);
		}
		return GenerationControlProber._outcome(options, control, 'failed', String(failed.failureMessage), answers);
	}

	/**
	 * Reports whether every answer of a set is exactly the same text.
	 *
	 * @param answers The answers to compare.
	 * @returns `true` when they are all identical, and for a set of one.
	 */
	private static _allTheSame(answers: readonly ProbeAnswer[]): boolean {
		return answers.every((answer) => answer.text === answers[0]?.text);
	}

	/**
	 * Builds one probe outcome.
	 *
	 * @param options The client, the model identifier, and the mode.
	 * @param control The control probed.
	 * @param status What the probe concluded.
	 * @param observation What was observed, in words.
	 * @param answers The answers the probe's requests produced.
	 * @returns The outcome to report.
	 */
	private static _outcome(
		options: GenerationControlProbeOptions,
		control: GenerationControlOutcome['control'],
		status: GenerationControlOutcome['status'],
		observation: string,
		answers: readonly string[],
	): GenerationControlOutcome {
		return {
			modelId: options.modelId,
			mode: options.mode,
			control,
			status,
			observation,
			answers,
		};
	}
}
