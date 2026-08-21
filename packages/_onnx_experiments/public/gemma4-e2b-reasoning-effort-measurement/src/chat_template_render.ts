import { type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ChatTemplateRender — renders one history through the chat template with enable_thinking both ways
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One history rendered through the chat template under one setting of `enable_thinking`. */
export type RenderedPrompt = {
	/** What `enable_thinking` was set to for this render. */
	isThinkingEnabled: boolean;
	/** The prompt as text, rendered with `tokenize: false`, character for character. */
	text: string;
	/** How many tokens the same render produces with `tokenize: true`, which is what the model is fed. */
	tokenCount: number;
};

/** The same history rendered twice, once with `enable_thinking: false` and once with `true`. */
export type RenderedBothWays = {
	/** The render with `enable_thinking: false`, which is what the stage helper passes today. */
	withThinkingOff: RenderedPrompt;
	/** The render with `enable_thinking: true`. */
	withThinkingOn: RenderedPrompt;
	/** Whether the two renders are the same text, character for character. */
	areTheSame: boolean;
};

/**
 * Renders one history through Gemma 4 E2B's own chat template with `enable_thinking` set both ways, and reports both
 * renders whole.
 *
 * This is the measurement [issue #223](https://github.com/webai-at-home/webai-at-home/issues/223) rests on. The one
 * assumption that would make the issue impossible is that this model's chat template ignores `enable_thinking`, and
 * two identical renders is what ignoring looks like. It is the same measurement
 * [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) used on Qwen3.5-0.8B, where `false` closed
 * the thinking block in the prompt and `true` left it open, 43 tokens against 41.
 *
 * The option is passed exactly as `stage_helper_llm_gemma_4_e2b_full.ts` passes it — to `apply_chat_template`, beside
 * `add_generation_prompt: true` and the tool declarations — so that a difference found here is a difference the real
 * stage would get.
 */
export class ChatTemplateRender {
	/**
	 * Renders one history both ways.
	 *
	 * @param generator The loaded text-generation pipeline, read for its tokenizer's chat template.
	 * @param messages The history to render, as the message list the template takes.
	 * @param tools The tool declarations to render beside it, empty when the history declared none.
	 * @returns Both renders, and whether they are the same.
	 */
	static bothWays(
		generator: TextGenerationPipeline,
		messages: readonly unknown[],
		tools: readonly unknown[],
	): RenderedBothWays {
		const withThinkingOff = ChatTemplateRender.oneWay(generator, messages, tools, false);
		const withThinkingOn = ChatTemplateRender.oneWay(generator, messages, tools, true);
		return {
			withThinkingOff: withThinkingOff,
			withThinkingOn: withThinkingOn,
			areTheSame: withThinkingOff.text === withThinkingOn.text,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Renders one history under one setting of `enable_thinking`, as text and as a token count.
	 *
	 * Rendered twice rather than once, because the text says what changed and the token count says whether the change
	 * reaches the model. A template that reads the option changes both.
	 *
	 * @param generator The loaded text-generation pipeline, read for its tokenizer's chat template.
	 * @param messages The history to render.
	 * @param tools The tool declarations to render beside it, empty when the history declared none.
	 * @param isThinkingEnabled What to pass as `enable_thinking`.
	 * @returns The render.
	 */
	private static oneWay(
		generator: TextGenerationPipeline,
		messages: readonly unknown[],
		tools: readonly unknown[],
		isThinkingEnabled: boolean,
	): RenderedPrompt {
		const applyChatTemplate = (generator.tokenizer as unknown as {
			apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => unknown;
		}).apply_chat_template;
		const toolsOption = tools.length === 0 ? {} : { tools: tools };

		const text = applyChatTemplate.call(generator.tokenizer, [...messages], {
			tokenize: false,
			add_generation_prompt: true,
			enable_thinking: isThinkingEnabled,
			...toolsOption,
		}) as string;
		const tokenized = applyChatTemplate.call(generator.tokenizer, [...messages], {
			tokenize: true,
			add_generation_prompt: true,
			enable_thinking: isThinkingEnabled,
			return_dict: false,
			...toolsOption,
		}) as { data?: ArrayLike<number> };

		return {
			isThinkingEnabled: isThinkingEnabled,
			text: text,
			tokenCount: tokenized.data?.length ?? 0,
		};
	}
}
