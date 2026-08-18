// npm imports
import OpenAI from 'openai';

// local imports
import type { CompletionTarget } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OpenaiPackageClient — the client for the tests that ask whether an existing Node.js
//	application, unmodified, keeps working against this endpoint
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Wraps the official `openai` Node.js package, pointed at the endpoint under test. */
export class OpenaiPackageClient {
	/** The official `openai` Node.js package client, pointed at `target`. */
	readonly client: OpenAI;

	/**
	 * @param target The endpoint every request is sent to.
	 */
	constructor(target: CompletionTarget) {
		this.client = new OpenAI({
			baseURL: target.baseUrl,
			apiKey: target.apiKey,
			timeout: target.timeoutMs,
		});
	}
}
