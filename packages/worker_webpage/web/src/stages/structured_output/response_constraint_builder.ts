import { StoppingCriteriaList } from '@huggingface/transformers';
import {
	ResponseConstraint,
	type ResponseFormat as PackageResponseFormat,
} from '@huggingface/transformers-response-constraint';
import type { ResponseFormat } from '@webai/protocol';
import { SampledTokenForwarder, type ForwardedResponseConstraint } from './sampled_token_forwarder.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponseConstraintBuilder — turns the response format a consumer asked for into a constraint
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The JSON Schema `@huggingface/transformers-response-constraint` takes, named here because its own
 * `index.d.ts` exports the response format and not the schema inside it.
 */
type PackageJsonSchema = Extract<PackageResponseFormat, { type: 'json_schema' }>['json_schema'];

/**
 * Builds the logits processor and the stopping criterion that make a model write the shape a
 * consumer asked for, out of `@huggingface/transformers-response-constraint`.
 *
 * Two things measured live in milestone 0 of
 * [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221) decide everything this
 * class does, and neither is in the package's own documentation.
 *
 * The first is that released `@huggingface/transformers` 4.2.0 never calls `onTokensSampled`, which
 * is where the package advances its grammar. `SampledTokenForwarder` makes those calls, and every
 * constraint built here goes through it.
 *
 * The second is the whitespace trade this class decides, below.
 */
export class ResponseConstraintBuilder {
	/**
	 * Pays the tokenizer cost of the response constraint once, so no request pays it.
	 *
	 * `ResponseConstraint.warmup` builds the byte form of every token in the vocabulary. Gemma 4
	 * E2B's vocabulary is 262144 tokens and that cost was measured at 1128 to 1534 milliseconds, once
	 * per tokenizer. A stage that does not call this pays the same cost inside its first shaped
	 * request instead, where a consumer waits for it.
	 *
	 * @param tokenizer The loaded tokenizer of the model that will generate.
	 * @returns Nothing. The package keeps what it built, keyed by the tokenizer.
	 */
	static warmup(tokenizer: object): void {
		ResponseConstraint.warmup(tokenizer);
	}

	/**
	 * Builds one constraint for one answer.
	 *
	 * @param tokenizer The loaded tokenizer of the model that will generate.
	 * @param responseFormat The shape the consumer asked its answer to be written in.
	 * @returns The logits processor and the stopping criteria to pass into the generation call.
	 * @throws TypeError when the package cannot enforce the schema, naming what it could not keep —
	 * an external reference, a dynamic reference, or an unevaluated-property assertion. Milestone 5
	 * of issue #221 refuses such a request at submission instead, by asking the package the same
	 * question; until it does, the refusal happens here and fails the stage rather than answering
	 * half-enforced.
	 */
	static build(tokenizer: object, responseFormat: ResponseFormat): ForwardedResponseConstraint {
		const constraint = ResponseConstraint.fromResponseFormat(
			tokenizer,
			ResponseConstraintBuilder.packageFormatOf(responseFormat),
		);
		if (SampledTokenForwarder.isHookCalledByTheRuntime() === true) {
			// An installed `@huggingface/transformers` that makes the calls itself must not be helped:
			// a grammar told about the same token twice consumes it twice and masks the rest of the
			// answer against a state the model never reached. So the forwarder is used because the
			// runtime does not make the calls, and stands aside the moment it does.
			const stoppingCriteria = new StoppingCriteriaList();
			stoppingCriteria.extend(constraint.stopping_criteria);
			return {
				logitsProcessor: constraint.logits_processor,
				stoppingCriteria: stoppingCriteria,
			};
		}
		return SampledTokenForwarder.around(constraint);
	}

	/**
	 * Turns the response format this project carries into the one the package takes.
	 *
	 * A `json_schema` is handed over with all three of the package's `x-guidance` options added to its
	 * root: `whitespace_flexible: false`, `key_separator: ': '`, and `item_separator: ', '`. The three
	 * belong together and neither half works without the other.
	 *
	 * `transition` in the package's `engine/json.ts` returns the same grammar state for every
	 * whitespace byte wherever JSON allows whitespace, so greedy decoding — which is what this stage
	 * generates with — has a fixed point there: whenever the highest-scoring allowed token is a space
	 * or a line break, the next step faces the same choice and takes it again. Milestone 0 measured
	 * five of seven ordinary schemas running to the token limit writing whitespace, one of them after
	 * having written a complete inner object. `whitespace_flexible: false` is what removes that
	 * self-loop.
	 *
	 * On its own it removes the whitespace the model wanted along with it, and the token the model
	 * then prefers is worse. Milestone 0 measured `{"city":"]Paris"}` where the flexible grammar had
	 * written `{"city": "Paris"}`, and the first live run of this stage measured worse again:
	 * `{"city": ", "}`, an answer that satisfies its schema and says nothing. The model wanted the
	 * space after the colon, was refused it, and opened the string with the punctuation it had been
	 * reaching for.
	 *
	 * The two separators give that whitespace back as fixed bytes rather than as a state the grammar
	 * can sit in, so there is nothing to loop on and nothing the model is denied. With all three, the
	 * same run wrote `{"city": "Paris"}` in 8 tokens, and
	 * `{"weather": {"celsius": 15, "sky": "partly cloudy"}, "city": "Paris"}` in 27 — the answers the
	 * model would have written unconstrained. Measured through the real worker browser tab in
	 * milestone 3 of issue #221.
	 *
	 * A `json_object` is handed over as it stands, and deliberately not as the `json_schema` of
	 * `{"type":"object"}` that would let those options reach it. Milestone 0 measured that
	 * substitution: asked for any object, the model wrote a whole weather object in 131 tokens, while
	 * the same question under `{"type":"object"}` with the whitespace control on wrote
	 * `{"weather":{}}` in 6. A consumer that asked for any object at all is asking for the model's own
	 * answer in JSON, and that is the arrangement that gives it one — the live run of milestone 3
	 * answered such a request with a nested, pretty-printed object of 116 tokens.
	 *
	 * A `x-guidance` in the schema a consumer sent is overwritten rather than respected. The keyword
	 * belongs to no JSON Schema draft and to no OpenAI interface, so nothing a consumer sends through
	 * this project's own interfaces can carry it on purpose, and whether a run of this stage finishes
	 * at all is this stage's to decide.
	 *
	 * Public rather than private so that this decision can be asserted without loading a model, since
	 * it is the whole of what this class decides and nothing about a built constraint shows it.
	 *
	 * @param responseFormat The shape the consumer asked its answer to be written in.
	 * @returns The response format to build the constraint from.
	 */
	static packageFormatOf(responseFormat: ResponseFormat): PackageResponseFormat {
		if (responseFormat.type === 'json_object') {
			return {
				type: 'json_object',
			};
		}
		const jsonSchema = {
			...responseFormat.jsonSchema,
			'x-guidance': {
				whitespace_flexible: false,
				key_separator: ': ',
				item_separator: ', ',
			},
		};
		return {
			type: 'json_schema',
			// Every value in the schema arrived over the connection as JSON, so every one of them is
			// a JSON value. `@webai/protocol` types them as `unknown` because it checks that the
			// schema is an object and never what a JSON Schema may hold, which is the package's
			// question rather than the protocol's.
			json_schema: jsonSchema as PackageJsonSchema,
		};
	}
}
