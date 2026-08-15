// local imports
import { streamingBasicTest } from '../tests/streaming/basic.js';
import { streamingContentConcatenatesTest } from '../tests/streaming/content_concatenates.js';
import { streamingDoneTest } from '../tests/streaming/done.js';
import { streamingFinishReasonTest } from '../tests/streaming/finish_reason.js';
import { streamingHeadersTest } from '../tests/streaming/headers.js';
import { streamingTimingTest } from '../tests/streaming/timing.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	streaming — SSE transport, chunk format, incremental content, finish_reason, [DONE]
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `streaming` profile named in section 5 of issue #181: the server-sent event transport, the
 * chunk format, incremental content, `finish_reason`, `[DONE]`, and connection termination.
 */
export const streamingProfile: readonly ConformanceTest[] = [
	streamingHeadersTest,
	streamingBasicTest,
	streamingContentConcatenatesTest,
	streamingFinishReasonTest,
	streamingDoneTest,
	streamingTimingTest,
];
