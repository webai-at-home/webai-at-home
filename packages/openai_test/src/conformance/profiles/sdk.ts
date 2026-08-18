// local imports
import { sdkGroup } from '../conformance_tests/sdk/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	sdk — the same requests again, through the official `openai` Node.js package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The official package tests of section 21 of issue #181, which are exactly the `sdk` group, and
 * the only group using `context.openaiPackageClient` directly. Declared in
 * `../tests/sdk/group.ts`.
 */
export const sdkProfile: readonly ConformanceTest[] = sdkGroup;
