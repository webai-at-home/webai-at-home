import {
	LogitsProcessor,
	LogitsProcessorList,
	StoppingCriteria,
	StoppingCriteriaList,
	type Tensor,
} from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SampledTokenForwarder — makes the `onTokensSampled` calls released @huggingface/transformers 4.2.0 never makes
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * A logits processor that wants to be told which token the sampler chose.
 *
 * `ConstraintLogitsProcessor` of `@huggingface/transformers-response-constraint` is one: it masks the
 * logits from the grammar state in `_call`, and advances that grammar state in `onTokensSampled`.
 * Without the second half it masks every step from the same state and constrains nothing.
 */
export type OnTokensSampledProcessor = {
	/**
	 * Called with the token the sampler chose for this generation step.
	 *
	 * @param tokenIds One token identifier per sequence. The response constraint refuses any length
	 * but 1.
	 * @param inputIds Every token of every sequence, with the sampled token already appended.
	 */
	onTokensSampled(tokenIds: number[], inputIds: bigint[][]): void;
};

/** The response constraint's two halves, as `ResponseConstraint.fromResponseFormat` returns them. */
export type ResponseConstraintPair = {
	/** A `LogitsProcessorList` holding one `ConstraintLogitsProcessor`. */
	logits_processor: LogitsProcessorList;
	/** A `ConstraintStoppingCriteria` reading the same grammar state as that processor. */
	stopping_criteria: StoppingCriteria;
};

/**
 * A response constraint with the missing `onTokensSampled` calls restored, ready to pass into a
 * generation call.
 */
export type ForwardedResponseConstraint = {
	/** The forwarder followed by the constraint's own processor, in that order. */
	logitsProcessor: LogitsProcessorList;
	/** The forwarder's criterion followed by the constraint's own criterion, in that order. */
	stoppingCriteria: StoppingCriteriaList;
};

/**
 * Restores the `onTokensSampled` calls that released `@huggingface/transformers` 4.2.0 never makes.
 *
 * `@huggingface/transformers-response-constraint` advances its grammar in
 * `ConstraintLogitsProcessor.onTokensSampled`, a method that
 * [pull request #1733](https://github.com/huggingface/transformers.js/pull/1733) adds to
 * `LogitsProcessorList` and calls from the generation loop of `modeling_utils.js`. That pull request
 * has been open since 31 July 2026 and is not in the released 4.2.0 this project installs, where
 * `LogitsProcessorList` has no such method and the generation loop makes no such call. So the
 * package, used exactly as its own README says, masks every step from the grammar's opening state
 * and constrains nothing — a run that looks constrained, reports no error, and constrains nothing.
 *
 * Nothing about the released 4.2.0 makes that unrecoverable, because the sampled token is already in
 * `input_ids`. `PreTrainedModel.generate` appends it to `all_input_ids` immediately after sampling,
 * and hands the same array to every logits processor on the next step and to every stopping
 * criterion on this one. So a processor placed before the constraint's own can read the tokens that
 * appeared since it last looked and announce them, and a criterion placed before the constraint's
 * own can do the same before the constraint is asked whether it is finished.
 *
 * Both halves are needed, and the second is not an optimisation. A logits processor is called before
 * the sampler, so the token that satisfies the grammar is only visible to the processor on a step
 * that would never happen — the run has already stopped. Announcing from the stopping criterion as
 * well is what lets the constraint's own criterion see a grammar that is complete on the step it
 * completed, rather than one token late or never.
 *
 * Measured live against Gemma 4 E2B in milestone 0 of
 * [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221): without these calls a
 * schema asking for one city wrote 256 tokens of whitespace and was cut off; with them it wrote
 * `{"city": "Paris"}` in 8 tokens.
 */
export class SampledTokenForwarder {
	/** The constraint's processor, which is told about every token the sampler chooses. */
	private readonly processor: OnTokensSampledProcessor;

	/**
	 * How many tokens the first sequence held the first time this forwarder looked at it, which is
	 * the prompt.
	 *
	 * `undefined` until the first look. Everything from this offset onwards was chosen by the
	 * sampler.
	 */
	private promptLength: number | undefined = undefined;

	/** How many sampled tokens have been announced, so the same token is never announced twice. */
	private announcedCount = 0;

	/**
	 * @param processor The constraint's logits processor, the one that wants to be told what was
	 * sampled.
	 */
	constructor(processor: OnTokensSampledProcessor) {
		this.processor = processor;
	}

	/**
	 * Whether the installed `@huggingface/transformers` calls `onTokensSampled` on its own.
	 *
	 * Read off the class rather than assumed from a version number, because the whole point of this
	 * file is that the released package and the pull request's package carry the same version,
	 * `4.2.0`, and differ here.
	 *
	 * @returns `true` when `LogitsProcessorList` carries the method, which means this forwarder is
	 * not needed.
	 */
	static isHookCalledByTheRuntime(): boolean {
		const prototype = LogitsProcessorList.prototype as unknown as Record<string, unknown>;
		return typeof prototype.onTokensSampled === 'function';
	}

	/**
	 * Wraps a response constraint so that its grammar advances on released
	 * `@huggingface/transformers` 4.2.0.
	 *
	 * @param constraint What `ResponseConstraint.fromResponseFormat` returned.
	 * @returns The list and the criteria to pass into the generation call, with the forwarder first
	 * in both.
	 * @throws When the constraint's list does not hold exactly one processor, because then the order
	 * this depends on is no longer known and a silently unconstrained run is the failure that would
	 * follow.
	 */
	static around(constraint: ResponseConstraintPair): ForwardedResponseConstraint {
		const processors = constraint.logits_processor.processors;
		if (processors.length !== 1) {
			throw new Error(
				`ResponseConstraint returned ${processors.length} logits processors, and this forwarder is written `
				+ 'for the one it returned on 20 August 2026. Read the package again before going further.',
			);
		}
		const forwarder = new SampledTokenForwarder(processors[0] as OnTokensSampledProcessor);

		const logitsProcessor = new LogitsProcessorList();
		logitsProcessor.push(new ForwardingLogitsProcessor(forwarder));
		logitsProcessor.push(processors[0] as LogitsProcessor);

		const stoppingCriteria = new StoppingCriteriaList();
		stoppingCriteria.push(new ForwardingStoppingCriteria(forwarder));
		stoppingCriteria.push(constraint.stopping_criteria);

		return {
			logitsProcessor: logitsProcessor,
			stoppingCriteria: stoppingCriteria,
		};
	}

	/**
	 * Announces every token that appeared in the first sequence since the last look.
	 *
	 * @param inputIds Every token of every sequence, as the generation loop keeps them.
	 * @returns Nothing. Announcing the same token twice is impossible, and announcing nothing is
	 * normal.
	 */
	announceNewTokens(inputIds: bigint[][]): void {
		const sequence = inputIds[0];
		if (sequence === undefined) {
			return;
		}
		if (this.promptLength === undefined) {
			this.promptLength = sequence.length;
			return;
		}
		for (let index = this.promptLength + this.announcedCount; index < sequence.length; ++index) {
			this.announcedCount += 1;
			this.processor.onTokensSampled([Number(sequence[index])], inputIds);
		}
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The two places the generation loop lets this page look at the sampled tokens
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Announces the newly sampled tokens, then leaves the logits exactly as they arrived. */
class ForwardingLogitsProcessor extends LogitsProcessor {
	/** The forwarder that knows which tokens have already been announced. */
	private readonly forwarder: SampledTokenForwarder;

	/**
	 * @param forwarder The forwarder to announce through.
	 */
	constructor(forwarder: SampledTokenForwarder) {
		super();
		this.forwarder = forwarder;
	}

	/**
	 * @param inputIds Every token of every sequence, as the generation loop keeps them.
	 * @param logits The logits of this step, passed straight on.
	 * @returns The same logits, untouched, so the constraint's own processor masks them next.
	 */
	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		this.forwarder.announceNewTokens(inputIds);
		return logits;
	}
}

/** Announces the newly sampled tokens, then stops nothing itself. */
class ForwardingStoppingCriteria extends StoppingCriteria {
	/** The forwarder that knows which tokens have already been announced. */
	private readonly forwarder: SampledTokenForwarder;

	/**
	 * @param forwarder The forwarder to announce through.
	 */
	constructor(forwarder: SampledTokenForwarder) {
		super();
		this.forwarder = forwarder;
	}

	/**
	 * The declared parameter type is `number[][]`, which is what `StoppingCriteria` of
	 * `@huggingface/transformers` 4.2.0 declares. The generation loop really passes `bigint[][]`, the
	 * same `all_input_ids` every logits processor is given, which is why the value is read back as
	 * that.
	 *
	 * @param inputIds Every token of every sequence, with this step's sampled token already appended.
	 * @returns `false` for every sequence, because this criterion exists to announce and never to
	 * stop.
	 */
	_call(inputIds: number[][]): boolean[] {
		this.forwarder.announceNewTokens(inputIds as unknown as bigint[][]);
		return inputIds.map(() => false);
	}
}
