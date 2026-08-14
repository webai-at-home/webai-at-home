import type { GenerationSettings, LlmStagePayload } from '@webai/protocol';
import { LocalServerGeneration, type LocalModelReadiness } from './local_server_generation.js';
import type { OpenaiApiClient } from '../libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmQwen3_5_0_8bFull — runs Qwen3.5-0.8B through a local OpenAI-compatible server
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs the complete Qwen3.5-0.8B model by forwarding the stage's prompt to a locally running
 * server that speaks the OpenAI-compatible Chat Completions API, such as LM Studio.
 *
 * This is the second kind of worker `stage_llm_qwen3_5_0_8b_full` can be assigned to, alongside
 * the worker browser tab that downloads and runs the model itself — the same arrangement
 * `stage_llm_llama3_2_1b_full` already had. The gateway assigns the stage to whichever kind of
 * worker offers it and does not know which one a given assignment reaches.
 *
 * Everything about reading an answer back from the local server is the same for every model that
 * server can hold, so it lives in {@link LocalServerGeneration} and this helper holds one of
 * those. What belongs to this helper alone is the computation it implements, and the answers it is
 * producing right now, which no other stage helper may release.
 *
 * The worker process is told which model to ask the local server for, with `--openai-model`, and
 * which stage to offer, with `--stage-names`. Naming the model here as well would be a second
 * version of the same fact.
 */
export class StageHelperLlmQwen3_5_0_8bFull {
	/**
	 * The computation this stage helper implements, named the way a pipeline stage names its
	 * computation.
	 */
	static readonly computation = 'llm_qwen3_5_0_8b_full';

	/** The answers this stage helper is producing right now. */
	private static readonly generation = new LocalServerGeneration();

	/**
	 * Reports whether this stage helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this stage helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmQwen3_5_0_8bFull.computation;
	}

	/**
	 * Reports whether this worker can run the stage, before it advertises it.
	 *
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model this worker was told to serve, such as `qwen_qwen3.5-0.8b`.
	 * @returns Whether the stage can be run, and why not when it cannot.
	 */
	static async readiness(openaiApiClient: OpenaiApiClient, modelId: string): Promise<LocalModelReadiness> {
		return await LocalServerGeneration.readiness(openaiApiClient, modelId);
	}

	/**
	 * Reads one answer, either whole or one piece at a time, according to what the consumer asked
	 * for.
	 *
	 * @param taskId The task this run belongs to, which names the answer being produced for it.
	 * @param stageAssignmentId The assignment this run is carrying out, which decides whether this
	 * run is the one allowed to release the answer it is reading.
	 * @param payload The prompt or history submitted with the task, or, on a run that carries an
	 * answer on, a value saying so and nothing else.
	 * @param generationSettings What the consumer asked for.
	 * @param openaiApiClient The client for the local server this worker was pointed at.
	 * @param modelId The model to ask the local server for.
	 * @returns One piece of the answer, or the whole answer marked as finished.
	 * @throws If the local server cannot be reached or fails the request, if the run is asked to
	 * carry on an answer this worker is not holding, or if the answer is abandoned before or while
	 * it is being read.
	 */
	static async compute(
		taskId: string,
		stageAssignmentId: string,
		payload: LlmStagePayload,
		generationSettings: GenerationSettings | undefined,
		openaiApiClient: OpenaiApiClient,
		modelId: string,
	): Promise<LlmStagePayload> {
		return await StageHelperLlmQwen3_5_0_8bFull.generation.compute(
			taskId,
			stageAssignmentId,
			payload,
			generationSettings,
			openaiApiClient,
			modelId,
		);
	}

	/** Releases every answer this stage helper is holding. */
	static clearEveryGeneration(): void {
		StageHelperLlmQwen3_5_0_8bFull.generation.clearEveryGeneration();
	}

	/**
	 * Releases the answer this stage helper is producing for one task, if the assignment named is
	 * the one currently reading it.
	 *
	 * @param taskId The task whose answer should be released.
	 * @param stageAssignmentId The assignment asking to release it.
	 */
	static clearGeneration(taskId: string, stageAssignmentId: string): void {
		StageHelperLlmQwen3_5_0_8bFull.generation.clearGeneration(taskId, stageAssignmentId);
	}
}
