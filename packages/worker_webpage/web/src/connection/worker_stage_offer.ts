import { StageName, type StageName as StageNameType } from '@webai/protocol';
import { StageHelperDevFormula } from '../stages/stage_helper_dev_formula';
import { StageHelperLlmQwen3_0_6bSharded } from '../stages/stage_helper_llm_qwen3_0_6b_sharded';
import { StageHelperLlmGemmaNanoChromeFull } from '../stages/stage_helper_llm_gemma_nano_chrome_full';
import { StageHelperLlmQwen3_5_0_8bFull } from '../stages/stage_helper_llm_qwen3_5_0_8b_full';
import { StageHelperLlmLlama3_2_1bFull } from '../stages/stage_helper_llm_llama3_2_1b_full';
import { StageHelperLlmGemma4E2bFull } from '../stages/stage_helper_llm_gemma_4_e2b_full';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerStageOffer — decides which stages this browser offers the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Works out which of the gateway's pipeline stages this browser is willing to run.
 *
 * The decision is made against the computation a stage names, never against the stage name
 * itself, so a pipeline the gateway loaded after this browser was built can offer new stage
 * names that reuse computations already shipped here.
 */
export class WorkerStageOffer {
	/**
	 * Reads the stages the page URL restricts this worker browser to.
	 *
	 * Repeating the parameter allows one worker browser to support multiple stages. The
	 * stageNames alias keeps existing debug URLs working.
	 *
	 * @param search The page URL's query string.
	 * @returns The named stages, without repeats. An empty result means the URL asks for no
	 * particular stages, and this browser offers every stage it can run.
	 */
	static requestedStageNamesFromUrl(search: string): StageNameType[] {
		const searchParams = new URLSearchParams(search);
		const requestedStageNames = [
			...searchParams.getAll('enabledStages'),
			...searchParams.getAll('stageNames'),
		];
		const validStageNames = requestedStageNames.filter((stageName): stageName is StageNameType =>
			StageName.safeParse(stageName).success,
		);
		return [...new Set(validStageNames)];
	}

	/**
	 * Chooses the stages this browser offers to the gateway, from the pipelines the gateway has
	 * loaded.
	 *
	 * A stage is offered when this browser implements its computation and, if the page URL named
	 * particular stages, when the stage is one of those.
	 *
	 * @param pipelines The pipeline specifications the gateway returned.
	 * @param requestedStageNames The stages the page URL restricts this browser to, if any.
	 * @returns The stage names to advertise, the language-model shard positions to preload, the
	 * offered stages that need the language model built into the browser, the offered stages that
	 * need the complete Qwen3.5-0.8B model downloaded and held by this browser, and the offered
	 * stages that need the complete Llama 3.2 1B Instruct model downloaded and held by this
	 * browser, and the offered stages that need the complete Gemma 4 E2B model downloaded and held
	 * by this browser. The three full-model lists are kept apart, rather than combined into one, so
	 * that a tab offering only one of the three downloaded full models checks the readiness of and
	 * downloads only that one — combining them would have a tab offering only the Llama stage check
	 * Qwen3.5-0.8B's WebGPU and storage requirements and download Qwen3.5-0.8B's weights. Keeping
	 * Gemma 4 E2B apart matters most of the three: it is about 3111 MB, several times either of the
	 * others, so a tab dragged into downloading it by a combined list would pay the largest price.
	 */
	static offeredStages(
		pipelines: { stages: { name: string; computation: string }[] }[],
		requestedStageNames: readonly string[],
	): {
		stageNames: string[];
		llmShardIndexes: number[];
		builtInModelStageNames: string[];
		qwen3_5_0_8bFullModelStageNames: string[];
		llama3_2_1bFullModelStageNames: string[];
		gemma4E2bFullModelStageNames: string[];
	} {
		const stageNames: string[] = [];
		const llmShardIndexes: number[] = [];
		const builtInModelStageNames: string[] = [];
		const qwen3_5_0_8bFullModelStageNames: string[] = [];
		const llama3_2_1bFullModelStageNames: string[] = [];
		const gemma4E2bFullModelStageNames: string[] = [];
		for (const pipeline of pipelines) {
			for (const [stageIndex, stage] of pipeline.stages.entries()) {
				if (WorkerStageOffer.implementsComputation(stage.computation) === false) {
					continue;
				}
				if (requestedStageNames.length > 0 && requestedStageNames.includes(stage.name) === false) {
					continue;
				}
				if (stageNames.includes(stage.name) === false) {
					stageNames.push(stage.name);
				}
				if (
					StageHelperLlmQwen3_0_6bSharded.implementsComputation(stage.computation)
					&& llmShardIndexes.includes(stageIndex) === false
				) {
					llmShardIndexes.push(stageIndex);
				}
				if (
					StageHelperLlmGemmaNanoChromeFull.implementsComputation(stage.computation)
					&& builtInModelStageNames.includes(stage.name) === false
				) {
					builtInModelStageNames.push(stage.name);
				}
				if (
					StageHelperLlmQwen3_5_0_8bFull.implementsComputation(stage.computation)
					&& qwen3_5_0_8bFullModelStageNames.includes(stage.name) === false
				) {
					qwen3_5_0_8bFullModelStageNames.push(stage.name);
				}
				if (
					StageHelperLlmLlama3_2_1bFull.implementsComputation(stage.computation)
					&& llama3_2_1bFullModelStageNames.includes(stage.name) === false
				) {
					llama3_2_1bFullModelStageNames.push(stage.name);
				}
				if (
					StageHelperLlmGemma4E2bFull.implementsComputation(stage.computation)
					&& gemma4E2bFullModelStageNames.includes(stage.name) === false
				) {
					gemma4E2bFullModelStageNames.push(stage.name);
				}
			}
		}
		return { stageNames, llmShardIndexes, builtInModelStageNames, qwen3_5_0_8bFullModelStageNames, llama3_2_1bFullModelStageNames, gemma4E2bFullModelStageNames };
	}

	/**
	 * Reports whether this browser implements the computation a pipeline stage names.
	 *
	 * This is the only place the browser decides what it can run.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when one of this browser's helpers implements it.
	 */
	private static implementsComputation(computation: string): boolean {
		return StageHelperDevFormula.implementsComputation(computation)
			|| StageHelperLlmQwen3_0_6bSharded.implementsComputation(computation)
			|| StageHelperLlmGemmaNanoChromeFull.implementsComputation(computation)
			|| StageHelperLlmQwen3_5_0_8bFull.implementsComputation(computation)
			|| StageHelperLlmLlama3_2_1bFull.implementsComputation(computation)
			|| StageHelperLlmGemma4E2bFull.implementsComputation(computation);
	}
}
