// npm imports
import type OpenAI from 'openai';

// local imports
import { CompletionSender } from './clients/completion_sender.js';
import type { RawHttpClient } from './clients/raw_http_client.js';
import { JsonResponseReader } from './readers/json_response_reader.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelResolver — expands -m/--model into the model identifiers to work through
//
//	`all` and a pattern are answered from the endpoint's own `GET /models`, which is the only
//	listing this package has: it knows nothing about which models any particular server holds.
//	A name typed out in full is sent as it stands, so a server whose listing is incomplete, or
//	which serves no listing at all, can still be measured by naming its models.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `-m/--model` expanded to, and where those identifiers came from. */
export type ModelSelection = {
	/** The model identifiers to work through, in the order they will be run. */
	readonly modelIds: readonly string[];
	/**
	 * Whether these identifiers were read out of the endpoint's own `GET /models` rather than typed
	 * out in full.
	 *
	 * This decides whether each one is proved to answer under its own name before it is measured.
	 * A listing names models the endpoint cannot serve a chat completion with — LM Studio lists its
	 * embedding models beside its chat models, with no field telling the two apart — while a name
	 * somebody typed is a name somebody meant.
	 */
	readonly isFromEndpointListing: boolean;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelResolver
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Expands one `-m/--model` option into the model identifiers to work through. */
export class ModelResolver {
	/** The prompt one model is proved usable with, kept short because its answer is never read. */
	private static readonly _probePrompt = 'Say hello.';

	/**
	 * Reads every model identifier the endpoint's own `GET /models` names.
	 *
	 * @param rawHttpClient The client to ask, pointed at the endpoint under test.
	 * @returns The model identifiers, in the order the endpoint listed them.
	 * @throws {Error} If the endpoint refused the request or answered with a body this cannot read,
	 * which stops the run: a sweep that cannot read the listing has nothing to sweep.
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

	/**
	 * Expands `-m/--model` into the model identifiers to work through.
	 *
	 * `all` and any part carrying a `*` are answered from `GET /models`, which is asked for only
	 * when one of them appears — a run naming its models in full never needs the listing, and so
	 * still works against an endpoint that serves none.
	 *
	 * @param rawModel `all`; one model identifier; a pattern with `*` standing for any run of
	 * characters; or a comma-separated list of any mix of the three. Never `list`, which the caller
	 * handles before this is called.
	 * @param rawHttpClient The client to read `GET /models` with, when it is needed.
	 * @returns The model identifiers to work through, without duplicates, and whether they came
	 * from the endpoint's listing.
	 * @throws {Error} If `-m/--model` named nothing, or if a pattern matched no listed model.
	 */
	static async resolve(rawModel: string, rawHttpClient: RawHttpClient): Promise<ModelSelection> {
		const parts = rawModel
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		if (parts.length === 0) {
			throw new Error('-m/--model named no model at all');
		}

		const isListingNeeded = parts.some((part) => part === 'all' || part.includes('*'));
		if (isListingNeeded === false) {
			return {
				modelIds: [...new Set(parts)],
				isFromEndpointListing: false,
			};
		}

		const universe = await ModelResolver.listModelIds(rawHttpClient);
		const matched = new Set<string>();
		const typedOut: string[] = [];
		for (const part of parts) {
			if (part === 'all') {
				for (const modelId of universe) {
					matched.add(modelId);
				}
				continue;
			}
			if (part.includes('*') === true) {
				for (const modelId of ModelResolver._matchModelIds(part, universe)) {
					matched.add(modelId);
				}
				continue;
			}
			// A name typed out in full alongside a pattern is still a name somebody meant, so it is
			// kept even when the endpoint's listing does not carry it.
			if (universe.includes(part) === true) {
				matched.add(part);
			} else if (typedOut.includes(part) === false) {
				typedOut.push(part);
			}
		}
		return {
			modelIds: [...universe.filter((modelId) => matched.has(modelId)), ...typedOut],
			isFromEndpointListing: true,
		};
	}

	/**
	 * Proves one model can answer a chat completion under its own name, before anything is measured
	 * against it.
	 *
	 * This is the gate Milestone 0 of
	 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208) concluded a sweep
	 * needs. An OpenAI-compatible `GET /models` carries no field saying what a model can do, so its
	 * listing holds embedding models beside chat models with nothing to tell them apart. Worse, LM
	 * Studio 0.4.20 answers a request naming a model it cannot serve with HTTP 200 generated by
	 * whichever model happens to be loaded, so a sweep with no gate would record a full set of
	 * passing verdicts for a model that never produced one of them.
	 *
	 * The check itself is `CompletionSender.send`'s own: it compares the model identifier the
	 * endpoint named in its answer against the one that was requested, and throws when they differ.
	 *
	 * @param client The official `openai` Node.js package client, pointed at the endpoint under test.
	 * @param modelId The model identifier to prove.
	 * @returns `undefined` when the model answered under its own name, or the reason it is left out.
	 */
	static async probeUsable(client: OpenAI, modelId: string): Promise<string | undefined> {
		try {
			await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: ModelResolver._probePrompt,
					},
				],
				mode: 'nostream',
			});
			return undefined;
		} catch (error: unknown) {
			return CompletionSender.describeFailure(error);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Matches one pattern against the model identifiers the endpoint listed.
	 *
	 * @param part A pattern with `*` standing for any run of characters.
	 * @param universe The model identifiers the endpoint listed.
	 * @returns The matching model identifiers.
	 * @throws {Error} If nothing matches, which is a mistake on the command line rather than a
	 * result worth reporting.
	 */
	private static _matchModelIds(part: string, universe: readonly string[]): string[] {
		const regularExpressionSource = part
			.split('*')
			.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*');
		const regularExpression = new RegExp(`^${regularExpressionSource}$`);
		const matches = universe.filter((modelId) => regularExpression.test(modelId));
		if (matches.length === 0) {
			throw new Error(`No model matches "${part}". The endpoint lists: ${universe.join(', ')}`);
		}
		return matches;
	}
}
