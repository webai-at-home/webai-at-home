import {
	InterruptableStoppingCriteria,
	TextStreamer,
	type TextGenerationPipeline,
} from '@huggingface/transformers';
import { StopSequenceWatcher } from './stop_sequence_watcher';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ControlledGeneration — one generation under one set of controls, recorded whole
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one generation is asked for. */
export type GenerationRequest = {
	/** The question put to the model, as one user message. */
	prompt: string;
	/** The largest number of tokens the answer may hold, passed as `max_new_tokens`. */
	maxNewTokens: number;
	/**
	 * Whether to pass `do_sample: true`.
	 *
	 * `stage_helper_llm_gemma_4_e2b_full.ts` passes `do_sample: false` written out as a literal, whatever the consumer
	 * asked for, so every phase that asks for a temperature has to turn sampling on itself.
	 */
	isSamplingEnabled: boolean;
	/** The `temperature` to pass, or `undefined` to pass none. */
	temperature: number | undefined;
	/** The `top_p` to pass, or `undefined` to pass none. */
	topP: number | undefined;
	/**
	 * The `top_k` to pass, or `undefined` to pass none.
	 *
	 * `@huggingface/transformers` filters to the 50 highest scoring tokens of its own accord, so a `top_p` measured
	 * without `top_k: 0` beside it is measured through that filter. Issue #196 found this out on another model.
	 */
	topK: number | undefined;
	/**
	 * The stop sequences the consumer asked to stop at, empty when it asked for none.
	 *
	 * The pipeline call takes no such option, so these are applied to the generated text by
	 * {@link StopSequenceWatcher}, which is what `stage_helper_llm_qwen3_5_0_8b_full.ts` already does.
	 */
	stopSequences: readonly string[];
	/**
	 * Further options to put in the pipeline call, by the exact name they would be passed under.
	 *
	 * This exists for the phase that asks whether there is any seed to give at all: the only way to find out what an
	 * option named `seed` does is to pass one and read what comes back. Every other phase leaves this empty.
	 */
	probedOptions: Readonly<Record<string, unknown>>;
};

/** Everything one generation produced, recorded before anything is concluded from it. */
export type GenerationRecord = {
	/** What was asked for, kept beside what came back so a record can be read on its own. */
	request: GenerationRequest;
	/** The answer decoded with `skip_special_tokens: false`, which is the text as the model wrote it. */
	rawText: string;
	/** The same token identifiers decoded with `skip_special_tokens: true`, which is what a consumer would see. */
	strippedText: string;
	/**
	 * The text {@link StopSequenceWatcher} allowed through, which is the answer a consumer would have received.
	 *
	 * Equal to {@link GenerationRecord.strippedText} when the request asked for no stop sequence.
	 */
	forwardedText: string;
	/** Whether the watcher found a stop sequence and stopped the run. */
	hasStoppedOnStopSequence: boolean;
	/** Every token identifier the model generated, in order. */
	tokenIds: number[];
	/** How many tokens the model generated, which is the completion token count a consumer would be charged. */
	generatedTokenCount: number;
	/** How long the generation took, in milliseconds. */
	wallMs: number;
	/** Whether the answer stopped at {@link GenerationRequest.maxNewTokens} rather than ending on its own. */
	isCutOffByTheTokenLimit: boolean;
	/** The error the run threw, or `undefined` when it finished. */
	error: string | undefined;
};

/**
 * Runs one generation on the loaded pipeline and records everything about it.
 *
 * Nothing here concludes anything. Every phase of this page reads the records it asked for and says what they mean,
 * so a person can check a verdict against the raw text the model wrote rather than take it on trust.
 *
 * The call shape is the one `stage_helper_llm_gemma_4_e2b_full.ts` makes for a history that declared no tool: a
 * message list, `return_full_text: false`, `tokenizer_encode_kwargs: { enable_thinking: false }`, an
 * `InterruptableStoppingCriteria`, and a `TextStreamer`. Only the controls under measurement are added to it, so a
 * difference between two records is a difference the control made.
 */
export class ControlledGeneration {
	/**
	 * Runs one generation.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param request What to generate, and under which controls.
	 * @returns The whole record of the run, including the error when it threw.
	 */
	static async run(generator: TextGenerationPipeline, request: GenerationRequest): Promise<GenerationRecord> {
		const tokenIds: number[] = [];
		const criteria = new InterruptableStoppingCriteria();
		const stopSequenceWatcher = new StopSequenceWatcher(request.stopSequences);
		const forwardedPieces: string[] = [];

		const streamer = new TextStreamer(generator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (chunk: string) => {
				const forwardable = stopSequenceWatcher.accept(chunk);
				if (forwardable !== '') {
					forwardedPieces.push(forwardable);
				}
				if (stopSequenceWatcher.hasStopped === true) {
					criteria.interrupt();
				}
			},
			token_callback_function: (newTokens: bigint[]) => {
				for (const tokenId of newTokens) {
					tokenIds.push(Number(tokenId));
				}
			},
		});

		const options: Record<string, unknown> = {
			max_new_tokens: request.maxNewTokens,
			do_sample: request.isSamplingEnabled,
			return_full_text: false,
			tokenizer_encode_kwargs: { enable_thinking: false },
			stopping_criteria: criteria,
			streamer: streamer,
			...request.probedOptions,
		};
		if (request.temperature !== undefined) {
			options.temperature = request.temperature;
		}
		if (request.topP !== undefined) {
			options.top_p = request.topP;
		}
		if (request.topK !== undefined) {
			options.top_k = request.topK;
		}

		const startedAt = performance.now();
		let error: string | undefined = undefined;
		try {
			await generator([{ role: 'user', content: request.prompt }], options);
		} catch (thrown: unknown) {
			error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
		}
		const wallMs = performance.now() - startedAt;

		const remaining = stopSequenceWatcher.flush();
		if (remaining !== '') {
			forwardedPieces.push(remaining);
		}
		const decoded = ControlledGeneration.decodedBothWays(generator, tokenIds);

		return {
			request: request,
			rawText: decoded.rawText,
			strippedText: decoded.strippedText,
			forwardedText: forwardedPieces.join(''),
			hasStoppedOnStopSequence: stopSequenceWatcher.hasStopped,
			tokenIds: tokenIds,
			generatedTokenCount: tokenIds.length,
			wallMs: wallMs,
			isCutOffByTheTokenLimit: tokenIds.length >= request.maxNewTokens,
			error: error,
		};
	}

	/**
	 * A request asking for nothing but a token limit, which is the call this stage makes today.
	 *
	 * Every phase starts from this and changes the one control it is measuring, so that a difference between two
	 * records has one cause.
	 *
	 * @param prompt The question to put to the model.
	 * @param maxNewTokens The largest number of tokens the answer may hold.
	 * @returns The request.
	 */
	static greedyRequest(prompt: string, maxNewTokens: number): GenerationRequest {
		return {
			prompt: prompt,
			maxNewTokens: maxNewTokens,
			isSamplingEnabled: false,
			temperature: undefined,
			topP: undefined,
			topK: undefined,
			stopSequences: [],
			probedOptions: {},
		};
	}

	/**
	 * What one request asked for, written as the options it puts in the pipeline call.
	 *
	 * Printed above every answer, so the raw text on the page is never separated from the controls that produced it.
	 *
	 * @param request The request to describe.
	 * @returns One line naming every control the request carries.
	 */
	static describe(request: GenerationRequest): string {
		const parts: string[] = [
			`max_new_tokens=${request.maxNewTokens}`,
			`do_sample=${request.isSamplingEnabled}`,
		];
		if (request.temperature !== undefined) {
			parts.push(`temperature=${request.temperature}`);
		}
		if (request.topP !== undefined) {
			parts.push(`top_p=${request.topP}`);
		}
		if (request.topK !== undefined) {
			parts.push(`top_k=${request.topK}`);
		}
		if (request.stopSequences.length > 0) {
			parts.push(`stop=${JSON.stringify(request.stopSequences)}`);
		}
		for (const [optionName, optionValue] of Object.entries(request.probedOptions)) {
			parts.push(`${optionName}=${JSON.stringify(optionValue)}`);
		}
		return parts.join(', ');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
