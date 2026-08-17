// local imports
import { parametersGroup } from '../tests/parameters/group.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	parameters — whether each generation control is honoured, not merely accepted
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The parameter tests of section 10 of issue #181, which are exactly the `parameters` group. Which
 * controls are measured, and why `frequency_penalty` and `presence_penalty` are left out, is
 * declared in `../tests/parameters/group.ts`.
 */
export const parametersProfile: readonly ConformanceTest[] = parametersGroup;
