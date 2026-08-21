import {
	InterruptableStoppingCriteria,
	TextStreamer,
	type TextGenerationPipeline,
} from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ThinkingGeneration — one generation with enable_thinking set one way, recorded whole
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

/** What one generation is asked for. */
export type ThinkingRequest = {
	/** The question put to the model, as one user message. */
	prompt: string;
	/** The largest number of tokens the answer may hold, passed as `max_new_tokens`. */
	maxNewTokens: number;
	/** What to pass as `enable_thinking`, which is the one thing that changes between two runs of a phase. */
	isThinkingEnabled: boolean;
};

/** Everything one generation produced, recorded before anything is concluded from it. */
export type ThinkingRecord = {
	/** What was asked for, kept beside what came back so a record can be read on its own. */
	request: ThinkingRequest;
	/** The answer decoded with `skip_special_tokens: false`, which is the text as the model wrote it. */
	rawText: string;
	/** The same token identifiers decoded with `skip_special_tokens: true`. */
	strippedText: string;
	/**
	 * The answer with every thought channel removed, and every special token gone.
	 *
	 * This is the text a consumer would be given once the worker has taken the thinking out, so it is the field that
	 * says whether an answer was ever written at all.
	 */
	answerText: string;
	/** Whether the model opened a thought channel, which is what thinking looks like in the raw text. */
	hasOpenedAThoughtChannel: boolean;
	/** Whether the model closed the thought channel it opened, which is what finishing thinking looks like. */
	hasClosedAThoughtChannel: boolean;
	/** Every token identifier the model generated, in order. */
	tokenIds: number[];
	/** How many tokens the model generated, which is the completion token count a consumer would be charged. */
	generatedTokenCount: number;
	/** How long the generation took, in milliseconds. */
	wallMs: number;
	/** Whether the answer stopped at {@link ThinkingRequest.maxNewTokens} rather than ending on its own. */
	isCutOffByTheTokenLimit: boolean;
	/** The error the run threw, or `undefined` when it finished. */
	error: string | undefined;
};

/**
 * Runs one generation with `enable_thinking` set one way, and records everything about it.
 *
 * Nothing here concludes anything. Every phase of this page reads the records it asked for and says what they mean, so
 * a person can check a verdict against the raw text the model wrote rather than take it on trust.
 *
 * The call shape is the one `stage_helper_llm_gemma_4_e2b_full.ts` makes for a history that declared no tool: a
 * message list, `return_full_text: false`, `tokenizer_encode_kwargs`, an `InterruptableStoppingCriteria`, and a
 * `TextStreamer`. The only thing this page changes is what goes into `tokenizer_encode_kwargs.enable_thinking`, which
 * that stage writes out as the literal `false` today whatever the consumer asked for.
 */
export class ThinkingGeneration {
	/**
	 * Runs one generation.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param request What to generate, and with thinking on or off.
	 * @returns The whole record of the run, including the error when it threw.
	 */
	static async run(generator: TextGenerationPipeline, request: ThinkingRequest): Promise<ThinkingRecord> {
		const tokenIds: number[] = [];
		const criteria = new InterruptableStoppingCriteria();

		// The streamer earns its place by counting raw tokens through `token_callback_function`, which is how the real
		// stage counts them. Nothing is forwarded anywhere here, so the text callback is left empty.
		const streamer = new TextStreamer(generator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: () => {},
			token_callback_function: (newTokens: bigint[]) => {
				for (const tokenId of newTokens) {
					tokenIds.push(Number(tokenId));
				}
			},
		});

		const startedAt = performance.now();
		let error: string | undefined = undefined;
		try {
			await generator([{ role: 'user', content: request.prompt }], {
				max_new_tokens: request.maxNewTokens,
				do_sample: false,
				return_full_text: false,
				tokenizer_encode_kwargs: { enable_thinking: request.isThinkingEnabled },
				stopping_criteria: criteria,
				streamer: streamer,
			});
		} catch (thrown: unknown) {
			error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
		}
		const wallMs = performance.now() - startedAt;
		const decoded = ThinkingGeneration.decodedBothWays(generator, tokenIds);

		return {
			request: request,
			rawText: decoded.rawText,
			strippedText: decoded.strippedText,
			answerText: ThinkingGeneration.answerTextOf(generator, tokenIds),
			hasOpenedAThoughtChannel: decoded.rawText.includes(CHANNEL_OPEN_TOKEN),
			hasClosedAThoughtChannel: decoded.rawText.includes(CHANNEL_CLOSE_TOKEN),
			tokenIds: tokenIds,
			generatedTokenCount: tokenIds.length,
			wallMs: wallMs,
			isCutOffByTheTokenLimit: tokenIds.length >= request.maxNewTokens,
			error: error,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The answer a consumer would receive: every thought channel taken out, and every special token gone.
	 *
	 * Cut on the token identifiers rather than on the decoded text, for two reasons. A cut made on text would have to
	 * keep the special tokens in so that the channel markers could be found, and would then have to take them out again
	 * by hand — leaving the answer carrying whatever it failed to take out, the end-of-turn token for one. And cutting
	 * on identifiers is what lets the surviving tokens be decoded with `skip_special_tokens: true`, which is the
	 * decoding a consumer is served.
	 *
	 * Which tokens survive is decided the way the `strip_thinking` macro of this model's own chat template decides it:
	 * everything outside an opening and a closing channel marker is kept, everything between them is dropped, and the
	 * result is trimmed. Reimplemented against that macro rather than guessed at, because a page that took the thinking
	 * out its own way would report an answer the real template would never produce.
	 *
	 * @param generator The loaded text-generation pipeline, read for its tokenizer.
	 * @param tokenIds The token identifiers the model generated, in order.
	 * @returns The answer with every thought channel removed and every special token gone.
	 */
	private static answerTextOf(generator: TextGenerationPipeline, tokenIds: readonly number[]): string {
		const decode = (generator.tokenizer as unknown as {
			decode: (tokenIds: number[], options: Record<string, unknown>) => string;
		}).decode;
		const answerTokenIds: number[] = [];
		let isInsideAChannel = false;
		for (const tokenId of tokenIds) {
			// Decoded one token at a time, so a channel marker is recognised by being that whole token rather than by the
			// marker's characters turning up inside a longer piece of text the model happened to write.
			const tokenText = decode.call(generator.tokenizer, [tokenId], { skip_special_tokens: false });
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
		return decode.call(generator.tokenizer, answerTokenIds, { skip_special_tokens: true }).trim();
	}

	/**
	 * The same token identifiers decoded twice, so the special tokens are visible and their absence is too.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param tokenIds The token identifiers the model generated.
	 * @returns The two decodings.
	 */
	private static decodedBothWays(
		generator: TextGenerationPipeline,
		tokenIds: number[],
	): { rawText: string; strippedText: string } {
		const decode = (generator.tokenizer as unknown as {
			decode: (tokenIds: number[], options: Record<string, unknown>) => string;
		}).decode;
		return {
			rawText: decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: false }),
			strippedText: decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: true }),
		};
	}
}
