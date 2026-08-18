// local imports
import { historyGroup } from '../conformance_tests/history/group.js';
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
 *
 * `historyGroup` is spread here as a group rather than reached through a profile, because it is
 * the one group no capability profile of section 5 covers: `core` stays protocol-shaped, and the
 * history is a capability of its own rather than part of a single-turn completion.
 */
export const fullProfile: readonly ConformanceTest[] = [
	...coreProfile,
	...historyGroup,
	...streamingProfile,
	...toolsProfile,
	...parametersProfile,
	...structuredOutputProfile,
	...sdkProfile,
];
