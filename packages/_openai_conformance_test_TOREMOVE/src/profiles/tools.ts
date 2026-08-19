// local imports
import { toolsGroup } from '../tests/tools/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	tools — the six separate tool call abilities, rather than one question about tool calling
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `tools` profile named in section 5 of issue #181, which is exactly the `tools` group. Which
 * tests it holds, in which order, and why it is six abilities rather than one question, is
 * declared in `../tests/tools/group.ts`.
 */
export const toolsProfile: readonly ConformanceTest[] = toolsGroup;
