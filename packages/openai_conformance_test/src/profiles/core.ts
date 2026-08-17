// local imports
import { chatGroup } from '../tests/chat/group.js';
import { errorsGroup } from '../tests/errors/group.js';
import { modelsGroup } from '../tests/models/group.js';
import { usageGroup } from '../tests/usage/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	core — model discovery, basic chat completions, usage, and errors
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `core` profile named in section 5 of issue #181: model discovery, basic chat completions,
 * usage, and errors. What an implementation must pass to claim compatibility with the smallest
 * well-defined subset of the OpenAI Chat Completions interface, run in the order printed.
 *
 * This is the only capability profile built from more than one group.
 */
export const coreProfile: readonly ConformanceTest[] = [
	...modelsGroup,
	...chatGroup,
	...usageGroup,
	...errorsGroup,
];
