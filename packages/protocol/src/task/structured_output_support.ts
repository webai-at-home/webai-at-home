import { z } from 'zod';
import type { TaskType } from './task_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StructuredOutputSupport — which task type honours which response format
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One of the response formats a consumer may ask for, named as the OpenAI Chat Completions
 * interface names it.
 *
 * `text` is not one of them, for the same reason `isStreaming` is not a `GenerationControlName`: it
 * is that interface's own default and asks for nothing unusual, so there is nothing for a consumer
 * to be told about it, while each of the two below is a shape a task type either can produce or
 * cannot.
 */
export const ResponseFormatNameSchema = z.enum(['json_object', 'json_schema']);
/** One of the response formats a consumer may ask for. See {@link ResponseFormatNameSchema}. */
export type ResponseFormatName = z.infer<typeof ResponseFormatNameSchema>;

/**
 * One response format as a consumer asks for it, carrying the schema when it names one.
 *
 * This is what travels with a task, while {@link ResponseFormatNameSchema} above is what the table
 * below is keyed by. The two are separate because a task type honours a **kind** of shape, and it
 * honours that kind whatever schema a particular request carries.
 *
 * A discriminated union rather than a name beside an optional schema, so that a `json_schema`
 * without a schema and a `json_object` with one are both unwritable. There is no `strict` here,
 * although the OpenAI Chat Completions interface has one: a worker of this project enforces a schema
 * exactly or refuses it, so a flag asking for less would be carried and never acted on, which is the
 * fault `generation_control_support.ts` exists to prevent. Enforcing exactly satisfies a request
 * that asked for less as well as one that asked for exactly.
 */
export const ResponseFormatSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('json_object'),
	}).strict(),
	z.object({
		type: z.literal('json_schema'),
		/**
		 * The label the request gave its schema, which the OpenAI Chat Completions interface requires
		 * and a local server refuses a request without.
		 */
		name: z.string().min(1),
		/** The schema the answer must satisfy, as a JSON Schema document. */
		schema: z.record(z.string(), z.unknown()),
	}).strict(),
]);
/** One response format as a consumer asks for it. See {@link ResponseFormatSchema}. */
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/**
 * The response formats each task type honours, and by omission the ones it cannot.
 *
 * An entry is a task type's contract, and a task type's contract is the intersection of what all of
 * its workers can honour, the same rule `GenerationControlSupport` follows. A consumer does not
 * choose which of a task type's possible workers is assigned its task, so a format only one kind of
 * worker honours is not in the contract.
 *
 * A consumer reads this before it submits, so that a response format the chosen task type cannot
 * honour is refused at submission rather than accepted and dropped. A response format that is
 * accepted and dropped is worse than a refused one and worse than an honoured one both: the
 * consumer receives prose where it asked for an object, is told nothing went wrong, and calls
 * `JSON.parse` on an English sentence. See
 * [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191).
 *
 * `task_type_llm_gemma_4_e2b_full` honours both shapes, and every other entry is empty. Issue #191
 * measured the empty ones, and [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219)
 * is what filled the one that is not:
 *
 * - `task_type_llm_llama3_2_1b_full` is served by two kinds of worker. A `@webai/worker-openai`
 *   process forwarding to a local server does sit in front of an engine that honours `json_schema`,
 *   measured live against LM Studio serving `llama-3.2-1b-instruct`, which answered
 *   `{"greeting": "hello"}` to a schema declaring `greeting` required. A worker browser tab
 *   generates through `pipeline('text-generation', ...)` from `@huggingface/transformers`, pinned at
 *   `4.2.0`, which offers no way to ask for a schema or a grammar at all: its `constraints` field is
 *   declared and never read, and constrained decoding is named only in a comment listing what the
 *   upstream Python library has. The intersection of the two is empty, so the contract is empty.
 * - `task_type_llm_qwen3_5_0_8b_full`, `task_type_llm_qwen3_0_6b_sharded`, and
 *   `task_type_llm_gemma_nano_chrome_full` run only in a worker browser tab, so none of them has an
 *   engine that can be asked for a shape either.
 * - `task_type_llm_gemma_4_e2b_full` honours `json_object`, because both of its kinds of worker were
 *   taught to produce one and both were then measured producing one. The worker browser tab masks
 *   the score of every token that would break the object, so a well-formed object is the only thing
 *   the model is able to write. The native worker asks the local server for the shape, and refuses
 *   an answer that came back as anything else. Neither was true when issue #191 measured this row.
 * - `task_type_llm_gemma_4_e2b_full` honours `json_schema` as well, from milestone 6 of issue #219,
 *   which made the schema itself travel and gave both kinds of worker the same reader to enforce it
 *   with: `JsonSchemaCompiler` and `JsonSchemaGrammar`, which live in this package for that reason.
 *   The worker browser tab masks against the schema rather than against JSON alone, so a required
 *   property left out, a value of the wrong type, and a text outside an enumeration are each a token
 *   the model is not able to write. The native worker asks the local server for the schema and reads
 *   the answer back through the same compiler, so an answer the schema refuses fails the stage. Both
 *   were measured live, against four schemas covering required properties, integers, booleans,
 *   enumerations, arrays, and nesting.
 * - A schema this project cannot hold a model to is refused where it is read, rather than enforced
 *   as far as it is understood: `JsonSchemaCompiler` names the keywords it enforces and refuses any
 *   other. An answer that broke `minLength` would otherwise come back reported as matching the
 *   schema, which is this table's own failure written one level down.
 * - `task_type_dev_formula` generates no text at all, so no response format applies to it.
 *
 * An entry here is also the only thing a task type needs to gain to start honouring a format: this
 * table is what a consumer reads, and no consumer keeps a list of its own.
 */
const formatsByTaskType: Record<TaskType, readonly ResponseFormatName[]> = {
	task_type_dev_formula: [],
	task_type_llm_qwen3_0_6b_sharded: [],
	task_type_llm_gemma_nano_chrome_full: [],
	task_type_llm_qwen3_5_0_8b_full: [],
	task_type_llm_llama3_2_1b_full: [],
	task_type_llm_gemma_4_e2b_full: ['json_object', 'json_schema'],
};

/** Which task type honours which response format. */
export class StructuredOutputSupport {
	/**
	 * Reports whether a task type honours one response format.
	 *
	 * @param taskType The task type the work would be submitted as.
	 * @param responseFormatName The response format the consumer asked for.
	 * @returns `true` when the stage that runs this task type produces an answer in that shape.
	 */
	static honours(taskType: TaskType, responseFormatName: ResponseFormatName): boolean {
		return formatsByTaskType[taskType].includes(responseFormatName);
	}

	/**
	 * Lists every response format a task type honours.
	 *
	 * @param taskType The task type the work would be submitted as.
	 * @returns The response formats that task type produces, in the order they are declared, and an
	 * empty list for a task type that produces none of them.
	 */
	static honouredFormats(taskType: TaskType): readonly ResponseFormatName[] {
		return formatsByTaskType[taskType];
	}
}
