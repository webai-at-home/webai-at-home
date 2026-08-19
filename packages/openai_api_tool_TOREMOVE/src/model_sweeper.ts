///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelSweeper — expands the -m/--model option into the model identifiers to work through
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What to do with a part of `-m/--model` that names no model the subcommand knows about.
 *
 * `openai_api_tool` measures any server that speaks the OpenAI-compatible API, so `accept` is
 * what every subcommand passes: a name such as `llama-3.2-3b-instruct` on LM Studio is a name
 * this package has no list of and must pass through untouched. `reject` is kept for a caller
 * that does have a closed list of model identifiers, and wants a name outside it treated as a
 * mistake worth reporting rather than sent on.
 */
export type UnknownModelPolicy = 'reject' | 'accept';

/** Expands one `-m/--model` option into the model identifiers to work through. */
export class ModelSweeper {
	/**
	 * Expands `-m/--model` into the model identifiers to work through.
	 *
	 * @param pattern `all`; one model identifier; a pattern with `*` standing for any run of
	 * characters; or a comma-separated list of any mix of the three. Never `list`, which the
	 * caller handles before this is called.
	 * @param universe The model identifiers this subcommand knows about.
	 * @param unknownModelPolicy What to do with a name that is not in `universe`.
	 * @returns The model identifiers to work through, without duplicates. Known identifiers come
	 * first, in `universe` order, followed by any accepted unknown names in the order given.
	 * @throws {Error} If a pattern matches nothing, or if a plain name is not in `universe` while
	 * `unknownModelPolicy` is `reject`.
	 */
	static resolveModelIds(pattern: string, universe: readonly string[], unknownModelPolicy: UnknownModelPolicy): string[] {
		if (pattern === 'all') {
			return [...universe];
		}
		const parts = pattern
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		if (parts.length === 0) {
			throw new Error('--model named no model at all');
		}

		const matchedModelIds = new Set<string>();
		const unknownModelIds: string[] = [];
		for (const part of parts) {
			if (part.includes('*') === false && universe.includes(part) === false) {
				if (unknownModelPolicy === 'reject') {
					throw new Error(`No model matches "${part}". The models on offer are: ${universe.join(', ')}`);
				}
				if (unknownModelIds.includes(part) === false) {
					unknownModelIds.push(part);
				}
				continue;
			}
			for (const modelId of ModelSweeper._matchModelIds(part, universe)) {
				matchedModelIds.add(modelId);
			}
		}
		return [...universe.filter((modelId) => matchedModelIds.has(modelId)), ...unknownModelIds];
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Matches one part of `-m/--model`, after it has been split on commas, against the model
	 * identifiers the subcommand knows about.
	 *
	 * @param part One model identifier, or a pattern with `*` standing for any run of characters.
	 * @param universe The model identifiers this subcommand knows about.
	 * @returns The matching model identifiers.
	 * @throws {Error} If nothing matches.
	 */
	private static _matchModelIds(part: string, universe: readonly string[]): string[] {
		const regularExpressionSource = part
			.split('*')
			.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*');
		const regularExpression = new RegExp(`^${regularExpressionSource}$`);
		const matches = universe.filter((modelId) => regularExpression.test(modelId));
		if (matches.length === 0) {
			throw new Error(`No model matches "${part}". The models on offer are: ${universe.join(', ')}`);
		}
		return matches;
	}
}
