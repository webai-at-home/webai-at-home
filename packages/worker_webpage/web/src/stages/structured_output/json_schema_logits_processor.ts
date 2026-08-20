import { LogitsProcessor, type Tensor } from '@huggingface/transformers';
import { JsonSchemaGrammar, type CompiledSchemaNode, type JsonSchemaGrammarState } from '@webai/protocol';
import type { JsonSchemaMaskCache } from './json_schema_mask_cache.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonSchemaLogitsProcessor — makes a model write JSON matching a schema, by masking what would break it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Makes one generation produce JSON, by masking every entry of the vocabulary that would break it.
 *
 * This is the whole of structured output in one class. An ONNX graph's job ends at the logits: it
 * produces a score for every entry of the vocabulary and stops, and which entry is chosen from
 * those scores happens afterwards, in JavaScript. This sits between the two. At every step it
 * advances a {@link JsonSchemaGrammar} reader over the tokens the model has written, asks
 * {@link JsonSchemaMaskCache} which entries may legally come next, and applies the mask.
 *
 * `@huggingface/transformers` offers no way to **ask** for a shape — its `constraints` field is
 * declared and never read, and it has no grammar, no `json_schema`, and no guided decoding
 * anywhere. What it does offer is this seam, and it needs no fork and no patch. Two things about
 * the seam are not in its documentation and both fail loudly:
 *
 * - `generate()` reaches `processors.extend(logits_processor)`, and `extend` spreads what it is
 *   given, so the field takes an iterable of processors and a bare processor throws. A
 *   `LogitsProcessorList` is the shape `GenerationFunctionParameters` declares.
 * - `LogitsProcessorList` assigns each processor's return value back over the logits it passes on,
 *   so `_call` has to return the logits. The bundled type declaration says it returns `void`.
 *
 * One of these belongs to one generation, because the reader it holds is the state of one answer.
 * The cache it masks with belongs to the loaded model and is shared by every generation.
 *
 * Written for milestone 1 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219), on the strength of the
 * milestone 0 gate, which showed this model writing a bare object where the same question
 * unconstrained produced one wrapped in a markdown code fence that `JSON.parse` refuses.
 */
export class JsonSchemaLogitsProcessor extends LogitsProcessor {
	/** The masks of this model's vocabulary, shared with every other generation on the same model. */
	private readonly maskCache: JsonSchemaMaskCache;

	/** The reader, advanced over the tokens the model has written. */
	private readonly state: JsonSchemaGrammarState;

	/** How many token identifiers the first call was handed, which is the length of the prompt. */
	private promptTokenCount: number | undefined = undefined;

	/** How many written tokens the reader has already been advanced over. */
	private consumedTokenCount = 0;

	/** The compiled schema the answer has to satisfy. */
	private readonly nodes: readonly CompiledSchemaNode[];

	/**
	 * @param maskCache The masks of this model's vocabulary under this schema.
	 * @param nodes The compiled schema, whose node at index 0 is the whole answer's own. A
	 * `json_object` request compiles to `{ "type": "object" }`, so both shapes arrive here as a
	 * schema and there is one path and not two.
	 */
	constructor(maskCache: JsonSchemaMaskCache, nodes: readonly CompiledSchemaNode[]) {
		super();
		this.maskCache = maskCache;
		this.nodes = nodes;
		this.state = JsonSchemaGrammar.initialState(0);
	}

	/**
	 * Whether the value is finished, so that the answer written so far is complete JSON.
	 *
	 * A generation that runs out of its token budget in the middle of an object stops with this
	 * `false`, and the answer is a truncated object rather than an object. Nothing here can prevent
	 * that — a budget is a budget — so the stage that ran the generation reads this and says so,
	 * rather than reporting a shape it did not produce.
	 *
	 * @returns `true` when a complete JSON value has been written.
	 */
	get isComplete(): boolean {
		return JsonSchemaGrammar.isComplete(this.nodes, this.state);
	}

	/**
	 * Masks every entry of the vocabulary that could not legally continue the answer.
	 *
	 * @param inputIds Every token identifier so far, per batch item: the prompt on the first call,
	 * and the prompt with the tokens written so far on every call after it.
	 * @param logits The scores of the next token, one row per batch item.
	 * @returns The same logits, masked in place. Returning them is required, not a convenience.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		if (this.promptTokenCount === undefined) {
			this.promptTokenCount = inputIds[0].length;
		}
		this._advanceOverWrittenTokens(inputIds[0]);
		const mask = this.maskCache.maskFor(this.state);
		const rows = logits as unknown as { [index: number]: { data: Float32Array } };
		for (let batchIndex = 0; batchIndex < inputIds.length; batchIndex = batchIndex + 1) {
			this.maskCache.apply(mask, rows[batchIndex].data);
		}
		return logits;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Advances the reader over every written token it has not read yet.
	 *
	 * A special entry and an unusable entry are stepped over rather than read, because a grammar has
	 * nothing to say about a marker or about part of a character, and the mask only ever leaves a
	 * special entry legal once the value is finished.
	 *
	 * @param batchInputIds Every token identifier so far, for the first batch item.
	 * @returns Nothing.
	 * @throws When the reader refuses a token the model wrote. Every entry the mask left legal was
	 * checked against this same reader, so a refusal here means the mask and the reader disagree,
	 * and an answer generated by a mask that does not enforce the grammar it claims to is worse than
	 * a failed stage: it is prose reported as an object.
	 */
	private _advanceOverWrittenTokens(batchInputIds: bigint[]): void {
		const promptTokenCount = this.promptTokenCount ?? batchInputIds.length;
		const writtenCount = batchInputIds.length - promptTokenCount;
		for (let index = this.consumedTokenCount; index < writtenCount; index = index + 1) {
			const tokenId = Number(batchInputIds[promptTokenCount + index]);
			if (this.maskCache.vocabularyTable.kindOf(tokenId) !== 'text') {
				continue;
			}
			const text = this.maskCache.vocabularyTable.textOf(tokenId);
			if (JsonSchemaGrammar.acceptText(this.nodes, this.state, text) === false) {
				throw new Error(
					`The response format could not be enforced: the model wrote ${JSON.stringify(text)}, `
					+ 'which the JSON reader refuses, although the mask left it legal.',
				);
			}
		}
		this.consumedTokenCount = writtenCount;
	}
}
