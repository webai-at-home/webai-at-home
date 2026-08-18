// local imports
import type { ConformanceTest } from '../../types.js';
import { chatBasicTest } from './basic.js';
import { chatSystemMessageTest } from './system_message.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	chatGroup — a basic completion and a system message
//
//	Single-turn tests only. Anything a history is needed to ask belongs to the `history` group.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every test in the `chat` folder, in the order they are run and printed. */
export const chatGroup: readonly ConformanceTest[] = [
	chatBasicTest,
	chatSystemMessageTest,
];
