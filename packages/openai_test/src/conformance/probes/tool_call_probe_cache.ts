// npm imports
import type OpenAI from 'openai';

// local imports
import type { StreamSetting, ThinkingSetting, ToolCallAbility, ToolCallOutcome } from '../../completion_types.js';
import type { AnswerLengthCap } from '../../probers/answer_length_cap.js';
import { ToolCallProber } from '../../probers/tool_call_prober.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallProbeCache — runs ToolCallProber once per run, and hands each of the six tool call
//	tests its own ability's outcome out of that one run
//
//	`ToolCallProber.probeAll` probes all six abilities in one call, and each probe sends several
//	requests. Six conformance tests each calling `probeAll` would therefore probe every ability
//	six times over and send six times the requests, to reach the same six answers. This class runs
//	it once, lazily, and every test after the first awaits the same promise.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Runs `ToolCallProber.probeAll` at most once, and serves each ability's outcome from that run. */
export class ToolCallProbeCache {
	/** The one `probeAll` run, started by whichever test asks first. `undefined` until then. */
	private _outcomesPromise: Promise<readonly ToolCallOutcome[]> | undefined = undefined;

	/**
	 * @param client The official `openai` Node.js package client, pointed at the endpoint under test.
	 * @param modelId The model identifier to probe.
	 * @param repeats How many times a probe needing a tool call sends its prompt before giving up
	 * on getting one. Whether a model asks for a tool is a choice it makes afresh each time, so one
	 * request that produced no call is weak evidence where one that produced a call is strong.
	 * @param streamSetting Whether to ask for each probe's answer as it is written, or in one piece. A model
	 * that generates a tool call one way and not the other is a real finding, and the stream setting was
	 * fixed at `--stream off` here until [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208),
	 * which meant the streamed half of that question was never asked.
	 * @param thinkingSetting Whether to let the model think before it answers, as `--thinking` asked
	 * for. `off` sends `reasoning_effort: "none"`, which takes the reasoning a thinking model would
	 * otherwise write before every one of these requests out of the run entirely.
	 * @param answerLengthCap The output budget every probe request carries, once the endpoint has
	 * proved it honours one.
	 */
	constructor(
		private readonly client: OpenAI,
		private readonly modelId: string,
		private readonly repeats: number,
		private readonly streamSetting: StreamSetting,
		private readonly thinkingSetting: ThinkingSetting,
		private readonly answerLengthCap: AnswerLengthCap,
	) {}

	/**
	 * Reads one ability's outcome out of the single `probeAll` run, starting that run if no test
	 * has started it yet.
	 *
	 * @param ability The ability to read the outcome of.
	 * @returns That ability's outcome, `undefined` when the run produced none for it.
	 */
	async outcomeFor(ability: ToolCallAbility): Promise<ToolCallOutcome | undefined> {
		if (this._outcomesPromise === undefined) {
			this._outcomesPromise = ToolCallProber.probeAll({
				client: this.client,
				modelId: this.modelId,
				streamSetting: this.streamSetting,
				repeats: this.repeats,
				thinkingSetting: this.thinkingSetting,
				answerLengthCap: this.answerLengthCap,
			});
		}
		const outcomes = await this._outcomesPromise;
		return outcomes.find((outcome) => outcome.ability === ability);
	}
}
