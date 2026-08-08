import type { ConversationInput, GenerationSettings, TaskInput } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskInputFactory — builds the task input a consumer submits, from command line text
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The task types a consumer may submit, each named as its task type without the leading
 * `task_type_`. This is the list the `-t/--task_type` command line option accepts.
 */
export const taskTypeNames = ['dev_formula', 'llm_qwen3_0_6b_sharded', 'llm_gemma_nano_chrome_full', 'llm_qwen3_5_0_8b_full', 'llm_llama3_2_1b_full'] as const;

/** One of the task types a consumer may submit. */
export type TaskTypeName = typeof taskTypeNames[number];

/**
 * The task types that accept a whole conversation, rather than only one prompt.
 *
 * These are exactly the task types whose stage helper can hand a message list to its model: the
 * complete Qwen3.5-0.8B model and the complete Llama 3.2 1B Instruct model, whose workers each
 * apply the model's chat template through `@huggingface/transformers`. Llama 3.2 1B Instruct's
 * task type can also be run by a worker that forwards the messages to a local server speaking the
 * OpenAI-compatible API instead of downloading and running the model itself, but that is a choice
 * of which worker is assigned the task, not something a consumer names here.
 *
 * The other two language-model task types take a prompt and nothing else. The Chrome built-in
 * model is given one piece of text by the browser's own prompt interface, and the sharded Qwen3
 * worker builds its chat template as a string by hand. Both would have to have a conversation
 * flattened for them, which is the thing this widening exists to stop, so neither is offered it.
 */
export const taskTypeNamesAcceptingConversation = ['llm_qwen3_5_0_8b_full', 'llm_llama3_2_1b_full'] as const;

/** One of the task types that accept a whole conversation. */
export type TaskTypeNameAcceptingConversation = typeof taskTypeNamesAcceptingConversation[number];

/**
 * Turns the text given on the command line into the task input the gateway expects.
 *
 * Every task type carries a different kind of value — a number for the development formula
 * task, and a prompt for every language-model task — so the checking of that value lives
 * here, next to the list of task types it belongs to.
 */
export class TaskInputFactory {
	/**
	 * Reports whether a value names a task type a consumer may submit.
	 *
	 * @param value The value given on the command line.
	 * @returns `true` when it is one of `taskTypeNames`.
	 */
	static isTaskTypeName(value: string): value is TaskTypeName {
		return (taskTypeNames as readonly string[]).includes(value);
	}

	/**
	 * Reports whether a task type accepts a whole conversation rather than only one prompt.
	 *
	 * A consumer that holds several messages asks this before deciding what to submit: a task type
	 * that says yes is sent the messages as they are, and one that says no has to be given a single
	 * piece of text built from them.
	 *
	 * @param value The task type to ask about.
	 * @returns `true` when it is one of {@link taskTypeNamesAcceptingConversation}.
	 */
	static acceptsConversation(value: TaskTypeName): value is TaskTypeNameAcceptingConversation {
		return (taskTypeNamesAcceptingConversation as readonly string[]).includes(value);
	}

	/**
	 * Builds the task input for one task type, checking the value it carries.
	 *
	 * @param type The task type to submit, without the leading `task_type_`.
	 * @param value The value submitted with the task: a number for the development formula
	 * task, and either a prompt or, for a task type in {@link taskTypeNamesAcceptingConversation}, a
	 * whole conversation for every language-model task.
	 * @param generationSettings What to ask for about how the answer is generated. Left out
	 * entirely when nothing was asked for, so a submission that states no setting carries no
	 * settings field at all rather than an empty one.
	 * @returns The task input to submit to the gateway.
	 * @throws If the value does not match what the task type accepts, including a conversation
	 * given to a task type that only takes a prompt.
	 */
	static createTaskInput(
		type: TaskTypeName,
		value: string | ConversationInput | undefined,
		generationSettings?: GenerationSettings,
	): TaskInput {
		const settings = generationSettings === undefined ? {} : { generationSettings };
		if (type === 'dev_formula') {
			// The development formula task answers with a single number, so there are no pieces to
			// produce one at a time. Asking for them is refused rather than accepted and ignored,
			// which would leave the person who asked believing the cluster was doing something it
			// was not.
			if (generationSettings?.isStreaming === true) throw new Error('The dev_formula task answers with one number, so it cannot produce its answer in pieces');
			return { taskType: 'task_type_dev_formula', input: TaskInputFactory.parseFormulaInput(TaskInputFactory.requireString(type, value)), ...settings };
		}
		if (type === 'llm_qwen3_0_6b_sharded') return { taskType: 'task_type_llm_qwen3_0_6b_sharded', input: TaskInputFactory.parseLlmInput(TaskInputFactory.requireString(type, value)), ...settings };
		if (type === 'llm_gemma_nano_chrome_full') return { taskType: 'task_type_llm_gemma_nano_chrome_full', input: TaskInputFactory.parseLlmInput(TaskInputFactory.requireString(type, value)), ...settings };
		if (type === 'llm_qwen3_5_0_8b_full') return { taskType: 'task_type_llm_qwen3_5_0_8b_full', input: TaskInputFactory.parseLlmOrConversationInput(value), ...settings };
		return { taskType: 'task_type_llm_llama3_2_1b_full', input: TaskInputFactory.parseLlmOrConversationInput(value), ...settings };
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Value Checks
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the value of a development formula task as a number.
	 *
	 * @param value The value given on the command line.
	 * @returns The number the development formula task is computed from.
	 */
	private static parseFormulaInput(value: string | undefined): number {
		const input = Number(value);
		if (Number.isFinite(input) === false) throw new Error('Input must be a finite number');
		return input;
	}

	/**
	 * Reads the value of a language-model task as a prompt.
	 *
	 * @param value The value given on the command line.
	 * @returns The prompt the language-model task answers, with its surrounding spaces kept.
	 */
	private static parseLlmInput(value: string | undefined): string {
		if (typeof value !== 'string' || value.trim() === '') throw new Error('Input must be a non-empty string');
		return value;
	}

	/**
	 * Checks that a value given to a task type that only takes a prompt is a string, rather than a
	 * conversation meant for one of the task types in {@link taskTypeNamesAcceptingConversation}.
	 *
	 * @param type The task type the value is being checked for, named in the failure it throws.
	 * @param value The value given to {@link createTaskInput}.
	 * @returns The value, unchanged, once it is known to be a string or absent.
	 * @throws If the value is a conversation.
	 */
	private static requireString(type: TaskTypeName, value: string | ConversationInput | undefined): string | undefined {
		if (value !== undefined && typeof value !== 'string') {
			throw new Error(`The task type ${type} takes a single prompt, not a whole conversation.`);
		}
		return value;
	}

	/**
	 * Reads the value of a language-model task that accepts a whole conversation, as either a
	 * prompt or that conversation.
	 *
	 * @param value The value given to {@link createTaskInput}.
	 * @returns The prompt or conversation the language-model task answers.
	 * @throws If the value is neither a non-empty string nor a conversation.
	 */
	private static parseLlmOrConversationInput(value: string | ConversationInput | undefined): string | ConversationInput {
		if (typeof value === 'string') {
			return TaskInputFactory.parseLlmInput(value);
		}
		if (value === undefined) {
			throw new Error('Input must be a non-empty string or a conversation');
		}
		return value;
	}
}
