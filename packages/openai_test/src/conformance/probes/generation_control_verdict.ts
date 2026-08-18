// local imports
import type { GenerationControlField, GenerationControlOutcome } from '../../completion_types.js';
import type { TestResult } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlVerdict — turns one GenerationControlProber outcome into one conformance verdict
//
//	Section 10 of issue #181 states the three-way distinction this file makes, in its own words:
//
//	    SKIP    feature unsupported
//	    FAIL    feature claims support but behaves incorrectly
//	    PASS    feature works
//
//	So `not_honoured` is `FAIL` here, where the matching tool call status, `unsupported`, is `WARN`
//	in `ToolCallVerdict`. The two look alike and are not: whether a generation control is applied
//	is the server's own doing, and a server that accepts `temperature` and quietly ignores it has
//	claimed something untrue. Whether a model asks for a declared tool is the model's choice on the
//	day, and no claim was broken when it chooses to answer in words instead.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Translates one `GenerationControlProber` outcome into one conformance test result. */
export class GenerationControlVerdict {
	/**
	 * Translates one probed control's outcome into the verdict this package reports.
	 *
	 * @param outcome The outcome `GenerationControlProber` reached, `undefined` when its run
	 * produced none for this control at all.
	 * @param control The control that was probed, named in the result when there is no outcome to
	 * describe.
	 * @returns The verdict, carrying the prober's own observation as the detail.
	 */
	static fromOutcome(outcome: GenerationControlOutcome | undefined, control: GenerationControlField): TestResult {
		if (outcome === undefined) {
			return { verdict: 'FAIL', detail: `the generation control probe produced no outcome for "${control}"` };
		}
		switch (outcome.status) {
			case 'honoured':
				return { verdict: 'PASS', detail: outcome.observation };
			case 'refused':
				return { verdict: 'SKIP', detail: outcome.observation };
			case 'not_honoured':
				return { verdict: 'FAIL', detail: outcome.observation };
			case 'inconclusive':
				return { verdict: 'WARN', detail: outcome.observation };
			case 'failed':
				return { verdict: 'FAIL', detail: outcome.observation };
		}
	}
}
