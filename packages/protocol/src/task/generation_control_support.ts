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
 * A consumer reads this before it submits, so that a control the chosen task type cannot honour
 * is refused at submission rather than accepted and dropped. A control that is accepted and
 * dropped is the worst of the three possible answers: the consumer receives an answer generated
 * some other way and is told nothing went wrong. See milestone 4 of
 * [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
 *
 * The table below is what milestone 0's de-risk gate for that issue observed live, not what an
 * engine's documentation claims:
 *
 * - `task_type_llm_llama3_2_3b_full` runs on a local server speaking the OpenAI-compatible Chat
 *   Completions interface, and all five were proved against LM Studio 0.4.20 serving
 *   `llama-3.2-3b-instruct`:
 *   `temperature: 0` repeated one answer word for word three times where a high temperature gave
 *   three different answers, `topP` at `0.01` collapsed a high temperature back onto that same
 *   answer, `maximumOutputTokenCount` cut the answer short and reported `length`, a stop sequence
 *   cut an answer the model otherwise wrote straight past, and one seed repeated an answer that a
 *   different seed changed.
 * - `task_type_llm_qwen3_5_0_8b_full`, `task_type_llm_gemma_nano_chrome_full`, and
 *   `task_type_llm_qwen3_0_6b_sharded` honour none of the five yet. Two of the three do not
 *   sample at all today — one calls `generate()` with `do_sample: false`, the other selects the
 *   highest logit in a decode loop written by hand — so honouring a temperature on either means
 *   turning sampling on for the first time and changing the answer every existing consumer
 *   already receives. That is milestone 3 of the issue, and it waits on a de-risk gate of its own
 *   run in a real browser tab.
 * - `task_type_llm_llama3_2_1b_full` honours none of the five either, for the same reason as
 *   `task_type_llm_qwen3_5_0_8b_full`: its stage helper also calls `generate()` with
 *   `do_sample: false`. See milestone 2 of
 *   [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
 * - `task_type_dev_formula` generates no text at all, so no control applies to it.
 */
const controlsByTaskType: Record<TaskType, readonly GenerationControlName[]> = {
	task_type_dev_formula: [],
	task_type_llm_qwen3_0_6b_sharded: [],
	task_type_llm_gemma_nano_chrome_full: [],
	task_type_llm_qwen3_5_0_8b_full: [],
	task_type_llm_llama3_2_3b_full: ['temperature', 'topP', 'maximumOutputTokenCount', 'stopSequences', 'randomSeed'],
	task_type_llm_llama3_2_1b_full: [],
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
