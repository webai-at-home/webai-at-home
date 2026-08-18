// local imports
import { streamingGroup } from '../conformance_tests/streaming/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	streaming — SSE transport, chunk format, incremental content, finish_reason, [DONE]
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `streaming` profile named in section 5 of issue #181, which is exactly the `streaming`
 * group. Which tests it holds, and in which order, is declared in `../tests/streaming/group.ts`.
 */
export const streamingProfile: readonly ConformanceTest[] = streamingGroup;
