// npm imports
import type OpenAI from 'openai';

// local imports
import type { GenerationControlField, GenerationControlOutcome } from '../../completion_types.js';
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
	 * what the de-risk gate of issue #151 used: two answers agreeing can be chance, three agreeing
	 * where a high temperature gave three different answers cannot reasonably be.
	 */
	constructor(
		private readonly client: OpenAI,
		private readonly modelId: string,
		private readonly repeats: number,
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
				mode: 'nostream',
				repeats: this.repeats,
			});
		}
		const outcomes = await this._outcomesPromise;
		return outcomes.find((outcome) => outcome.control === control);
	}
}
