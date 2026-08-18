// local imports
import type { RawHttpClient } from './clients/raw_http_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	EndpointReachability — one request before the run, so nothing listening stops it at once
//
//	Without this, a run against an endpoint nothing is listening on walks the whole profile and
//	reports every single test as a `FAIL` that only ever says the connection was refused, or sends
//	every warm-up and measured request of a benchmark to nobody. One request answers that question
//	before the first measurement is made.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Answers whether anything at all is listening at an endpoint, before a run starts measuring it. */
export class EndpointReachability {
	/**
	 * Sends one `GET /models` before the first test or the first measured request.
	 *
	 * Only a thrown error stops the run: an endpoint that answers with any HTTP status at all,
	 * including `404` for a server that does not implement `GET /models`, is a reachable endpoint,
	 * and whether it implements that route is a test result rather than a runner error.
	 *
	 * @param rawHttpClient The client to send the request with.
	 * @param baseUrl The endpoint being reached, named in the error message.
	 * @returns Nothing, once the endpoint has answered.
	 * @throws {Error} If the request throws: a refused connection, an unknown host, or a timeout.
	 */
	static async assertReachable(rawHttpClient: RawHttpClient, baseUrl: string): Promise<void> {
		try {
			await rawHttpClient.listModels();
		} catch (error) {
			throw new Error(
				`${baseUrl} could not be reached: ${EndpointReachability.describeError(error)}. `
					+ 'Start the server, or point --base_url at one that is already running.',
			);
		}
	}

	/**
	 * Describes a thrown value in one line, unwrapping the causes Node.js hides a connection
	 * refusal inside: `fetch` throws `fetch failed`, whose `cause` is an `AggregateError` carrying
	 * no message of its own, whose own `errors` hold the one line worth printing.
	 *
	 * @param error The thrown value.
	 * @returns The message to print.
	 */
	static describeError(error: unknown): string {
		if (error instanceof Error === false) {
			return String(error);
		}
		const messages: string[] = [];
		let current: unknown = error;
		while (current instanceof Error) {
			if (current.message.length > 0) {
				messages.push(current.message);
			}
			const aggregated = (current as AggregateError).errors;
			if (Array.isArray(aggregated) && aggregated.length > 0) {
				current = aggregated[0];
				continue;
			}
			current = current.cause;
		}
		return messages.join(': ');
	}
}
