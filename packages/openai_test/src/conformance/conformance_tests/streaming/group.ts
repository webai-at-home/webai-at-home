// local imports
import type { ConformanceTest } from '../../types.js';
import { streamingBasicTest } from './basic.js';
import { streamingContentConcatenatesTest } from './content_concatenates.js';
import { streamingDoneTest } from './done.js';
import { streamingFinishReasonTest } from './finish_reason.js';
import { streamingHeadersTest } from './headers.js';
import { streamingTimingTest } from './timing.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	streamingGroup — SSE transport, chunk format, incremental content, finish_reason, [DONE]
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every test in the `streaming` folder, in the order they are run and printed: the server-sent
 * event transport, the chunk format, incremental content, `finish_reason`, `[DONE]`, and
 * connection termination.
 */
export const streamingGroup: readonly ConformanceTest[] = [
	streamingHeadersTest,
	streamingBasicTest,
	streamingContentConcatenatesTest,
	streamingFinishReasonTest,
	streamingDoneTest,
	streamingTimingTest,
];
