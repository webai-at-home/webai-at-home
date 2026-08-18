// local imports
import type { ConformanceTest } from '../../types.js';
import { errorsMalformedJsonTest } from './malformed_json.js';
import { errorsMissingMessagesTest } from './missing_messages.js';
import { errorsUnknownModelTest } from './unknown_model.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	errorsGroup — whether a bad request is refused with an error rather than answered
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every test in the `errors` folder, in the order they are run and printed. */
export const errorsGroup: readonly ConformanceTest[] = [
	errorsUnknownModelTest,
	errorsMalformedJsonTest,
	errorsMissingMessagesTest,
];
