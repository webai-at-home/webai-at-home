// local imports
import type { ConformanceTest } from '../../types.js';
import { chatBasicTest } from './basic.js';
import { chatMultiTurnTest } from './multi_turn.js';
import { chatSystemMessageTest } from './system_message.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	chatGroup — a basic completion, a system message, and a multi-turn history
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every test in the `chat` folder, in the order they are run and printed. */
export const chatGroup: readonly ConformanceTest[] = [
	chatBasicTest,
	chatSystemMessageTest,
	chatMultiTurnTest,
];
