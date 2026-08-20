import { LogitsProcessor, type Tensor } from '@huggingface/transformers';
import type { CompiledSchemaNode } from './json_schema_compiler';
import { JsonSchemaGrammar, type JsonSchemaGrammarState } from './json_schema_grammar';
import type { JsonSchemaMaskCache } from './json_schema_mask_cache';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonSchemaLogitsProcessor — masks every entry that would break the schema, and times each step
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one step of masking cost, and what it left legal. */
export type MaskingStepReading = {
	/** Which generated token this step chose, counted from zero. */
	stepIndex: number;
	/** The signature of the grammar state this step masked for. */
	signature: string;
	/** How many entries of the vocabulary the mask names, which is not always how many are legal. */
	namedCount: number;
	/** Whether those named entries are the ones kept rather than the ones removed. */
	namesTheEntriesToKeep: boolean;
	/** Whether the mask for this signature had already been worked out at an earlier step. */
	wasReused: boolean;
	/** How long this step spent inside the processor, in milliseconds. */
	milliseconds: number;
};

/**
 * A logits processor that masks every entry of the vocabulary that would break the schema.
 *
 * This is `json_grammar_logits_processor.ts` of milestone 1 with the schema in place of the plain
 * JSON grammar, and with the step by step timing milestone 0 used to measure what masking costs. It
 * exists to answer the one question milestone 6 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) rests on: whether a mask
 * can hold this model to a schema, and at what price.
 *
 * A schema mask is narrower than a `json_object` mask at almost every step, so it should be cheaper
 * to apply. What it is not obviously cheaper at is being worked out: a schema state carries which
 * keys have been written and how far into a key the model is, so a run reaches many more distinct
 * states than the eight milestone 0 measured, and each new state scans the whole vocabulary once.
 * {@link JsonSchemaLogitsProcessor.stepReadings} is what tells the two apart.
 */
export class JsonSchemaLogitsProcessor extends LogitsProcessor {
	/** The masks of this model's vocabulary under this schema. */
	private readonly maskCache: JsonSchemaMaskCache;

	/** The compiled schema the answer has to satisfy. */
	private readonly nodes: readonly CompiledSchemaNode[];

	/** The reader, advanced over the tokens the model has generated. */
	private readonly state: JsonSchemaGrammarState;

	/** How many token identifiers the first call was handed, which is the length of the prompt. */
	private promptTokenCount: number | undefined = undefined;

	/** How many generated tokens the reader has already been advanced over. */
	private consumedTokenCount = 0;

	/** What every step cost and what it left legal, in the order the steps happened. */
	readonly stepReadings: MaskingStepReading[] = [];

	/** The first token the reader refused to read, when the mask let something illegal through. */
	refusedTokenText: string | undefined = undefined;

	/**
	 * @param maskCache The masks of this model's vocabulary under this schema.
	 * @param nodes The compiled schema, whose node at index 0 is the whole answer's own.
	 */
	constructor(maskCache: JsonSchemaMaskCache, nodes: readonly CompiledSchemaNode[]) {
		super();
		this.maskCache = maskCache;
		this.nodes = nodes;
		this.state = JsonSchemaGrammar.initialState(0);
	}

	/**
	 * How many distinct grammar state signatures the run went through.
	 *
	 * @returns The number of masks that had to be worked out from the vocabulary.
	 */
	get distinctSignatureCount(): number {
		return this.maskCache.workedOutMaskCount;
	}

	/**
	 * Whether the value is finished, so that the answer written so far satisfies the schema.
	 *
	 * @returns `true` when a complete value has been written.
	 */
	get isComplete(): boolean {
		return JsonSchemaGrammar.isComplete(this.nodes, this.state);
	}

	/**
	 * Masks every entry of the vocabulary the schema would refuse.
	 *
	 * @param inputIds Every token identifier so far, per batch item.
	 * @param logits The scores of the next token, one row per batch item.
	 * @returns The same logits, masked in place. Returning them is required, not a convenience.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		const startedAt = performance.now();
		if (this.promptTokenCount === undefined) {
			this.promptTokenCount = inputIds[0].length;
		}
		this._advanceOverGeneratedTokens(inputIds[0]);
		const signature = JsonSchemaGrammar.signatureOf(this.state);
		const workedOutBefore = this.maskCache.workedOutMaskCount;
		const mask = this.maskCache.maskFor(this.state);
		const rows = logits as unknown as { [index: number]: { data: Float32Array } };
		for (let batchIndex = 0; batchIndex < inputIds.length; batchIndex = batchIndex + 1) {
			this.maskCache.apply(mask, rows[batchIndex].data);
		}
		this.stepReadings.push({
			stepIndex: inputIds[0].length - this.promptTokenCount,
			signature: signature,
			namedCount: mask.tokenIds.length,
			namesTheEntriesToKeep: mask.namesTheEntriesToKeep,
			wasReused: this.maskCache.workedOutMaskCount === workedOutBefore,
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
	 * a marker. Anything else the reader refuses is recorded rather than thrown, because this page is
	 * measuring and a refusal here is one of the things worth reporting: a token the reader refuses
	 * is a token the mask should never have left legal.
	 *
	 * @param batchInputIds Every token identifier so far, for the first batch item.
	 * @returns Nothing.
	 */
	private _advanceOverGeneratedTokens(batchInputIds: bigint[]): void {
		const promptTokenCount = this.promptTokenCount ?? batchInputIds.length;
		const generatedCount = batchInputIds.length - promptTokenCount;
		for (let index = this.consumedTokenCount; index < generatedCount; index = index + 1) {
			const tokenId = Number(batchInputIds[promptTokenCount + index]);
			if (this.maskCache.vocabularyTable.kindOf(tokenId) !== 'text') {
				continue;
			}
			const text = this.maskCache.vocabularyTable.textOf(tokenId);
			if (JsonSchemaGrammar.acceptText(this.nodes, this.state, text) === false && this.refusedTokenText === undefined) {
				this.refusedTokenText = text;
			}
		}
		this.consumedTokenCount = generatedCount;
	}
}
