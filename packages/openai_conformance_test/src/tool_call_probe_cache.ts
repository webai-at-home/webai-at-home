// npm imports
import type OpenAI from 'openai';

// local imports
import type { ToolCallAbility, ToolCallOutcome } from '@webai/openai-api-tool/completion_types';
import { ToolCallProber } from '@webai/openai-api-tool/tool_call_prober';

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
	 */
	constructor(
		private readonly client: OpenAI,
		private readonly modelId: string,
		private readonly repeats: number,
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
				mode: 'nostream',
				repeats: this.repeats,
			});
		}
		const outcomes = await this._outcomesPromise;
		return outcomes.find((outcome) => outcome.ability === ability);
	}
}
