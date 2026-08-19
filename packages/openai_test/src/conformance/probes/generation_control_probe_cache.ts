// npm imports
import type OpenAI from 'openai';

// local imports
import type { StreamSetting, ThinkingSetting, GenerationControlField, GenerationControlOutcome } from '../../completion_types.js';
import type { AnswerLengthCap } from '../../probers/answer_length_cap.js';
import { GenerationControlProber } from '../../probers/generation_control_prober.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlProbeCache — runs GenerationControlProber once per run, and hands each of the
//	five generation control tests its own control's outcome out of that one run
//
//	The same arrangement, and for the same reason, as `ToolCallProbeCache`: `probeAll` measures all
//	five controls in one call and each probe sends several requests, so five tests each calling it
//	would send five times the requests to reach the same five answers.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Runs `GenerationControlProber.probeAll` at most once, and serves each control's outcome from that run. */
export class GenerationControlProbeCache {
	/** The one `probeAll` run, started by whichever test asks first. `undefined` until then. */
	private _outcomesPromise: Promise<readonly GenerationControlOutcome[]> | undefined = undefined;

	/**
	 * @param client The official `openai` Node.js package client, pointed at the endpoint under test.
	 * @param modelId The model identifier to probe.
	 * @param repeats How many times a probe comparing repeated answers sends its prompt. Three is
	 * the floor the de-risk gate of issue #151 used: two answers agreeing can be chance, three
	 * agreeing where a high temperature gave three different answers cannot reasonably be. The
	 * default is five, raised for the two tests that read one word out of an answer, in
	 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
	 * @param streamSetting Whether to ask for each probe's answer as it is written, or in one piece. An
	 * endpoint that honours a control one way and ignores it the other is a real finding, and the
	 * stream setting was fixed at `--stream off` here until
	 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208), which meant the
	 * streamed half of that question was never asked.
	 * @param thinkingSetting Whether to let the model think before it answers, as `--thinking` asked
	 * for. `off` sends `reasoning_effort: "none"`, which takes the reasoning a thinking model would
	 * otherwise write before every one of these requests out of the run entirely.
	 * @param answerLengthCap The output budget the probes comparing whole answers carry, once the
	 * endpoint has proved it honours one.
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
	 * Reads one control's outcome out of the single `probeAll` run, starting that run if no test
	 * has started it yet.
	 *
	 * @param control The control to read the outcome of, named as the request field it is sent in.
	 * @returns That control's outcome, `undefined` when the run produced none for it.
	 */
	async outcomeFor(control: GenerationControlField): Promise<GenerationControlOutcome | undefined> {
		if (this._outcomesPromise === undefined) {
			this._outcomesPromise = GenerationControlProber.probeAll({
				client: this.client,
				modelId: this.modelId,
				streamSetting: this.streamSetting,
				repeats: this.repeats,
				thinkingSetting: this.thinkingSetting,
				answerLengthCap: this.answerLengthCap,
			});
		}
		const outcomes = await this._outcomesPromise;
		return outcomes.find((outcome) => outcome.control === control);
	}
}
