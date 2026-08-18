// local imports
import type { ConformanceTest } from '../../types.js';
import { structuredOutputJsonObjectTest } from './json_object.js';
import { structuredOutputJsonSchemaTest } from './json_schema.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	structuredOutputGroup — json_object and json_schema, reported separately
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every test in the `structured_output` folder. The two are reported separately because supporting
 * `json_object` says nothing about supporting `json_schema`.
 */
export const structuredOutputGroup: readonly ConformanceTest[] = [
	structuredOutputJsonObjectTest,
	structuredOutputJsonSchemaTest,
];
