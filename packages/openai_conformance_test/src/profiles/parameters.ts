// local imports
import { parametersMaxCompletionTokensTest } from '../tests/parameters/max_completion_tokens.js';
import { parametersSeedTest } from '../tests/parameters/seed.js';
import { parametersStopTest } from '../tests/parameters/stop.js';
import { parametersTemperatureTest } from '../tests/parameters/temperature.js';
import { parametersTopPTest } from '../tests/parameters/top_p.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	parameters — whether each generation control is honoured, not merely accepted
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The parameter tests of section 10 of issue #181, each measuring whether the control changed the
 * answers rather than whether the endpoint accepted the field. A control accepted and quietly
 * ignored looks exactly like a control that works, until it is measured.
 *
 * `frequency_penalty` and `presence_penalty` are deliberately absent. Neither can be measured
 * stably from the outside the way the five below can, and milestone zero of
 * [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) established that a test
 * whose verdict flips between runs measures the model rather than the protocol. A test that only
 * checked whether the field was accepted would report exactly the false "supported" that section
 * 10 of issue #181 warns against.
 */
export const parametersProfile: readonly ConformanceTest[] = [
	parametersTemperatureTest,
	parametersTopPTest,
	parametersMaxCompletionTokensTest,
	parametersStopTest,
	parametersSeedTest,
];
