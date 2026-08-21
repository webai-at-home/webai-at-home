///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StopSequenceWatcher — stops an answer at a consumer's stop sequence, without ever forwarding it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Watches an answer as it is generated and reports where a consumer's stop sequence begins.
 *
 * A stop sequence cannot be applied by the consumer filtering the pieces it is sent. A model
 * writes an answer in pieces of its own choosing, and a stop sequence can straddle two of them:
 * a consumer asking to stop at `\nUser:` may have the `\n` arrive in one piece and `User:` in the
 * next. A piece already forwarded cannot be taken back either, so this holds back the last few
 * characters of the answer — as many as the longest stop sequence needs, less one — until enough
 * has been generated to know they begin no stop sequence.
 *
 * The stop sequence itself is never forwarded. The answer a consumer receives ends where the stop
 * sequence began, which is what the OpenAI Chat Completions interface's `stop` means.
 *
 * This file is a character for character copy of
 * `packages/worker_webpage/web/src/stages/stop_sequence_watcher.ts`, the one
 * `stage_helper_llm_qwen3_5_0_8b_full.ts` already runs. It is copied rather than imported for two
 * reasons: `packages/_onnx_experiments/CONTEXT.md` keeps every experiment standalone and prefers a
 * copied helper over a coupled one, and the measurement has to be of the watcher the real stage
 * would use rather than of one written for this page. Milestone 1 of
 * [issue #222](https://github.com/webai-at-home/webai-at-home/issues/222) reuses the original,
 * exactly as the qwen stage helper does; nothing here is what would ship.
 */
export class StopSequenceWatcher {
	/** The stop sequences the consumer asked to stop at, in the order they were asked for. */
	private readonly stopSequences: readonly string[];
	/**
	 * How many characters are held back while no stop sequence has been seen.
	 *
	 * One less than the longest stop sequence: a held-back tail that long is the most that can
	 * turn out to be the beginning of a stop sequence, and holding back more would delay the
	 * answer for nothing.
	 */
	private readonly heldBackLength: number;
	/** Everything the model has generated so far, joined. */
	private generatedSoFar = '';
	/** How much of {@link generatedSoFar} has already been forwarded. */
	private forwardedLength = 0;
	/** Whether a stop sequence has been found, after which nothing more is ever forwarded. */
	private stopped = false;

	/**
	 * @param stopSequences The stop sequences the consumer asked to stop at. An empty list makes
	 * this watcher forward every chunk whole, holding nothing back.
	 */
	constructor(stopSequences: readonly string[]) {
		this.stopSequences = stopSequences;
		this.heldBackLength = stopSequences.length === 0
			? 0
			: Math.max(...stopSequences.map((stopSequence) => stopSequence.length)) - 1;
	}

	/** Whether generation has reached a stop sequence and must stop. */
	get hasStopped(): boolean {
		return this.stopped;
	}

	/**
	 * Takes one chunk of generated text and reports how much of the answer may now be forwarded.
	 *
	 * @param chunk The text the model has just generated.
	 * @returns The text to forward now, which is empty whenever everything new is still held back
	 * or a stop sequence has already been found.
	 */
	accept(chunk: string): string {
		if (this.stopSequences.length === 0) {
			return chunk;
		}
		if (this.stopped === true) {
			return '';
		}
		this.generatedSoFar += chunk;
		for (const stopSequence of this.stopSequences) {
			const stopIndex = this.generatedSoFar.indexOf(stopSequence);
			if (stopIndex === -1) {
				continue;
			}
			this.stopped = true;
			return this.forwardUpTo(stopIndex);
		}
		return this.forwardUpTo(Math.max(0, this.generatedSoFar.length - this.heldBackLength));
	}

	/**
	 * Releases whatever is still held back, once generation has ended without a stop sequence.
	 *
	 * Nothing may be held back from a finished answer: there is no chunk after the last one to
	 * release it, so an answer that ended on its own must add up to everything the model wrote.
	 *
	 * @returns The text still held back, and an empty string when a stop sequence was found or
	 * nothing is held back.
	 */
	flush(): string {
		if (this.stopped === true) {
			return '';
		}
		return this.forwardUpTo(this.generatedSoFar.length);
	}

	/**
	 * Forwards the answer up to one position, and remembers how much has been forwarded.
	 *
	 * @param position How much of the answer generated so far may be forwarded, in characters.
	 * @returns The text between what was already forwarded and that position.
	 */
	private forwardUpTo(position: number): string {
		if (position <= this.forwardedLength) {
			return '';
		}
		const text = this.generatedSoFar.slice(this.forwardedLength, position);
		this.forwardedLength = position;
		return text;
	}
}
