import { type PreTrainedTokenizer } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ThoughtChannelCut — takes Gemma 4 E2B's own thinking out of an answer, on the token identifiers
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The token this model's chat template opens a channel with, named `soc_token` in the tokenizer configuration.
 *
 * The template writes thinking as `<|channel>thought\n…\n<channel|>`, so an answer that thought carries this token.
 */
const CHANNEL_OPEN_TOKEN = '<|channel>';

/** The token this model's chat template closes a channel with, named `eoc_token` in the tokenizer configuration. */
const CHANNEL_CLOSE_TOKEN = '<channel|>';

/**
 * Takes every thought channel out of an answer Gemma 4 E2B generated, so that the model's own thinking never reaches
 * the consumer that asked for it.
 *
 * Nothing in this cluster carries a model's thinking beside its answer — `ResponsesTranslator` says so where it
 * leaves a `reasoning` item out — so an answer generated with thinking on has to arrive with the thinking already
 * gone. Milestone 1 of [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223) measured what happens
 * without this: a consumer asking for `reasoning_effort: "high"` was answered
 * `"thought\nThinking Process:\n\n1.  **Analyze the Request:** …The capital of France is Paris."`, where the same
 * request through the native worker was answered `"The capital of France is Paris."` — the local server puts the
 * thinking in a `reasoning` field of its own, and `OpenaiApiClient` reads only `content`. Two workers of one task
 * type must keep a control the same way, so this is what makes the browser tab match.
 *
 * Cut on the token identifiers rather than on the decoded text, for two reasons. A cut made on text would have to
 * keep the special tokens in so that the channel markers could be found, and would then have to take them out again
 * by hand — which is the list of the model's own markers written into this repository that
 * {@link StageHelperLlmGemma4E2bFull.answerTextOf} already refuses to keep. And cutting on identifiers is what lets
 * the surviving tokens be decoded with `skip_special_tokens: true`, which is the decoding a consumer is served.
 *
 * Which tokens survive is decided the way the `strip_thinking` macro of this model's own chat template decides it:
 * everything outside an opening and a closing channel marker is kept, and everything between them is dropped.
 * Reimplemented against that macro rather than guessed at, so that this file and the template agree about where an
 * answer begins.
 */
export class ThoughtChannelCut {
	/**
	 * Every token identifier that is not inside a thought channel, in order.
	 *
	 * A channel opened and never closed drops everything after it, which is the honest answer: the model was still
	 * thinking when generation ended, so it never began an answer. Milestone 0 of issue #223 measured that this model
	 * closes its thinking on both a settled question and a question with a step to work out, in 114 and 327 completion
	 * tokens against a 1024-token limit, so an answer that never leaves its thinking is the rare case here rather than
	 * the usual one — unlike Qwen3.5-0.8B, which issue #192 watched run to a 2048-token limit without ever closing.
	 *
	 * @param tokenizer The tokenizer the answer was generated with, decoded one token at a time to recognise a marker.
	 * @param tokenIds Every token identifier the model generated for this answer, in order.
	 * @returns The identifiers to decode into the answer, which is every one outside a thought channel.
	 */
	static outsideEveryChannel(tokenizer: PreTrainedTokenizer, tokenIds: readonly number[]): number[] {
		const decode = (tokenizer as unknown as {
			decode: (tokenIds: number[], options: Record<string, unknown>) => string;
		}).decode;
		const answerTokenIds: number[] = [];
		let isInsideAChannel = false;
		for (const tokenId of tokenIds) {
			// Decoded one token at a time, so a channel marker is recognised by being that whole token rather than by
			// the marker's characters turning up inside a longer piece of text the model happened to write.
			const tokenText = decode.call(tokenizer, [tokenId], { skip_special_tokens: false });
			if (tokenText === CHANNEL_OPEN_TOKEN) {
				isInsideAChannel = true;
				continue;
			}
			if (tokenText === CHANNEL_CLOSE_TOKEN) {
				isInsideAChannel = false;
				continue;
			}
			if (isInsideAChannel === false) {
				answerTokenIds.push(tokenId);
			}
		}
		return answerTokenIds;
	}
}
