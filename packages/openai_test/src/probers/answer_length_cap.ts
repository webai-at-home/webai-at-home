// npm imports
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from '../clients/completion_sender.js';
import type { GenerationControls, StreamSetting, ThinkingSetting } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AnswerLengthCap — the output budget every probe request carries, once the endpoint has proved
//	it honours one
//
//	A probe that compares two answers, or that reads one word out of an answer, needs a short answer
//	and nothing more. Left with no budget at all, one model writes a sentence and another writes
//	six paragraphs, and the run takes as long as the most talkative model on the endpoint. Asking
//	for a small `max_completion_tokens` bounds that worst case.
//
//	The budget is asked for only after one request has proved the endpoint answers with it, because
//	two endpoints refuse it in two different ways and each of them would turn a capped probe into a
//	finding about the cap rather than about the control being probed. This project's own
//	`consumer_openai` server refuses a control it cannot honour outright, with the code
//	`unhonourable_generation_control`. A thinking model does something quieter and worse: it spends
//	the whole budget on reasoning and answers with no text at all, which is exactly what turned
//	`parameters.max_completion_tokens` and `parameters.stop` into "the endpoint returned no answer
//	text" against `google/gemma-4-e2b` on LM Studio 0.4.20. One request that comes back with text
//	rules both out, and a request that does not leaves every probe uncapped, exactly as it was
//	before this class existed.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Everything one {@link AnswerLengthCap} needs to find out whether the endpoint honours a budget. */
export type AnswerLengthCapOptions = {
	/** The OpenAI client pointed at the endpoint under test. */
	readonly client: OpenAI;
	/** The model identifier to request. */
	readonly modelId: string;
	/** Whether to ask for the answer as it is written, or in one piece, as every probe request does. */
	readonly streamSetting: StreamSetting;
	/** Whether to let the model think before it answers, as every probe request does. */
	readonly thinkingSetting: ThinkingSetting | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	AnswerLengthCap
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Decides once, against the endpoint itself, what output budget a probe request may carry. */
export class AnswerLengthCap {
	/**
	 * The output budget a capped probe request asks for.
	 *
	 * Large enough that it cannot change what any probe concludes: the longest answer a capped
	 * probe reads is a tool call naming a city and a unit, or one sentence stating a temperature,
	 * and both are far shorter than this. Small enough that a model answering a one-sentence
	 * question with six paragraphs is stopped long before it finishes.
	 */
	static readonly tokenCount = 128;

	/** The one negotiation, started by whichever probe asks first. `undefined` until then. */
	private _controlsPromise: Promise<GenerationControls> | undefined = undefined;

	/**
	 * @param options The client, the model identifier, the stream setting, and the thinking setting
	 * every probe request of this run is sent with, so that the negotiation asks the same question
	 * the probes will ask.
	 */
	constructor(private readonly options: AnswerLengthCapOptions) {}

	/**
	 * Reports the budget to spread into a probe request, negotiating it with the endpoint the first
	 * time a probe asks.
	 *
	 * @returns `{ max_completion_tokens: AnswerLengthCap.tokenCount }` when the endpoint answered a
	 * budgeted request with text, and an empty object when it did not.
	 */
	async controls(): Promise<GenerationControls> {
		if (this._controlsPromise === undefined) {
			this._controlsPromise = this._negotiate();
		}
		return await this._controlsPromise;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends the one request that decides whether probes carry a budget.
	 *
	 * The prompt is the shortest one this package sends, because nothing here reads the answer: the
	 * only question is whether an answer arrives at all.
	 *
	 * @returns The budget to carry, empty when the request failed or came back with no text.
	 */
	private async _negotiate(): Promise<GenerationControls> {
		try {
			await CompletionSender.send({
				client: this.options.client,
				modelId: this.options.modelId,
				messages: [
					{
						role: 'user',
						content: 'Say hello.',
					},
				],
				streamSetting: this.options.streamSetting,
				thinkingSetting: this.options.thinkingSetting,
				controls: {
					max_completion_tokens: AnswerLengthCap.tokenCount,
				},
			});
			return {
				max_completion_tokens: AnswerLengthCap.tokenCount,
			};
		} catch {
			return {};
		}
	}
}
