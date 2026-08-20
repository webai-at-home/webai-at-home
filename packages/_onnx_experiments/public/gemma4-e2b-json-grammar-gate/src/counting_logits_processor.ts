import { LogitsProcessor, type Tensor } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CountingLogitsProcessor — changes nothing, and records that it was reached
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one logits tensor turned out to be, read on the first call and kept. */
export type LogitsTensorReading = {
	/** The tensor's dimensions, such as `[1, 262144]`. */
	dimensions: number[];
	/** The tensor's element type, as `@huggingface/transformers` names it. */
	elementType: string;
	/** The name of the object holding the numbers of the first batch item, such as `Float32Array`. */
	batchDataConstructorName: string;
	/** How many numbers the first batch item holds, which is the vocabulary the mask has to cover. */
	batchDataLength: number;
	/** How many token identifiers `all_input_ids` held on the first call, which is the prompt length. */
	firstCallInputLength: number;
};

/**
 * A logits processor that changes nothing and only counts.
 *
 * It answers the first half of the assumption milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) has to settle: is a
 * processor handed to a `pipeline('text-generation', ...)` call reached at all, once per generated
 * token, and what is it handed? Reading the source of `@huggingface/transformers` says it should
 * be. Running this says it is.
 *
 * It also settles a trap the type declarations hide. `LogitsProcessorList._call` assigns the return
 * value of every processor back over the logits it passes on, so a processor that returns nothing
 * hands `undefined` to the next one and generation fails. The bundled `.d.ts` declares `_call` as
 * returning `void`, and the real contract is to return the logits, which is what
 * `SuppressTokensLogitsProcessor` does and what every processor here does.
 */
export class CountingLogitsProcessor extends LogitsProcessor {
	/** How many times this processor has been called. */
	callCount = 0;

	/** What the logits tensor turned out to be, or `undefined` before the first call. */
	reading: LogitsTensorReading | undefined = undefined;

	/**
	 * Records the call and returns the logits untouched.
	 *
	 * @param inputIds Every token identifier so far, per batch item: the prompt on the first call,
	 * and the prompt with the tokens generated so far on every call after it.
	 * @param logits The scores of the next token, one row per batch item.
	 * @returns The same logits, unchanged.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		this.callCount = this.callCount + 1;
		if (this.reading === undefined) {
			const batchData = (logits as unknown as { [index: number]: { data: ArrayLike<number> } })[0].data;
			this.reading = {
				dimensions: [...logits.dims],
				elementType: String(logits.type),
				batchDataConstructorName: batchData.constructor.name,
				batchDataLength: batchData.length,
				firstCallInputLength: inputIds[0].length,
			};
		}
		return logits;
	}
}
