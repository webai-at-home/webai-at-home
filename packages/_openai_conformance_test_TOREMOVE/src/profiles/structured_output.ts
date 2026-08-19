// local imports
import { structuredOutputGroup } from '../tests/structured_output/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	structured_output — json_object and json_schema, reported separately
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The structured output tests of section 17 of issue #181, which are exactly the
 * `structured_output` group, declared in `../tests/structured_output/group.ts`.
 */
export const structuredOutputProfile: readonly ConformanceTest[] = structuredOutputGroup;
