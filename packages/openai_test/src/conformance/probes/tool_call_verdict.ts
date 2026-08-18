// local imports
import type { ToolCallAbility, ToolCallOutcome } from '../../completion_types.js';
import type { TestResult } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ToolCallVerdict — turns one ToolCallProber outcome into one conformance verdict
//
//	`ToolCallProber` already draws the distinction this package's four statuses exist to draw, in
//	its own five-status vocabulary, so this file is a translation and never a second judgement.
//	Two of the five carry findings milestone zero of issue #182 recorded by hand:
//
//	  - `refused` is the endpoint saying it will not take tool declarations for this model at all,
//	    naming `tools` as the field at fault — this project's own `consumer_openai` answers exactly
//	    that, with the code `unsupported_tool_declarations`, for a model that cannot read them. It
//	    is a true statement about the endpoint, so it is `SKIP`, never `FAIL`.
//	  - `unsupported` is the endpoint having accepted the request and the model having chosen
//	    otherwise. That is the de-risk finding of
//	    [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), and it is `WARN`,
//	    never `FAIL`, because nothing about the protocol was broken.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Translates one `ToolCallProber` outcome into one conformance test result. */
export class ToolCallVerdict {
	/**
	 * Translates one probed ability's outcome into the verdict this package reports.
	 *
	 * @param outcome The outcome `ToolCallProber` reached, `undefined` when its run produced none
	 * for this ability at all.
	 * @param ability The ability that was probed, named in the result when there is no outcome to
	 * describe.
	 * @returns The verdict, carrying `ToolCallProber`'s own observation as the detail, so the
	 * reason printed is the one the prober drew its conclusion from.
	 */
	static fromOutcome(outcome: ToolCallOutcome | undefined, ability: ToolCallAbility): TestResult {
		if (outcome === undefined) {
			return { verdict: 'FAIL', detail: `the tool call probe produced no outcome for "${ability}"` };
		}
		switch (outcome.status) {
			case 'supported':
				return { verdict: 'PASS', detail: outcome.observation };
			case 'refused':
				return { verdict: 'SKIP', detail: outcome.observation };
			case 'unsupported':
			case 'inconclusive':
				return { verdict: 'WARN', detail: outcome.observation };
			case 'failed':
				return { verdict: 'FAIL', detail: outcome.observation };
		}
	}
}
