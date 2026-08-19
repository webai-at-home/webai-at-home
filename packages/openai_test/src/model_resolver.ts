// local imports
import type { RawHttpClient } from './clients/raw_http_client.js';
import { JsonResponseReader } from './readers/json_response_reader.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelResolver — reads the model identifiers the endpoint's own GET /models names
//
//	This is the only listing this package has: it knows nothing about which models any particular
//	server holds. Every subcommand names the one model it works with, and reads this listing only
//	to answer `-m/--model list`, so a server whose listing is incomplete, or which serves none at
//	all, can still be worked with by naming its model in full.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Reads the model identifiers one endpoint lists. */
export class ModelResolver {
	/**
	 * Reads every model identifier the endpoint's own `GET /models` names.
	 *
	 * @param rawHttpClient The client to ask, pointed at the endpoint under test.
	 * @returns The model identifiers, in the order the endpoint listed them.
	 * @throws {Error} If the endpoint refused the request or answered with a body this cannot read,
	 * since `-m/--model list` was asked for a listing and there is none to print.
	 */
	static async listModelIds(rawHttpClient: RawHttpClient): Promise<string[]> {
		const { status, json } = await rawHttpClient.listModels();
		if (status !== 200) {
			throw new Error(`GET /models answered HTTP ${status}: ${JSON.stringify(json)}`);
		}
		const data = JsonResponseReader.asRecord(json)?.['data'];
		if (Array.isArray(data) === false) {
			throw new Error(`GET /models answered a body with no "data" array: ${JSON.stringify(json)}`);
		}
		const modelIds: string[] = [];
		for (const entry of data) {
			const modelId = JsonResponseReader.asRecord(entry)?.['id'];
			if (typeof modelId === 'string' && modelId !== '' && modelIds.includes(modelId) === false) {
				modelIds.push(modelId);
			}
		}
		if (modelIds.length === 0) {
			throw new Error(`GET /models named no model at all: ${JSON.stringify(json)}`);
		}
		return modelIds;
	}
}
