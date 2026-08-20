import { JsonSchemaGrammar, type CompiledSchemaNode, type JsonSchemaGrammarState } from '@webai/protocol';
import type { VocabularyTable } from './vocabulary_table.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonSchemaMaskCache — works out which entries of the vocabulary a schema state allows, once
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One worked-out mask, naming whichever of the two sets of entries is the smaller.
 *
 * A mask could always name the entries it keeps, and naming them is the obvious way to write one.
 * It is also the slow way, and milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) measured how slow:
 * applying a mask cost 47 milliseconds while 261040 entries were legal and 0.0 milliseconds while
 * 384 were, on the same machine, with the mask already worked out both times. Inside a string
 * almost the whole vocabulary is legal, so a mask that names what it keeps clears the row and
 * writes a quarter of a million scores back at every step of every string.
 *
 * So a mask names the entries it removes when they are the fewer, and the entries it keeps when
 * they are. Both cases are then a few hundred writes rather than a few hundred thousand.
 */
export type GrammarMask = {
	/** The token identifiers this mask names, in ascending order. */
	tokenIds: number[];
	/**
	 * Whether {@link GrammarMask.tokenIds} are the entries to keep rather than the entries to remove.
	 *
	 * `true` means every entry not named is set to negative infinity. `false` means every entry named
	 * is set to negative infinity and nothing else is touched.
	 */
	namesTheEntriesToKeep: boolean;
};

/**
 * The masks a JSON grammar produces over one tokenizer's vocabulary, worked out once each and kept.
 *
 * One of these belongs to a loaded model rather than to a task, and every task generating with that
 * model shares it. Two things make that worth doing:
 *
 * - The mask a grammar state produces depends only on the state and the vocabulary, never on the
 *   task, so a mask worked out for one answer is exactly right for the next.
 * - There are few distinct states. Milestone 0 of
 *   [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) reached **8** distinct
 *   states across the 36 steps of one answer under `json_object`, and milestone 6 measured 13 to 26
 *   under a schema, against answers of 20 to 60 steps. Shared across tasks, the scans happen once
 *   for the life of the loaded model and the schema rather than once per answer, and a reused mask
 *   costs 0.06 milliseconds against a scan's 55.
 */
export class JsonSchemaMaskCache {
	/** The text every entry of the vocabulary writes. */
	readonly vocabularyTable: VocabularyTable;

	/** The identifiers that end a sequence for this model, and the only ones legal once a value is finished. */
	private readonly endOfSequenceTokenIds: readonly number[];

	/** One mask per grammar state signature seen so far. */
	private readonly masksBySignature = new Map<string, GrammarMask>();

	/** The compiled schema every answer masked by this cache has to satisfy. */
	private readonly nodes: readonly CompiledSchemaNode[];

	/**
	 * @param vocabularyTable The text every entry of the vocabulary writes.
	 * @param endOfSequenceTokenIds The identifiers that end a sequence for this model.
	 * @param nodes The compiled schema. One cache belongs to one schema as well as to one model,
	 * because a mask is what a state of **this** schema allows: a state signature names schema node
	 * indices, so the same signature means something else under another schema.
	 */
	constructor(vocabularyTable: VocabularyTable, endOfSequenceTokenIds: readonly number[], nodes: readonly CompiledSchemaNode[]) {
		this.vocabularyTable = vocabularyTable;
		this.endOfSequenceTokenIds = endOfSequenceTokenIds;
		this.nodes = nodes;
	}

	/** How many distinct grammar states this cache has worked a mask out for. */
	get workedOutMaskCount(): number {
		return this.masksBySignature.size;
	}

	/**
	 * The mask for one grammar state, worked out on the first sight of that state and kept after.
	 *
	 * @param state The grammar state the next token has to continue.
	 * @returns The mask, which the caller must not change.
	 * @throws When no entry of the vocabulary could legally come next, because masking every entry
	 * would leave the sampler nothing to choose and the answer would be nonsense rather than a
	 * refusal.
	 */
	maskFor(state: JsonSchemaGrammarState): GrammarMask {
		const signature = JsonSchemaGrammar.signatureOf(state);
		const alreadyWorkedOut = this.masksBySignature.get(signature);
		if (alreadyWorkedOut !== undefined) {
			return alreadyWorkedOut;
		}
		const mask = this._workOutMask(state, signature);
		this.masksBySignature.set(signature, mask);
		return mask;
	}

	/**
	 * Applies one mask to one row of scores, in place.
	 *
	 * @param mask The mask to apply.
	 * @param scores The scores of the next token, one per entry of the vocabulary.
	 * @returns Nothing.
	 */
	apply(mask: GrammarMask, scores: Float32Array): void {
		if (mask.namesTheEntriesToKeep === false) {
			for (const tokenId of mask.tokenIds) {
				scores[tokenId] = Number.NEGATIVE_INFINITY;
			}
			return;
		}
		// The model's own score for a kept entry is kept, so the mask is the only thing that changed
		// and the model still chooses between what is legal. A score that is already negative infinity
		// is replaced by zero, because a row that is negative infinity throughout would leave the
		// sampler nothing to choose.
		const keptScores = mask.tokenIds.map((tokenId) => {
			const score = scores[tokenId];
			return Number.isFinite(score) === true ? score : 0;
		});
		scores.fill(Number.NEGATIVE_INFINITY);
		for (const [position, tokenId] of mask.tokenIds.entries()) {
			scores[tokenId] = keptScores[position];
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Scans the whole vocabulary and works out the mask for one grammar state.
	 *
	 * @param state The grammar state the next token has to continue.
	 * @param signature That state's signature, named in the refusal when nothing is legal.
	 * @returns The mask.
	 * @throws When no entry could legally come next.
	 */
	private _workOutMask(state: JsonSchemaGrammarState, signature: string): GrammarMask {
		// A finished value may be followed by one thing only: the end of the turn. Whitespace after it
		// would be legal JSON and is refused anyway, because a model allowed to write spaces for as
		// long as its budget lasts is a model that stops on the budget rather than on the answer.
		if (JsonSchemaGrammar.isComplete(this.nodes, state) === true) {
			if (this.endOfSequenceTokenIds.length === 0) {
				throw new Error('The model declares no end-of-sequence token, so a finished value could never be ended.');
			}
			return {
				tokenIds: [...this.endOfSequenceTokenIds],
				namesTheEntriesToKeep: true,
			};
		}

		// A space, a tab, or a line break outside a string is JSON's own layout and carries nothing, so
		// an entry writing only those is never offered. It is not a tidiness rule: a model able to
		// write a space and nothing else writes spaces until its budget is gone, because writing one
		// leaves the reader in the state it was already in and the same choice comes round again. Live
		// on Gemma 4 E2B, one masked question that the model wanted to answer in prose was answered
		// with 400 characters of nothing but spaces and line breaks, under every schema tried.
		const isInsideString = JsonSchemaGrammar.isInsideString(state);
		const size = this.vocabularyTable.size;
		// A flag per entry rather than a list, because which of the two lists is worth building is not
		// known until the scan has finished counting.
		const isLegal = new Uint8Array(size);
		let legalCount = 0;
		for (let tokenId = 0; tokenId < size; tokenId = tokenId + 1) {
			// A special entry ends the turn and an unusable entry writes an incomplete character, so a
			// grammar has nothing to say about either. Both stay masked out while a value is unfinished,
			// which is what stops a model ending its turn in the middle of an object.
			if (this.vocabularyTable.kindOf(tokenId) !== 'text') {
				continue;
			}
			const text = this.vocabularyTable.textOf(tokenId);
			if (isInsideString === false && text.trim() === '') {
				continue;
			}
			if (JsonSchemaGrammar.acceptsText(this.nodes, state, text) === true) {
				isLegal[tokenId] = 1;
				legalCount = legalCount + 1;
			}
		}
		if (legalCount === 0) {
			throw new Error(`No entry of the vocabulary can legally continue this answer, at grammar state ${signature}.`);
		}

		const namesTheEntriesToKeep = legalCount * 2 <= size;
		const tokenIds: number[] = [];
		for (let tokenId = 0; tokenId < size; tokenId = tokenId + 1) {
			if ((isLegal[tokenId] === 1) === namesTheEntriesToKeep) {
				tokenIds.push(tokenId);
			}
		}
		return {
			tokenIds: tokenIds,
			namesTheEntriesToKeep: namesTheEntriesToKeep,
		};
	}
}
