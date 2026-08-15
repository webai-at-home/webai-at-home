// local imports
import { structuredOutputJsonObjectTest } from '../tests/structured_output/json_object.js';
import { structuredOutputJsonSchemaTest } from '../tests/structured_output/json_schema.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	structured_output — json_object and json_schema, reported separately
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The structured output tests of section 17 of issue #181. The two are reported separately
 * because supporting `json_object` says nothing about supporting `json_schema`.
 */
export const structuredOutputProfile: readonly ConformanceTest[] = [structuredOutputJsonObjectTest, structuredOutputJsonSchemaTest];
