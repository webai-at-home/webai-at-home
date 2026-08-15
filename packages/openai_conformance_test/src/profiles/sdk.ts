// local imports
import { sdkBasicTest } from '../tests/sdk/basic.js';
import { sdkModelsListTest } from '../tests/sdk/models_list.js';
import { sdkStreamingTest } from '../tests/sdk/streaming.js';
import { sdkToolsTest } from '../tests/sdk/tools.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	sdk — the same requests again, through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The official package tests of section 21 of issue #181, which answer the most practical
 * definition of compatibility there is: can an existing Node.js application point its `baseURL` at
 * this endpoint and keep working?
 *
 * These deliberately repeat requests the raw groups already made. A response can look correct when
 * read by hand and still make the official package throw, and a stream can be readable with a
 * regular expression and still trip its parser. The point is the second transport, not new
 * requests.
 */
export const sdkProfile: readonly ConformanceTest[] = [sdkModelsListTest, sdkBasicTest, sdkStreamingTest, sdkToolsTest];
