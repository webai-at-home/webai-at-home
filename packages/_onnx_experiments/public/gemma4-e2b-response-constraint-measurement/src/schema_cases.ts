import type { ResponseFormat } from './vendor/transformers_response_constraint/index.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SchemaCases — the JSON Schema shapes this measurement asks Gemma 4 E2B for, and what each one proves
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One schema this page asks the model for, together with the question that makes the schema natural to answer. */
export type SchemaCase = {
	/** A short name for the case, used as the heading of its part of the record. */
	name: string;
	/** Why the case is here — the keyword or the shape it is the only measurement of. */
	why: string;
	/** The question put to the model, as one user message. */
	prompt: string;
	/** The schema sent as `response_format.json_schema`. */
	schema: JsonSchema;
	/**
	 * Whether one parsed answer satisfies this case's schema.
	 *
	 * Written by hand, per case, rather than by a JSON Schema validator. A validator written here would be the very
	 * thing [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221) exists to avoid writing, and a
	 * measurement that checked the package's output with a second implementation of the package's own job would be
	 * measuring the two against each other rather than the model against the schema.
	 *
	 * @param value The parsed answer, or whatever `JSON.parse` returned for it.
	 * @returns `undefined` when the answer satisfies the schema, otherwise one sentence saying what is wrong.
	 */
	whyUnsatisfied(value: unknown): string | undefined;
};

/**
 * The schema shape `@huggingface/transformers-response-constraint` takes.
 *
 * Read off the package's own `ResponseFormat` rather than restated here, so that a schema this page writes is
 * refused at compile time when the package would refuse it.
 */
export type JsonSchema = Extract<ResponseFormat, { type: 'json_schema' }>['json_schema'];

/** A record with unknown values, which is what a parsed JSON object is before anything is known about it. */
type UnknownRecord = Record<string, unknown>;

/**
 * The schemas this page asks for, one per shape [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221)
 * milestone 0 names, plus the two the reverted work of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) refused.
 *
 * The last case is the one that decides whether this package is worth the trouble. `minLength` and `maxLength` are
 * the keywords the hand-written compiler of issue #219 refused with `unenforceable_schema`, and they appear in Nico
 * Martin's own example, so a package that claims them and does not enforce them would leave this project exactly
 * where the revert left it.
 */
export class SchemaCases {
	/**
	 * Every case, in the order the page runs them.
	 *
	 * @returns The cases. The list is rebuilt on each call so that nothing a run does can change the next run.
	 */
	static all(): SchemaCase[] {
		return [
			SchemaCases.requiredString(),
			SchemaCases.integer(),
			SchemaCases.booleanValue(),
			SchemaCases.enumeration(),
			SchemaCases.array(),
			SchemaCases.objectInsideAnObject(),
			SchemaCases.stringLengthBounds(),
		];
	}

	/**
	 * The same schema with the package's own whitespace control turned off.
	 *
	 * `x-guidance` is a keyword of this package, allowed only on the root schema. With `whitespace_flexible` left at
	 * its default of `true`, the grammar accepts any amount of whitespace wherever JSON allows whitespace, and the
	 * transition function returns the same state for every whitespace byte. Greedy decoding therefore has a fixed
	 * point there: whenever the highest-scoring allowed token is a space or a line break, the next step faces the
	 * same choice and takes it again, until the token limit ends the answer. Setting it to `false` removes that
	 * self-loop, and the answer comes out as compact JSON.
	 *
	 * No consumer sends this keyword, because it belongs to no JSON Schema draft and to no OpenAI interface. A stage
	 * that wants it has to add it to the schema a consumer sent.
	 *
	 * @param schema The schema as a consumer would send it.
	 * @returns The same schema with the whitespace self-loop closed.
	 */
	static withoutFlexibleWhitespace(schema: JsonSchema): JsonSchema {
		if (typeof schema === 'boolean') {
			return schema;
		}
		return {
			'x-guidance': { whitespace_flexible: false },
			...schema,
		};
	}

	/**
	 * A schema whose external `$ref` the package states it does not enforce.
	 *
	 * Milestone 5 of issue #221 has to refuse such a request at submission rather than answer it half-enforced, and
	 * it may only do so by asking the package. What the package does when asked is what this case records: whether it
	 * throws, whether it says which keyword it could not keep, and whether the throw happens while the constraint is
	 * built or only once a token has been generated.
	 *
	 * @returns The case.
	 */
	static externalReference(): SchemaCase {
		return {
			name: 'external $ref, which the package states it does not enforce',
			why: 'milestone 5 must refuse this at submission, and may only know to refuse it by asking the package',
			prompt: 'Which city is the Eiffel Tower in?',
			schema: {
				type: 'object',
				properties: {
					city: { $ref: 'https://example.invalid/city.schema.json' },
				},
				required: ['city'],
				additionalProperties: false,
			},
			whyUnsatisfied: () => 'this case is about what the package does when the constraint is built, not about the answer',
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The cases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Required properties, a string value, and `additionalProperties: false`.
	 *
	 * @returns The case.
	 */
	private static requiredString(): SchemaCase {
		return {
			name: 'required properties and a string',
			why: 'the smallest shape a consumer asks for, and the one every other case is built on',
			prompt: 'Which city is the Eiffel Tower in?',
			schema: {
				type: 'object',
				properties: {
					city: { type: 'string' },
				},
				required: ['city'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				const keys = Object.keys(record);
				if (keys.length !== 1 || keys[0] !== 'city') {
					return `the object has the properties ${JSON.stringify(keys)} rather than only "city"`;
				}
				if (typeof record.city !== 'string') { return `"city" is ${typeof record.city} rather than a string`; }
				return undefined;
			},
		};
	}

	/**
	 * An integer, which is the case a grammar has to keep a decimal point out of.
	 *
	 * @returns The case.
	 */
	private static integer(): SchemaCase {
		return {
			name: 'an integer',
			why: 'a number a grammar has to keep a decimal point and an exponent out of',
			prompt: 'How many sides does a hexagon have?',
			schema: {
				type: 'object',
				properties: {
					sides: { type: 'integer' },
				},
				required: ['sides'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				if (Number.isInteger(record.sides) === false) {
					return `"sides" is ${JSON.stringify(record.sides)} rather than an integer`;
				}
				return undefined;
			},
		};
	}

	/**
	 * A boolean, which is two literals and nothing else.
	 *
	 * @returns The case.
	 */
	private static booleanValue(): SchemaCase {
		return {
			name: 'a boolean',
			why: 'a value with exactly two spellings, where anything else the model writes is visible at once',
			prompt: 'Is Paris the capital of France?',
			schema: {
				type: 'object',
				properties: {
					answer: { type: 'boolean' },
				},
				required: ['answer'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				if (typeof record.answer !== 'boolean') {
					return `"answer" is ${JSON.stringify(record.answer)} rather than a boolean`;
				}
				return undefined;
			},
		};
	}

	/**
	 * An enumeration, asked with a question whose true answer is not in the list.
	 *
	 * The question is about snow in Paris in August on purpose. A model left to itself would write something like
	 * `unlikely`, so an answer that is one of the four listed words is an answer the grammar decided, not one the
	 * model would have written anyway.
	 *
	 * @returns The case.
	 */
	private static enumeration(): SchemaCase {
		return {
			name: 'an enumeration',
			why: 'the one case where a constrained answer and an unconstrained answer cannot be confused',
			prompt: 'In one word, what is the weather like in Paris in August?',
			schema: {
				type: 'object',
				properties: {
					sky: { enum: ['clear', 'cloudy', 'rain', 'snow'] },
				},
				required: ['sky'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				const allowed = ['clear', 'cloudy', 'rain', 'snow'];
				if (typeof record.sky !== 'string' || allowed.includes(record.sky) === false) {
					return `"sky" is ${JSON.stringify(record.sky)}, which is not one of ${JSON.stringify(allowed)}`;
				}
				return undefined;
			},
		};
	}

	/**
	 * An array of a fixed length, which is a grammar that has to count.
	 *
	 * @returns The case.
	 */
	private static array(): SchemaCase {
		return {
			name: 'an array of exactly three strings',
			why: '`minItems` and `maxItems` make the grammar count, which a prompt alone never reliably does',
			prompt: 'Name some cities in France.',
			schema: {
				type: 'object',
				properties: {
					cities: {
						type: 'array',
						items: { type: 'string' },
						minItems: 3,
						maxItems: 3,
					},
				},
				required: ['cities'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				const cities = record.cities;
				if (Array.isArray(cities) === false) { return `"cities" is ${typeof cities} rather than an array`; }
				if (cities.length !== 3) { return `"cities" holds ${cities.length} items rather than 3`; }
				const wrong = cities.findIndex((city) => typeof city !== 'string');
				if (wrong !== -1) { return `item ${wrong} of "cities" is ${typeof cities[wrong]} rather than a string`; }
				return undefined;
			},
		};
	}

	/**
	 * An object inside an object, which is the nesting a grammar has to keep a closing brace count for.
	 *
	 * @returns The case.
	 */
	private static objectInsideAnObject(): SchemaCase {
		return {
			name: 'an object inside an object',
			why: 'nesting, where a grammar that mismatches its braces produces text no reader can parse',
			prompt: 'Describe the current weather in Paris.',
			schema: {
				type: 'object',
				properties: {
					city: { type: 'string' },
					weather: {
						type: 'object',
						properties: {
							celsius: { type: 'integer' },
							sky: { type: 'string' },
						},
						required: ['celsius', 'sky'],
						additionalProperties: false,
					},
				},
				required: ['city', 'weather'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				if (typeof record.city !== 'string') { return `"city" is ${typeof record.city} rather than a string`; }
				const weather = SchemaCases.asRecord(record.weather);
				if (typeof weather === 'string') { return `"weather" ${weather}`; }
				if (Number.isInteger(weather.celsius) === false) {
					return `"weather.celsius" is ${JSON.stringify(weather.celsius)} rather than an integer`;
				}
				if (typeof weather.sky !== 'string') { return `"weather.sky" is ${typeof weather.sky} rather than a string`; }
				return undefined;
			},
		};
	}

	/**
	 * `minLength` and `maxLength`, the two keywords the reverted compiler of issue #219 refused.
	 *
	 * The bounds are narrow and the question invites a long answer, so a model left to itself would write far more
	 * than 12 characters. An answer inside the bounds is therefore the grammar's doing.
	 *
	 * @returns The case.
	 */
	private static stringLengthBounds(): SchemaCase {
		return {
			name: 'minLength and maxLength on a string',
			why: 'the keywords the hand-written compiler of issue #219 refused, and that Nico Martin\'s own example uses',
			prompt: 'Explain in as much detail as you can what the Eiffel Tower is made of.',
			schema: {
				type: 'object',
				properties: {
					material: {
						type: 'string',
						minLength: 4,
						maxLength: 12,
					},
				},
				required: ['material'],
				additionalProperties: false,
			},
			whyUnsatisfied: (value) => {
				const record = SchemaCases.asRecord(value);
				if (typeof record === 'string') { return record; }
				const material = record.material;
				if (typeof material !== 'string') { return `"material" is ${typeof material} rather than a string`; }
				if (material.length < 4 || material.length > 12) {
					return `"material" is ${material.length} characters long, outside the bounds 4 to 12`;
				}
				return undefined;
			},
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * A parsed answer as a record, or one sentence saying why it is not one.
	 *
	 * @param value The parsed answer.
	 * @returns The record, or a sentence when the value is not a plain object.
	 */
	private static asRecord(value: unknown): UnknownRecord | string {
		if (value === null || typeof value !== 'object' || Array.isArray(value) === true) {
			return `the answer parsed to ${Array.isArray(value) ? 'an array' : String(value === null ? 'null' : typeof value)} rather than an object`;
		}
		return value as UnknownRecord;
	}
}
