import {
	LogitsProcessorList,
	StoppingCriteriaList,
	TextStreamer,
	type InterruptableStoppingCriteria,
	type TextGenerationPipeline,
} from '@huggingface/transformers';
import { ResponseConstraint, type ResponseFormat } from './vendor/transformers_response_constraint/index.js';
import { GenerationObserver } from './generation_observer';
import { SampledTokenForwarder } from './sampled_token_forwarder';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConstrainedGeneration — one generation, with or without a response constraint, recorded whole
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one generation is asked for. */
export type GenerationRequest = {
	/** The question put to the model, as one user message. */
	prompt: string;
	/** The largest number of tokens the answer may hold. */
	maxNewTokens: number;
	/** The response format to constrain by, or `undefined` for an unconstrained generation. */
	responseFormat: ResponseFormat | undefined;
	/**
	 * Whether to restore the `onTokensSampled` calls released `@huggingface/transformers` 4.2.0 never makes.
	 *
	 * `false` is the package used exactly as its own README says, which is the arrangement that decides whether the
	 * released 4.2.0 is enough on its own.
	 */
	isForwarderUsed: boolean;
	/**
	 * Whether to pass a `TextStreamer`, as `stage_helper_llm_gemma_4_e2b_full.ts` does.
	 *
	 * The streamer is what turns an answer into pieces a consumer reads one at a time, so a constraint that only
	 * works without one is no use to this project.
	 */
	isStreamerUsed: boolean;
	/**
	 * The stage's own stopping criterion, the one that stops generation when the stream's reader cancels.
	 *
	 * `stopping_criteria` is a single option of the pipeline call, and the response constraint wants that option
	 * too, so this is the half of the call shape that has to be shown to work with both at once.
	 */
	stageStoppingCriteria: InterruptableStoppingCriteria | undefined;
};

/** Everything one generation produced, recorded before anything is concluded from it. */
export type GenerationRecord = {
	/** The answer decoded with `skip_special_tokens: false`, which is the text as the model wrote it. */
	rawText: string;
	/** The same token identifiers decoded with `skip_special_tokens: true`, which is what a consumer would see. */
	strippedText: string;
	/** The text the streamer forwarded piece by piece, empty when no streamer was passed. */
	streamedText: string;
	/** Every token identifier the model generated, in order, empty when no streamer was passed. */
	tokenIds: number[];
	/**
	 * How many tokens the model generated.
	 *
	 * Counted from the generation steps rather than from {@link GenerationRecord.tokenIds}, because a token
	 * identifier can only be read out of this pipeline through a streamer and a run that asks for no streamer has
	 * none. One generation step samples one token, so the two agree whenever both are available.
	 */
	generatedTokenCount: number;
	/** How long the generation took, in milliseconds. */
	wallMs: number;
	/** How long `ResponseConstraint.fromResponseFormat` took, in milliseconds, or `undefined` when unconstrained. */
	constraintBuildMs: number | undefined;
	/** Every distinct logical batch size the generation loop worked with. */
	batchSizes: number[];
	/** Every distinct logits shape the generation loop worked with. */
	logitsDims: string[];
	/** The error the run threw, or `undefined` when it finished. */
	error: string | undefined;
	/** Whether the answer stopped at {@link GenerationRequest.maxNewTokens} rather than ending on its own. */
	isCutOffByTheTokenLimit: boolean;
};

/**
 * Runs one generation on the loaded pipeline and records everything about it.
 *
 * Nothing here concludes anything. Every phase of this page reads the record and says what it means, so that a
 * person can check the conclusion against the raw text the model wrote rather than take it on trust.
 */
export class ConstrainedGeneration {
	/**
	 * Pays the tokenizer cost of the response constraint once, before anything is timed.
	 *
	 * `ResponseConstraint.warmup` builds the byte form of every token in the vocabulary, which the package's own
	 * documentation says costs hundreds of milliseconds for a large vocabulary. Gemma 4 E2B's is large. Leaving that
	 * cost inside the first constraint would report it as the price of constraining, which it is not: it is paid
	 * once per tokenizer, not once per request.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns How long the warmup took, in milliseconds.
	 */
	static warmup(generator: TextGenerationPipeline): number {
		const startedAt = performance.now();
		ResponseConstraint.warmup(generator.tokenizer as unknown as object);
		return performance.now() - startedAt;
	}

	/**
	 * Runs one generation.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @param request What to generate, and with what around it.
	 * @returns The whole record of the run, including the error when it threw.
	 */
	static async run(generator: TextGenerationPipeline, request: GenerationRequest): Promise<GenerationRecord> {
		const observer = new GenerationObserver();
		const tokenIds: number[] = [];
		const streamedPieces: string[] = [];

		const logitsProcessor = new LogitsProcessorList();
		logitsProcessor.push(observer);
		const stoppingCriteria = new StoppingCriteriaList();

		let constraintBuildMs: number | undefined = undefined;
		if (request.responseFormat !== undefined) {
			const startedAt = performance.now();
			const constraint = ResponseConstraint.fromResponseFormat(
				generator.tokenizer as unknown as object,
				request.responseFormat,
			);
			constraintBuildMs = performance.now() - startedAt;
			if (request.isForwarderUsed === true) {
				const forwarded = SampledTokenForwarder.around(constraint);
				logitsProcessor.extend(forwarded.logitsProcessor.processors);
				stoppingCriteria.extend(forwarded.stoppingCriteria);
			} else {
				logitsProcessor.extend(constraint.logits_processor.processors);
				stoppingCriteria.extend(constraint.stopping_criteria);
			}
		}
		if (request.stageStoppingCriteria !== undefined) {
			stoppingCriteria.extend(request.stageStoppingCriteria);
		}

		const streamer = new TextStreamer(generator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: false,
			callback_function: (chunk: string) => {
				streamedPieces.push(chunk);
			},
			token_callback_function: (newTokens: bigint[]) => {
				for (const tokenId of newTokens) {
					tokenIds.push(Number(tokenId));
				}
			},
		});
		// A streamer is the only place a token identifier can be read out of this pipeline, and the phase that asks
		// whether a streamer breaks the constraint would prove nothing if every other phase carried one. So a run
		// that asks for no streamer really has none, and reads its answer back out of what the pipeline returned.
		const options: Record<string, unknown> = {
			max_new_tokens: request.maxNewTokens,
			do_sample: false,
			return_full_text: false,
			tokenizer_encode_kwargs: { enable_thinking: false },
			logits_processor: logitsProcessor,
		};
		if (stoppingCriteria.criteria.length > 0) {
			options.stopping_criteria = stoppingCriteria;
		}
		if (request.isStreamerUsed === true) {
			options.streamer = streamer;
		}

		const startedAt = performance.now();
		let error: string | undefined = undefined;
		let returnedText = '';
		try {
			const answers = await generator([{ role: 'user', content: request.prompt }], options);
			returnedText = ConstrainedGeneration.textOf(answers);
		} catch (thrown: unknown) {
			error = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
		}
		const wallMs = performance.now() - startedAt;

		const decoded = request.isStreamerUsed === true
			? ConstrainedGeneration.decodedBothWays(generator, tokenIds)
			: { rawText: returnedText, strippedText: returnedText };

		return {
			rawText: decoded.rawText,
			strippedText: decoded.strippedText,
			streamedText: streamedPieces.join(''),
			tokenIds: tokenIds,
			generatedTokenCount: observer.stepCount,
			wallMs: wallMs,
			constraintBuildMs: constraintBuildMs,
			batchSizes: observer.batchSizes,
			logitsDims: observer.logitsDims,
			error: error,
			isCutOffByTheTokenLimit: observer.stepCount >= request.maxNewTokens,
		};
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

	/**
	 * The generated text out of whatever shape the text-generation pipeline returned.
	 *
	 * A message list is passed in, so `generated_text` comes back as the whole history with the model's answer
	 * appended as one more message, not as a string. The answer is the content of that last message.
	 *
	 * @param answers What the pipeline returned.
	 * @returns The generated text, or an empty string when the shape is not the expected one.
	 */
	private static textOf(answers: unknown): string {
		const first = Array.isArray(answers) ? answers[0] : answers;
		const inner = Array.isArray(first) ? first[0] : first;
		if (inner === null || typeof inner !== 'object' || 'generated_text' in inner === false) {
			return '';
		}
		const generated = (inner as { generated_text: unknown }).generated_text;
		if (typeof generated === 'string') {
			return generated;
		}
		if (Array.isArray(generated) === false || generated.length === 0) {
			return JSON.stringify(generated);
		}
		const lastMessage: unknown = generated[generated.length - 1];
		if (lastMessage === null || typeof lastMessage !== 'object' || 'content' in lastMessage === false) {
			return JSON.stringify(generated);
		}
		const content = (lastMessage as { content: unknown }).content;
		return typeof content === 'string' ? content : JSON.stringify(content);
	}
}
