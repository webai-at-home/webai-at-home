import { LogitsProcessor, type Tensor } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationObserver — records the shapes a real pipeline call generates with, and changes nothing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Records the shapes the generation loop really works with, without touching a single logit.
 *
 * `@huggingface/transformers-response-constraint` states one limitation that decides whether this project can use it
 * at all: generation throws when the logical batch size is not 1. The text-generation pipeline tokenizes with
 * `padding: true` and this page hands it one prompt at a time, so the batch size is expected to be 1 — and expected
 * is not measured. This processor is what measures it, on the same call shape the real stage helper uses.
 *
 * It also records the vocabulary dimension of the logits, because `applyMask` of the package refuses a constraint
 * whose vocabulary is larger than that dimension, and Gemma 4 E2B's tokenizer and its logits do not have to agree.
 */
export class GenerationObserver extends LogitsProcessor {
	/** Every distinct logical batch size seen, in the order it was first seen. */
	readonly batchSizes: number[] = [];

	/** Every distinct logits shape seen, written as it reads in the tensor, in the order it was first seen. */
	readonly logitsDims: string[] = [];

	/** How many generation steps this observer was called for. */
	stepCount = 0;

	/**
	 * @param inputIds Every token of every sequence, as the generation loop keeps them.
	 * @param logits The logits of this step, passed straight on.
	 * @returns The same logits, untouched.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		this.stepCount += 1;
		if (this.batchSizes.includes(inputIds.length) === false) {
			this.batchSizes.push(inputIds.length);
		}
		const dims = JSON.stringify(logits.dims);
		if (this.logitsDims.includes(dims) === false) {
			this.logitsDims.push(dims);
		}
		return logits;
	}
}
