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
export type ResponseFormatName =
	| 'json_object'
	| 'json_schema';

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
 * Every entry is empty today, and the milestone 0 gate of issue #191 is what measured that:
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
 * - `task_type_llm_gemma_4_e2b_full` is empty for the same reason as `task_type_llm_llama3_2_1b_full`
 *   above, not because it runs only in a browser tab. It has both kinds of worker, and the native one
 *   really does sit in front of an engine that honours `json_schema` — Ollama did in
 *   [issue #210](https://github.com/webai-at-home/webai-at-home/issues/210), and milestone 4 of
 *   [issue #216](https://github.com/webai-at-home/webai-at-home/issues/216) ran this task type
 *   through that worker live. The worker browser tab can honour nothing, and a task type's contract
 *   is what both its workers can keep, so the intersection is empty.
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
	task_type_llm_gemma_4_e2b_full: [],
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
