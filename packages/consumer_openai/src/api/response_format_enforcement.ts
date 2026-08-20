import {
	ResponseConstraint,
	type ResponseFormat as PackageResponseFormat,
} from '@huggingface/transformers-response-constraint';
import type { ResponseFormat } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponseFormatEnforcement — asks the constraint package whether a schema can be enforced at all
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The JSON Schema shape `@huggingface/transformers-response-constraint` takes. */
type PackageJsonSchema = Extract<PackageResponseFormat, { type: 'json_schema' }>['json_schema'];

/**
 * A vocabulary of four single-byte tokens, standing in for the one a worker really generates with.
 *
 * `ResponseConstraint.fromResponseFormat` takes a tokenizer because generation needs one, and this
 * server has none: no model is loaded here, and the worker that will run the task has not been
 * chosen yet. A stand-in is honest all the same, because of where the refusal comes from. Whether a
 * schema can be enforced is decided while the schema is compiled, by walking its keywords, and the
 * only thing the tokenizer contributes to that compilation is the length of its longest token,
 * which clamps how much of a string one step may write. A clamp cannot make a keyword supported or
 * unsupported, so the same schema is refused for the same reason whatever vocabulary is passed.
 *
 * Four tokens rather than one, so that the vocabulary the package builds its own structures from is
 * a real one: an opening brace, a closing brace, a quotation mark, and a letter.
 */
const STAND_IN_TOKENIZER = {
	tokens: [
		Uint8Array.of(0x7b),
		Uint8Array.of(0x7d),
		Uint8Array.of(0x22),
		Uint8Array.of(0x61),
	],
	eosTokenId: 0,
};

/**
 * Asks `@huggingface/transformers-response-constraint` whether it can enforce a schema, before a
 * task carrying that schema is submitted to the cluster.
 *
 * The package is the one that will enforce the schema in a worker browser tab, so it is the one
 * asked here. No list of supported keywords is kept in this repository: a list would be a second
 * version of the same fact, it would disagree with the package the first time the package gained a
 * keyword, and it is exactly what milestone 1 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) wrote by hand and had
 * reverted.
 *
 * What the package refuses, measured against the checked-in build for milestone 5 of
 * [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221): an external `$ref`, a
 * local `$ref` that does not resolve, `$dynamicRef`, `unevaluatedProperties`, `unevaluatedItems`,
 * any keyword it does not define, and a schema that is neither a boolean nor an object. What it
 * accepts includes everything a request written for the OpenAI interface usually carries —
 * `description`, `title`, `default`, `examples`, `$schema`, `$id`, `additionalProperties`,
 * `minLength`, `maxLength`, `format`, and a local `$ref` into `$defs`.
 *
 * Refusing at submission is the point of asking at all. A schema half enforced produces an answer
 * that looks like the shape asked for and is not it, and the caller is told nothing.
 */
export class ResponseFormatEnforcement {
	/**
	 * Reports why a response format cannot be enforced, in the package's own words.
	 *
	 * The bare schema is asked about, exactly as the request carried it. A worker browser tab adds
	 * an `x-guidance` key of its own before it compiles the same schema, which the package accepts
	 * whatever else the schema holds and which therefore cannot change this answer.
	 *
	 * @param responseFormat The shape the request asked its answer to be in.
	 * @returns The package's own message saying what it cannot enforce, or `undefined` when it can
	 * enforce the schema, and for a `json_object`, whose shape carries no schema to refuse.
	 */
	static refusalOf(responseFormat: ResponseFormat): string | undefined {
		if (responseFormat.type !== 'json_schema') {
			return undefined;
		}
		try {
			ResponseConstraint.fromResponseFormat(STAND_IN_TOKENIZER, {
				type: 'json_schema',
				json_schema: responseFormat.jsonSchema as PackageJsonSchema,
			});
		} catch (error: unknown) {
			return error instanceof Error ? error.message : String(error);
		}
		return undefined;
	}
}
