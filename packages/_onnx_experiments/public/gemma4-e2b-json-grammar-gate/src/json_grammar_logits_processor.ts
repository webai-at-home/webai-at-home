import { LogitsProcessor, type Tensor } from '@huggingface/transformers';
import { JsonGrammar, type JsonGrammarState } from './json_grammar';
import type { VocabularyTable } from './vocabulary_table';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonGrammarLogitsProcessor — masks every entry of the vocabulary that would break the JSON
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one step of masking cost, and what it left legal. */
export type MaskingStepReading = {
	/** Which generated token this step chose, counted from zero. */
	stepIndex: number;
	/** The signature of the grammar state this step masked for. */
	signature: string;
	/** How many entries of the vocabulary the grammar left legal. */
	legalCount: number;
	/** Whether the mask for this signature had already been worked out at an earlier step. */
	wasReused: boolean;
	/** How long this step spent inside the processor, in milliseconds. */
	milliseconds: number;
};

/**
 * A logits processor that masks every entry of the vocabulary that would break the JSON being written.
 *
 * This is the whole idea of structured output in one class: the ONNX graph's job ends at the
 * logits, the choice of token happens after it in JavaScript, and this sits between the two. At
 * every step it advances a {@link JsonGrammar} reader over the tokens generated so far, asks the
 * reader which entries of the vocabulary may legally come next, and sets every other score to
 * negative infinity.
 *
 * Two rules cover the entries a grammar has nothing to say about. While the value is unfinished,
 * every special entry and every unusable entry is masked out, so the model cannot end its turn in
 * the middle of an object. Once the value is finished, the end-of-sequence entries are the only
 * ones left legal, so the run stops cleanly rather than writing trailing whitespace for as long as
 * its budget allows.
 *
 * The masks are kept, keyed by {@link JsonGrammar.signatureOf}, because two states with the same
 * signature accept exactly the same texts. Without that, every step scans the whole vocabulary, and
 * what that costs is one of the things milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) exists to measure — so
 * both numbers are recorded, per step, in {@link JsonGrammarLogitsProcessor.stepReadings}.
 */
export class JsonGrammarLogitsProcessor extends LogitsProcessor {
	/** The text every entry of the vocabulary writes. */
	private readonly vocabularyTable: VocabularyTable;

	/** The identifiers that end a sequence for this model. */
	private readonly endOfSequenceTokenIds: readonly number[];

	/** The reader, advanced over the tokens the model has generated. */
	private readonly state: JsonGrammarState;

	/** One mask per grammar state signature seen so far, each holding the legal identifiers. */
	private readonly masksBySignature = new Map<string, number[]>();

	/** How many token identifiers `all_input_ids` held on the first call, which is the prompt length. */
	private promptTokenCount: number | undefined = undefined;

	/** How many generated tokens the reader has already been advanced over. */
	private consumedTokenCount = 0;

	/** What every step cost and what it left legal, in the order the steps happened. */
	readonly stepReadings: MaskingStepReading[] = [];

	/** The first token the reader refused to read, when the mask let something illegal through. */
	refusedTokenText: string | undefined = undefined;

	/**
	 * @param vocabularyTable The text every entry of the vocabulary writes.
	 * @param endOfSequenceTokenIds The identifiers that end a sequence for this model.
	 * @param isTopLevelObjectRequired Whether the answer has to be one object, as `json_object` asks.
	 */
	constructor(
		vocabularyTable: VocabularyTable,
		endOfSequenceTokenIds: readonly number[],
		isTopLevelObjectRequired: boolean,
	) {
		super();
		this.vocabularyTable = vocabularyTable;
		this.endOfSequenceTokenIds = endOfSequenceTokenIds;
		this.state = JsonGrammar.initialState(isTopLevelObjectRequired);
	}

	/**
	 * How many distinct grammar state signatures the run went through.
	 *
	 * @returns The number of masks that had to be worked out from the vocabulary.
	 */
	get distinctSignatureCount(): number {
		return this.masksBySignature.size;
	}

	/**
	 * Masks every entry of the vocabulary the grammar would refuse.
	 *
	 * @param inputIds Every token identifier so far, per batch item.
	 * @param logits The scores of the next token, one row per batch item.
	 * @returns The same logits, with every illegal entry set to negative infinity.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		const startedAt = performance.now();
		if (this.promptTokenCount === undefined) {
			this.promptTokenCount = inputIds[0].length;
		}
		this._advanceOverGeneratedTokens(inputIds[0]);

		const signature = JsonGrammar.signatureOf(this.state);
		const alreadyWorkedOut = this.masksBySignature.get(signature);
		const legalTokenIds = alreadyWorkedOut ?? this._legalTokenIdsNow();
		if (alreadyWorkedOut === undefined) {
			this.masksBySignature.set(signature, legalTokenIds);
		}

		const rows = logits as unknown as { [index: number]: { data: Float32Array } };
		for (let batchIndex = 0; batchIndex < inputIds.length; batchIndex = batchIndex + 1) {
			const scores = rows[batchIndex].data;
			const keptScores = legalTokenIds.map((tokenId) => scores[tokenId]);
			scores.fill(Number.NEGATIVE_INFINITY);
			for (const [position, tokenId] of legalTokenIds.entries()) {
				const score = keptScores[position];
				scores[tokenId] = Number.isFinite(score) === true ? score : 0;
			}
		}

		this.stepReadings.push({
			stepIndex: inputIds[0].length - this.promptTokenCount,
			signature: signature,
			legalCount: legalTokenIds.length,
			wasReused: alreadyWorkedOut !== undefined,
			milliseconds: performance.now() - startedAt,
		});
		return logits;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Advances the reader over every generated token it has not read yet.
	 *
	 * A special entry is stepped over rather than read, because the grammar has nothing to say about
	 * a marker. Anything else the reader refuses is recorded, because a token the reader refuses is
	 * a token the mask should never have left legal, and finding one would mean this class is wrong.
	 *
	 * @param batchInputIds Every token identifier so far, for the first batch item.
	 * @returns Nothing.
	 */
	private _advanceOverGeneratedTokens(batchInputIds: bigint[]): void {
		const promptTokenCount = this.promptTokenCount ?? batchInputIds.length;
		const generatedCount = batchInputIds.length - promptTokenCount;
		for (let index = this.consumedTokenCount; index < generatedCount; index = index + 1) {
			const tokenId = Number(batchInputIds[promptTokenCount + index]);
			if (this.vocabularyTable.kindOf(tokenId) !== 'text') {
				continue;
			}
			const text = this.vocabularyTable.textOf(tokenId);
			if (JsonGrammar.acceptText(this.state, text) === false && this.refusedTokenText === undefined) {
				this.refusedTokenText = text;
			}
		}
		this.consumedTokenCount = generatedCount;
	}

	/**
	 * Every entry of the vocabulary the grammar allows at the point the reader has reached.
	 *
	 * @returns The legal token identifiers, in ascending order.
	 */
	private _legalTokenIdsNow(): number[] {
		if (JsonGrammar.isComplete(this.state) === true) {
			return [...this.endOfSequenceTokenIds];
		}
		const legalTokenIds: number[] = [];
		for (let tokenId = 0; tokenId < this.vocabularyTable.size; tokenId = tokenId + 1) {
			if (this.vocabularyTable.kindOf(tokenId) !== 'text') {
				continue;
			}
			if (JsonGrammar.acceptsText(this.state, this.vocabularyTable.textOf(tokenId)) === true) {
				legalTokenIds.push(tokenId);
			}
		}
		return legalTokenIds;
	}
}
