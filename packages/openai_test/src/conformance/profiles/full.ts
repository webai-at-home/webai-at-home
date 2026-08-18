// local imports
import type { ConformanceTest } from '../types.js';
import { coreProfile } from './core.js';
import { parametersProfile } from './parameters.js';
import { sdkProfile } from './sdk.js';
import { streamingProfile } from './streaming.js';
import { structuredOutputProfile } from './structured_output.js';
import { toolsProfile } from './tools.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	full — every test this package has
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `full` profile of section 5 of issue #181: every test, in the order the groups are built up.
 *
 * A profile added later belongs in this list too, and `tests/index.test.ts` asserts that every
 * test reachable from any profile appears here, so the list cannot silently fall behind.
 */
export const fullProfile: readonly ConformanceTest[] = [
	...coreProfile,
	...streamingProfile,
	...toolsProfile,
	...parametersProfile,
	...structuredOutputProfile,
	...sdkProfile,
];
