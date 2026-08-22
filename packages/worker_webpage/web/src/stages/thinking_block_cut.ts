///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ThinkingBlockCut — takes Qwen3.5-0.8B's own thinking out of an answer, as it is generated
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The marker this model's chat template closes a thinking block with.
 *
 * An added token of the pinned revision's own `tokenizer.json`, identifier 248069, with `special: false` — the same
 * as `<tool_call>` and `</tool_call>` — so it survives the `skip_special_tokens: true` decoding a consumer is served
 * and a cut made on the text can find it. Measured live as well as read off the file: a run with thinking on wrote
 * `"</think>\n\n"` as one piece of its answer. See
 * [issue #226](https://github.com/webai-at-home/webai-at-home/issues/226).
 */
const THINKING_CLOSE_MARKER = '</think>';

/**
 * Takes Qwen3.5-0.8B's own thinking out of an answer while the answer is still being generated, so that the model's
 * thinking never reaches the consumer that asked for it.
 *
 * Nothing in this cluster carries a model's thinking beside its answer — `ResponsesTranslator` says so where it
 * leaves a `reasoning` item out — so an answer generated with thinking on has to arrive with the thinking already
 * gone. The native worker of this same task type already answers that way, and not by accident: LM Studio puts the
 * reasoning in a field of its own and `OpenaiApiClient` reads `delta.content` and nothing else. Two workers of one
 * task type must keep a control the same way, so this is what makes the browser tab match. `ThoughtChannelCut` is
 * the same rule for Gemma 4 E2B, kept apart because the two models mark their thinking differently and neither
 * marking may be applied to the other model's answer.
 *
 * Where the answer begins is decided the way this model's own chat template decides it. Rendering a past assistant
 * message, the template separates the two with `content.split('</think>')[-1].lstrip('\n')`, so the answer is
 * everything after the closing marker with the newlines the model wrote after it dropped. Reimplemented against that
 * line rather than guessed at, so that this file and the template agree about where an answer begins.
 *
 * Cut chunk by chunk rather than over the finished text, because this stage forwards pieces of an answer to a
 * consumer that asked for pieces, and a piece already forwarded cannot be taken back. Holding the thinking back as
 * it arrives is the only way a consumer asking for pieces receives the same answer as a consumer asking for the
 * whole thing.
 *
 * Only the closing marker is watched for. The template writes the opening `<think>` into the generation prompt
 * itself rather than leaving the model to write it, and the prompt is not decoded into the answer, so a run with
 * thinking on begins inside its thinking with no opening marker anywhere in what it generates.
 */
export class ThinkingBlockCut {
	/** Whether this run let the model think, which is the only run anything is cut out of. */
	private readonly isThinkingEnabled: boolean;
	/** Whether the closing marker has been seen, after which everything the model writes is the answer. */
	private hasLeftThinking = false;
	/**
	 * The tail of the thinking kept while no closing marker has been seen.
	 *
	 * One character less than the marker, which is the most that can turn out to be the beginning of a marker
	 * split across two chunks. Everything before it is thinking and is dropped as it arrives, so a run that thinks
	 * for its whole budget holds no more than this.
	 */
	private heldBackTail = '';
	/**
	 * Whether the newlines the model writes between its closing marker and its answer are still being dropped.
	 *
	 * A flag rather than one call on the text after the marker, because those newlines can be the whole of one
	 * chunk: the measured run wrote `"</think>\n\n"` as one piece and began its answer in the next.
	 */
	private isDroppingLeadingNewlines = true;

	/**
	 * @param isThinkingEnabled Whether this run let the model think, read from the `reasoningEffort` the consumer
	 * asked for. A run that did not think writes no marker at all, and everything it writes is its answer.
	 */
	constructor(isThinkingEnabled: boolean) {
		this.isThinkingEnabled = isThinkingEnabled;
	}

	/**
	 * Whether the model has finished thinking and begun its answer.
	 *
	 * A run that ends with this still `false`, having thought for its whole budget, never began an answer at all.
	 * `EmptyAnswerRefusal` refuses that run, from the empty answer text this leaves behind.
	 */
	get hasBegunTheAnswer(): boolean {
		return this.isThinkingEnabled === false || this.hasLeftThinking === true;
	}

	/**
	 * Takes one chunk of generated text and reports how much of it belongs to the answer.
	 *
	 * @param chunk The text the model has just generated.
	 * @returns The text belonging to the answer, which is empty for as long as the model is still thinking.
	 */
	accept(chunk: string): string {
		if (this.isThinkingEnabled === false) {
			return chunk;
		}
		if (this.hasLeftThinking === true) {
			return this.withoutLeadingNewlines(chunk);
		}
		const seenSoFar = this.heldBackTail + chunk;
		const markerIndex = seenSoFar.indexOf(THINKING_CLOSE_MARKER);
		if (markerIndex === -1) {
			this.heldBackTail = seenSoFar.slice(Math.max(0, seenSoFar.length - (THINKING_CLOSE_MARKER.length - 1)));
			return '';
		}
		this.hasLeftThinking = true;
		this.heldBackTail = '';
		return this.withoutLeadingNewlines(seenSoFar.slice(markerIndex + THINKING_CLOSE_MARKER.length));
	}

	/**
	 * Drops the newlines the model writes between its closing marker and the first word of its answer.
	 *
	 * @param text The text belonging to the answer, as it arrived.
	 * @returns The same text with those newlines gone, and unchanged once the answer has begun.
	 */
	private withoutLeadingNewlines(text: string): string {
		if (this.isDroppingLeadingNewlines === false) {
			return text;
		}
		const remaining = text.replace(/^\n+/, '');
		if (remaining !== '') {
			this.isDroppingLeadingNewlines = false;
		}
		return remaining;
	}
}
