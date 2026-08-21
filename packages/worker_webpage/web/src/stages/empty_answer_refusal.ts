///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	EmptyAnswerRefusal — refuses an answer the model ran out of room before it began
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Refuses an answer holding no text that the model stopped writing because it ran out of room,
 * rather than letting that silence be reported as a finished answer.
 *
 * A consumer receiving an empty answer cannot tell it apart from a model that genuinely had
 * nothing to say, and nothing between here and that consumer reads the answer text at all: neither
 * `packages/gateway` nor `packages/consumer_openai` looks at it. So this is the last place the two
 * can be told apart, and the stop reason is what tells them apart — the model was still generating
 * when its budget ran out, so it had more to say and no room to say it.
 *
 * Held here rather than in each stage helper because it is one rule, and four copies of one rule
 * do not stay one rule. `packages/worker_openai` keeps the same rule in one place for the same
 * reason, in `local_server_generation.ts`, and the two workers of one task type have to answer the
 * same way. See [issue #225](https://github.com/webai-at-home/webai-at-home/issues/225).
 *
 * What produces it in practice is a model that thinks before it answers and never stops thinking.
 * On Gemma 4 E2B that leaves a thought channel open to the end, and `ThoughtChannelCut` drops
 * everything after an opener that never closes, so the answer text is empty while the model
 * generated its whole budget. Milestone 0 of
 * [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223) measured that model
 * closing its thinking in 114 and 327 completion tokens against a 1024-token limit, so this is the
 * rare case rather than the usual one — and the rare case is the one nobody recognises when it
 * arrives.
 */
export class EmptyAnswerRefusal {
	/**
	 * Fails the stage when the model wrote no answer text and stopped because it ran out of room.
	 *
	 * An empty answer that ended any other way is left alone. A model that stopped of its own
	 * accord having written nothing has said what it had to say, which is what
	 * [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) decided, and a run
	 * that ended on a stop sequence or was interrupted is a caller getting what it asked for.
	 *
	 * @param answerText The answer as the consumer would receive it, after any of the model's own
	 * thinking has been cut out of it, because that cut is what can leave it empty.
	 * @param stopReason Why generation stopped, or `undefined` when generation never ran.
	 * @param completionTokenCount How many tokens the model generated, named in the failure so a
	 * consumer can see how much went nowhere, or `undefined` when this stage counts none.
	 * @param isThinkingEnabled Whether this run let the model think before it answered, which
	 * decides whether the failure names what to ask for instead.
	 * @returns Nothing.
	 * @throws If the answer holds no text and the model stopped at its output limit.
	 */
	static refuseAnswerThatRanOutBeforeItBegan(
		answerText: string,
		stopReason: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' | 'stop_sequence' | undefined,
		completionTokenCount: number | undefined,
		isThinkingEnabled: boolean,
	): void {
		if (answerText !== '') {
			return;
		}
		if (stopReason !== 'max_new_tokens') {
			return;
		}
		const generated = completionTokenCount === undefined
			? 'every token it was allowed'
			: `all ${String(completionTokenCount)} tokens it was allowed`;
		// Named only when this run really did let the model think. A stage whose model does not
		// think, or a run that asked it not to, would be told to change a setting that had nothing
		// to do with what happened.
		const thinkingAdvice = isThinkingEnabled === true
			? ' This run let the model think before it answered, and a model that thinks can do this by never finishing thinking; asking for a reasoningEffort of "none" stops it.'
			: '';
		throw new Error(`The model generated ${generated} without writing any answer text, and stopped because it ran out of room rather than because it had finished.${thinkingAdvice}`);
	}
}
