import type { GenerationSettings, LlmStagePayload } from '@webai/protocol';
import { StageHelperLlmLlama3_2_1bFull } from './stage_helper_llm_llama3_2_1b_full.js';
import { StageHelperLlmQwen3_5_0_8bFull } from './stage_helper_llm_qwen3_5_0_8b_full.js';
import type { OpenaiApiClient } from '../libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageCatalog — the fixed list of every stage helper this worker carries
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The part of a stage helper this catalog and its callers use. */
export type StageHelper = {
	/** The computation the stage helper implements, named the way a pipeline stage names it. */
	readonly computation: string;
	/**
	 * Reports whether this stage helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this stage helper can run it.
	 */
	implementsComputation(computation: string): boolean;
	/**
	 * Reads one answer, either whole or one piece at a time.
	 *
	 * @param taskId The task this run belongs to.
	 * @param stageAssignmentId The assignment this run is carrying out.
	 * @param payload The prompt or history submitted with the task, or a value saying this run
	 * carries an answer on.
	 * @param generationSettings What the consumer asked for.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 */
	compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
	): Promise<LlmStagePayload>;
	/**
	 * Releases the answer being produced for one task, if the assignment named is the one reading
	 * it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	clearGeneration(taskId: string, stageAssignmentId: string): void;
	/** Releases every answer the stage helper is holding. */
	clearEveryGeneration(): void;
};

/**
 * Names every stage helper this worker carries, and hands out the one that implements a given
 * computation.
 *
 * The list is fixed rather than read from the gateway, because it names what this worker itself is
 * able to run, not what pipelines happen to be loaded on the gateway it last connected to. Every
 * stage helper here reaches the same local server for the one model the worker process was told to
 * serve with `--openai-model`, so a worker offering two of these stages at once would answer both
 * with that one model; `--stage-names` is required for that reason, and names the one stage the
 * model actually belongs to.
 */
export class StageCatalog {
	/** Every stage helper this worker carries. */
	static readonly stageHelpers: readonly StageHelper[] = [
		StageHelperLlmLlama3_2_1bFull,
		StageHelperLlmQwen3_5_0_8bFull,
	];

	/**
	 * Finds the stage helper that implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage or by an assignment.
	 * @returns The stage helper that runs it, or `undefined` when this worker carries none.
	 */
	static stageHelperFor(computation: string): StageHelper | undefined {
		return StageCatalog.stageHelpers.find((stageHelper) => stageHelper.implementsComputation(computation));
	}

	/**
	 * Reports whether this worker implements the computation a pipeline stage names.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when one of this worker's stage helpers implements it.
	 */
	static implementsComputation(computation: string): boolean {
		return StageCatalog.stageHelperFor(computation) !== undefined;
	}

	/**
	 * Releases the answer being produced for one task, whichever stage helper is producing it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it, which only the stage helper
	 * whose run holds that assignment acts on.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		for (const stageHelper of StageCatalog.stageHelpers) {
			stageHelper.clearGeneration(taskId, stageAssignmentId);
		}
	}

	/** Releases every answer every stage helper is holding. */
	static clearEveryGeneration(): void {
		for (const stageHelper of StageCatalog.stageHelpers) {
			stageHelper.clearEveryGeneration();
		}
	}
}
