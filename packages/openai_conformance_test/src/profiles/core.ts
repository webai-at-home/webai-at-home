// local imports
import { chatBasicTest } from '../tests/chat/basic.js';
import { chatMultiTurnTest } from '../tests/chat/multi_turn.js';
import { chatSystemMessageTest } from '../tests/chat/system_message.js';
import { errorsMalformedJsonTest } from '../tests/errors/malformed_json.js';
import { errorsMissingMessagesTest } from '../tests/errors/missing_messages.js';
import { errorsUnknownModelTest } from '../tests/errors/unknown_model.js';
import { modelsListTest } from '../tests/models/list.js';
import { usagePresentTest } from '../tests/usage/present.js';
import { usageTotalIsSumTest } from '../tests/usage/total_is_sum.js';
import type { ConformanceTest } from '../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	core — model discovery, basic chat completions, usage, and errors
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The `core` profile named in section 5 of issue #181: model discovery, basic chat completions,
 * usage, and errors. What an implementation must pass to claim compatibility with the smallest
 * well-defined subset of the OpenAI Chat Completions interface, run in the order printed.
 */
export const coreProfile: readonly ConformanceTest[] = [
	modelsListTest,
	chatBasicTest,
	chatSystemMessageTest,
	chatMultiTurnTest,
	usagePresentTest,
	usageTotalIsSumTest,
	errorsUnknownModelTest,
	errorsMalformedJsonTest,
	errorsMissingMessagesTest,
];
