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
 * there is nothing for a consumer to be told about it, while each of the six below is honoured
 * by some task types and not by others.
 */
export type GenerationControlName =
	| 'temperature'
	| 'topP'
	| 'maximumOutputTokenCount'
	| 'stopSequences'
	| 'randomSeed'
	| 'reasoningEffort';

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
 * - `task_type_llm_qwen3_0_6b_sharded` honours all five, more than any other task type in this
 *   project, because its sampler is written by hand over the logits tensor rather than taken from
 *   a library: nothing there refuses a `topP`, and a seeded source of random numbers can be built
 *   where a library offers none. It is the only task type whose `randomSeed` and `topP` do
 *   anything.
 * - `task_type_llm_gemma_nano_chrome_full` honours none of the five, and that is now a measured
 *   result rather than an unreachable machine. Its own gate is
 *   [issue #205](https://github.com/webai-at-home/webai-at-home/issues/205), run on Chrome/151.0.7922.138
 *   once `LanguageModel.availability()` on that machine answered `available`. `LanguageModel.create()`
 *   accepts a `temperature`, both with a `topK` beside it and without one, and acting on it is what
 *   it does not do: `temperature: 0` and `temperature: 1.6` each gave three different answers out of
 *   three runs, with `topK: 40` and again with `topK: 1`, which is the strongest determinism this
 *   engine can be asked for. The engine offers no `topP`, no maximum output length, no stop
 *   sequences, and no seed at all, so `temperature` was the only one of the five it could ever have
 *   honoured. A control accepted and acted on by nothing is exactly what this table exists to keep
 *   out of a consumer's hands, so the entry stays empty.
 * - `task_type_dev_formula` generates no text at all, so no control applies to it.
 *
 * `task_type_llm_llama3_2_3b_full` is retired; it was, for as long as it existed, the only task
 * type in this project to honour any of the five, proved live against LM Studio 0.4.20 serving
 * `llama-3.2-3b-instruct`. See [issue #154](https://github.com/webai-at-home/webai-at-home/issues/154).
 *
 * `reasoningEffort` is the sixth control, and `task_type_llm_qwen3_5_0_8b_full` is the only task
 * type that honours it, because it is the only one whose model thinks before it answers on both of
 * its workers. Both workers were gated live for [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192):
 *
 * - The native worker forwarding to LM Studio 0.4.20 reads `reasoning_effort` on the request.
 *   `"none"` took a question that had spent all 8153 of its tokens thinking down to 0 reasoning
 *   tokens and a finished answer, while `"low"` and `"medium"` both still ran to the context limit
 *   and returned an empty answer.
 * - The worker browser tab reads `enable_thinking` on the chat template, which
 *   `@huggingface/transformers` genuinely passes through: the two settings render different prompts,
 *   43 tokens against 41. LM Studio, by contrast, drops `chat_template_kwargs` entirely, which is
 *   why the native worker uses the request field and not the template option.
 *
 * The worker browser tab can only turn thinking on or off, so it reads `none` as off and every
 * other level as on. A task type's contract says which controls a worker acts on, not how finely,
 * and a control acted on coarsely is not a control dropped.
 *
 * `task_type_llm_qwen3_0_6b_sharded` is not entered here even though Qwen3-0.6B also thinks. Its
 * stage helper builds its prompt and drives its own sampler rather than going through either seam
 * above, so whether it can honour this control is unmeasured, and an unmeasured entry is the one
 * thing this table must never hold.
 */
const controlsByTaskType: Record<TaskType, readonly GenerationControlName[]> = {
	task_type_dev_formula: [],
	task_type_llm_qwen3_0_6b_sharded: ['temperature', 'topP', 'maximumOutputTokenCount', 'stopSequences', 'randomSeed'],
	task_type_llm_gemma_nano_chrome_full: [],
	task_type_llm_qwen3_5_0_8b_full: ['temperature', 'maximumOutputTokenCount', 'stopSequences', 'reasoningEffort'],
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
