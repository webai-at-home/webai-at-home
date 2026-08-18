// local imports
import type { ConformanceTest } from '../../types.js';
import { historyAcceptedTest } from './accepted.js';
import { historyRecalledTest } from './recalled.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	historyGroup — whether a history is carried, and whether the model behind it reads one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every test in the `history` folder, in the order they are run and printed.
 *
 * Acceptance comes first because recall means nothing without it: an endpoint that refuses a
 * history at all makes the second question unanswerable.
 */
export const historyGroup: readonly ConformanceTest[] = [
	historyAcceptedTest,
	historyRecalledTest,
];
