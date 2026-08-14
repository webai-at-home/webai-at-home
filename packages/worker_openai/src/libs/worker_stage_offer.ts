import { StageCatalog } from '../stages/stage_catalog.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerStageOffer — decides which stages this worker offers the central gateway
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The shape of a loaded pipeline this decision reads, which is its stages and nothing else. */
export type OfferedPipeline = {
	/** The stages of the pipeline, in the order they run. */
	stages: {
		/** The stage's own name, such as `stage_llm_llama3_2_1b_full`. */
		name: string;
		/** The computation the stage needs a worker to run, such as `llm_llama3_2_1b_full`. */
		computation: string;
	}[];
};

/** The stages this worker could offer, as the loaded pipelines describe them. */
export type OfferedStages = {
	/** Every stage this worker could offer. */
	stageNames: string[];
	/** The offered stages that need a local server holding the model, checked before registering. */
	localModelStageNames: string[];
};

/**
 * Works out which of the gateway's pipeline stages this worker is willing to run.
 *
 * The decision is made against the computation a stage names, never against the stage name
 * itself, so a pipeline the gateway loaded after this worker was built can offer new stage names
 * that reuse computations already shipped here. This is the same rule the worker browser page
 * follows in `packages/worker_webpage/web/src/connection/worker_stage_offer.ts`.
 */
export class WorkerStageOffer {
	/**
	 * Chooses the stages this worker offers to the gateway, from the pipelines the gateway has
	 * loaded.
	 *
	 * A stage is offered when this worker implements its computation and, if the command line
	 * named particular stages, when the stage is one of those.
	 *
	 * @param pipelines The pipeline specifications the gateway returned.
	 * @param requestedStageNames The stages the command line restricts this worker to, if any.
	 * An empty list means this worker offers every stage it can run.
	 * @returns The stage names to advertise, and which of them need a local server holding the
	 * model before they can be advertised.
	 */
	static offeredStages(pipelines: OfferedPipeline[], requestedStageNames: readonly string[]): OfferedStages {
		const stageNames: string[] = [];
		const localModelStageNames: string[] = [];
		for (const pipeline of pipelines) {
			for (const stage of pipeline.stages) {
				if (StageCatalog.implementsComputation(stage.computation) === false) {
					continue;
				}
				if (requestedStageNames.length > 0 && requestedStageNames.includes(stage.name) === false) {
					continue;
				}
				if (stageNames.includes(stage.name) === false) {
					stageNames.push(stage.name);
				}
				// Every stage helper this worker carries reaches the local server for its model, so
				// every stage offered here is one that server must hold the model for.
				if (localModelStageNames.includes(stage.name) === false) {
					localModelStageNames.push(stage.name);
				}
			}
		}
		return { stageNames, localModelStageNames };
	}
}
