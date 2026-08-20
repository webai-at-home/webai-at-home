import { LogitsProcessor, type Tensor } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ForcedTokenLogitsProcessor — leaves exactly one entry of the vocabulary usable at every step
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A logits processor that forces a written-down sequence of tokens, one per step.
 *
 * This is the smallest possible proof that a mask decides the output rather than merely being
 * applied to it. Reading the source of `@huggingface/transformers` proves the processor is reached;
 * it cannot prove that setting a score to negative infinity keeps the sampler away from that entry
 * for this model, at this quantization, on WebGPU. So the mask here leaves exactly one entry usable
 * at every step, and the answer is checked against the sequence that was written down: if the model
 * wrote the forced sequence, the mask decided the output, and there is no other explanation for a
 * model writing a sequence chosen to be one it would never write on its own.
 *
 * Once the written-down sequence runs out, the end-of-sequence entry is the only one left, so the
 * run stops rather than carrying on unmasked.
 */
export class ForcedTokenLogitsProcessor extends LogitsProcessor {
	/** The token identifiers to force, in order, one per generated token. */
	private readonly forcedTokenIds: readonly number[];

	/** The identifiers that end a sequence for this model, one of which is left legal at the end. */
	private readonly endOfSequenceTokenIds: readonly number[];

	/** How many token identifiers `all_input_ids` held on the first call, which is the prompt length. */
	private promptTokenCount: number | undefined = undefined;

	/** How many times this processor has been called. */
	callCount = 0;

	/**
	 * @param forcedTokenIds The token identifiers to force, in order, one per generated token.
	 * @param endOfSequenceTokenIds The identifiers that end a sequence for this model.
	 */
	constructor(forcedTokenIds: readonly number[], endOfSequenceTokenIds: readonly number[]) {
		super();
		this.forcedTokenIds = forcedTokenIds;
		this.endOfSequenceTokenIds = endOfSequenceTokenIds;
	}

	/**
	 * Masks every entry of the vocabulary except the one this step is meant to write.
	 *
	 * @param inputIds Every token identifier so far, per batch item.
	 * @param logits The scores of the next token, one row per batch item.
	 * @returns The same logits, with every entry but one set to negative infinity.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		this.callCount = this.callCount + 1;
		if (this.promptTokenCount === undefined) {
			this.promptTokenCount = inputIds[0].length;
		}
		const generatedCount = inputIds[0].length - this.promptTokenCount;
		const allowedTokenIds = generatedCount < this.forcedTokenIds.length
			? [this.forcedTokenIds[generatedCount]]
			: this.endOfSequenceTokenIds;
		const rows = logits as unknown as { [index: number]: { data: Float32Array } };
		for (let batchIndex = 0; batchIndex < inputIds.length; batchIndex = batchIndex + 1) {
			const scores = rows[batchIndex].data;
			// The model's own score for the entry is kept, so the mask is the only thing that changed.
			// A score that is already negative infinity is replaced by zero, because a row that is
			// negative infinity throughout would leave the sampler nothing to choose and the run would
			// prove nothing about masking.
			const keptScores = allowedTokenIds.map((tokenId) => {
				const score = scores[tokenId];
				return Number.isFinite(score) === true ? score : 0;
			});
			scores.fill(Number.NEGATIVE_INFINITY);
			for (const [position, tokenId] of allowedTokenIds.entries()) {
				scores[tokenId] = keptScores[position];
			}
		}
		return logits;
	}
}
