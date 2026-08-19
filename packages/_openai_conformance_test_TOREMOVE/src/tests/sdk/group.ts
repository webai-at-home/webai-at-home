// local imports
import type { ConformanceTest } from '../../types.js';
import { sdkBasicTest } from './basic.js';
import { sdkModelsListTest } from './models_list.js';
import { sdkStreamingTest } from './streaming.js';
import { sdkToolsTest } from './tools.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	sdkGroup — the same requests again, through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every test in the `sdk` folder, which answer the most practical definition of compatibility
 * there is: can an existing Node.js application point its `baseURL` at this endpoint and keep
 * working?
 *
 * These deliberately repeat requests the raw groups already made. A response can look correct when
 * read by hand and still make the official package throw, and a stream can be readable with a
 * regular expression and still trip its parser. The point is the second transport, not new
 * requests.
 */
export const sdkGroup: readonly ConformanceTest[] = [
	sdkModelsListTest,
	sdkBasicTest,
	sdkStreamingTest,
	sdkToolsTest,
];
