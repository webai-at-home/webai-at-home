import type { TaskType } from './task_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationControlSupport — which task type honours which generation control
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One of the generation controls a consumer may ask for, named as
 * `GenerationSettingsSchema` names it.
 *
 * `isStreaming` is not one of them. Every task type answers in pieces when it is asked to, so
 * there is nothing for a consumer to be told about it, while each of the five below is honoured
 * by some task types and not by others.
 */
export type GenerationControlName =
	| 'temperature'
	| 'topP'
	| 'maximumOutputTokenCount'
	| 'stopSequences'
	| 'randomSeed';

/**
 * The generation controls each task type honours, and by omission the ones it cannot.
 *
 * An entry is a task type's contract, and a task type's contract is the intersection of what all
 * of its workers can honour. A consumer does not choose which of a task type's possible workers is
 * assigned its task, so a control only one kind of worker honours is not in the contract. See step
 * 1 of [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196).
 *
 * A consumer reads this before it submits, so that a control the chosen task type cannot honour
 * is refused at submission rather than accepted and dropped. A control that is accepted and
 * dropped is the worst of the three possible answers: the consumer receives an answer generated
 * some other way and is told nothing went wrong. See milestone 4 of
 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
 *
 * The table below is what a de-risk gate observed live in a real browser tab, not what an engine's
 * documentation claims. The gate for the task types that run in a worker browser tab is milestone 0
 * of [issue #196](https://github.com/webai-at-home/webai-at-home/issues/196), and its raw answers
 * are recorded on [issue #180](https://github.com/webai-at-home/webai-at-home/issues/180):
 *
 * - `task_type_llm_llama3_2_1b_full` and `task_type_llm_qwen3_5_0_8b_full` honour `temperature`,
 *   `maximumOutputTokenCount`, and `stopSequences`. Both run on `@huggingface/transformers`, and
 *   neither honours `topP` or `randomSeed`, because that library honours neither: `top_p: 0.01` at
 *   `temperature: 1.6` narrowed nothing even with `top_k: 0` beside it, and there is no seed to
 *   give. `task_type_llm_llama3_2_1b_full` can also be run by a native worker forwarding the prompt
 *   to a local OpenAI-compatible server, which does honour all five — but this entry is the task
 *   type's contract, not one worker's capability, so the two controls only that worker honours are
 *   not in it.
 * - `task_type_llm_qwen3_0_6b_sharded` honours none of the five yet. The gate found it can honour
 *   four — `temperature`, `topP`, `maximumOutputTokenCount`, and `randomSeed`, beside
 *   `stopSequences` — more than any other task type here, because its sampler is written by hand
 *   over the logits tensor rather than taken from a library. That is step 6 of issue #196.
 * - `task_type_llm_gemma_nano_chrome_full` honours none of the five, and is the one task type the
 *   gate could not reach: every Chrome available to it reported `LanguageModel.availability()` as
 *   `unavailable`, so nothing about that engine was observed rather than assumed.
 * - `task_type_dev_formula` generates no text at all, so no control applies to it.
 *
 * `task_type_llm_llama3_2_3b_full` is retired; it was, for as long as it existed, the only task
 * type in this project to honour any of the five, proved live against LM Studio 0.4.20 serving
 * `llama-3.2-3b-instruct`. See [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
 */
const controlsByTaskType: Record<TaskType, readonly GenerationControlName[]> = {
	task_type_dev_formula: [],
	task_type_llm_qwen3_0_6b_sharded: [],
	task_type_llm_gemma_nano_chrome_full: [],
	task_type_llm_qwen3_5_0_8b_full: ['temperature', 'maximumOutputTokenCount', 'stopSequences'],
	task_type_llm_llama3_2_1b_full: ['temperature', 'maximumOutputTokenCount', 'stopSequences'],
};

/** Which task type honours which generation control. */
export class GenerationControlSupport {
	/**
	 * Reports whether a task type honours one generation control.
	 *
	 * @param taskType The task type the work would be submitted as.
	 * @param controlName The control the consumer asked for.
	 * @returns `true` when the stage that runs this task type acts on that control.
	 */
	static honours(taskType: TaskType, controlName: GenerationControlName): boolean {
		return controlsByTaskType[taskType].includes(controlName);
	}

	/**
	 * Lists every generation control a task type honours.
	 *
	 * @param taskType The task type the work would be submitted as.
	 * @returns The controls that task type acts on, in the order they are declared, and an empty
	 * list for a task type that acts on none of them.
	 */
	static honouredControls(taskType: TaskType): readonly GenerationControlName[] {
		return controlsByTaskType[taskType];
	}
}
