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
 * `task_type_llm_gemma_4_e2b_full` honours `json_object`, and every other entry is empty. Issue #191
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
 * - `task_type_llm_gemma_4_e2b_full` does not honour `json_schema`. The worker browser tab enforces
 *   well-formed JSON and not a schema, and the protocol carries no schema for the native worker to
 *   pass on, so answering such a request would mean returning an object whose keys are the model's
 *   own guess. Milestone 6 of issue #219 is where the schema itself starts to travel.
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
	task_type_llm_gemma_4_e2b_full: ['json_object'],
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
