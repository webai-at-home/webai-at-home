import { PipelineSpecificationSchema, type PipelineSpecification, type StageName, type TaskInput } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	PipelineRegistry — holds the pipeline definitions a task may be run against
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Holds validated pipeline definitions. Versions are immutable once a task selects one. */
export class PipelineRegistry {
	private readonly specifications = new Map<string, PipelineSpecification>();

	/**
	 * @param specifications The pipelines to register at startup.
	 */
	constructor(specifications: PipelineSpecification[]) {
		for (const specification of specifications) this.add(specification);
	}

	/**
	 * Validates a pipeline specification and registers it.
	 *
	 * @param value The specification to validate.
	 * @returns The registered specification.
	 * @throws If it does not validate, or that pipeline and version is already registered.
	 */
	add(value: unknown): PipelineSpecification {
		const specification = PipelineSpecificationSchema.parse(value);
		const key = this.key(specification.pipelineId, specification.version);
		if (this.specifications.has(key)) throw new Error(`Pipeline ${specification.pipelineId}@${specification.version} is already registered`);
		this.specifications.set(key, specification);
		return specification;
	}

	/**
	 * Chooses the pipeline to run a submitted task through.
	 *
	 * @param input The submitted task input, whose kind the pipeline must serve.
	 * @param pipelineId A particular pipeline to insist on, when the consumer named one.
	 * @param pipelineVersion A particular version to insist on, when the consumer named one.
	 * @returns The highest matching version that is still in use, or `undefined` when none matches.
	 */
	select(input: TaskInput, pipelineId?: string, pipelineVersion?: number): PipelineSpecification | undefined {
		const candidates = [...this.specifications.values()]
			.filter((specification) => specification.taskType === input.taskType && specification.retired !== true)
			.filter((specification) => pipelineId === undefined || specification.pipelineId === pipelineId)
			.filter((specification) => pipelineVersion === undefined || specification.version === pipelineVersion)
			.sort((left, right) => right.version - left.version);
		return candidates[0];
	}

	/**
	 * Looks up one exact pipeline version.
	 *
	 * @param pipelineId The pipeline to look up.
	 * @param version The version to look up.
	 * @returns The specification, or `undefined` when it is not registered.
	 */
	get(pipelineId: string, version: number): PipelineSpecification | undefined { return this.specifications.get(this.key(pipelineId, version)); }
	/** Returns every registered specification, retired ones included. */
	list(): PipelineSpecification[] { return [...this.specifications.values()]; }

	/**
	 * Reports whether any pipeline that is still in use defines a stage.
	 *
	 * The registry is the authority on which stage names exist. `StageName` in the shared
	 * protocol package only checks the shape of a name, so a worker advertising a stage no
	 * pipeline defines is caught here rather than by schema validation.
	 *
	 * @param stageName - The stage name to look for.
	 * @returns `true` when a pipeline that is not retired lists the stage.
	 */
	definesStage(stageName: StageName): boolean {
		return this.list().some((specification) => specification.retired !== true && specification.stages.some((stage) => stage.name === stageName));
	}

	/**
	 * Lists every stage name defined by a pipeline that is still in use.
	 *
	 * @returns The stage names, without repetition.
	 */
	stageNames(): StageName[] {
		return [...new Set(this.list().filter((specification) => specification.retired !== true).flatMap((specification) => specification.stages.map((stage) => stage.name)))];
	}

	private key(pipelineId: string, version: number): string { return `${pipelineId}\u0000${version}`; }
}

/**
 * The pipelines the gateway knows without being given a pipeline file.
 *
 * These are ordinary specifications with no privileged status. The gateway advances a task
 * through the stages its pipeline lists, and a worker runs the computation each stage names,
 * so replacing either of these through `--pipeline-file` needs no change to the source.
 */
export const builtinPipelineSpecifications: PipelineSpecification[] = [
	{
		pipelineId: 'dev_formula', version: 1, taskType: 'task_type_dev_formula',
		stages: [
			{ name: 'stage_dev_formula_multiply', computation: 'dev_formula_multiply', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
			{ name: 'stage_dev_formula_add', computation: 'dev_formula_add', inputSchemaId: 'number@1', outputSchemaId: 'number@1', encoding: 'inline-json' },
		],
	},
	{
		// The three shards run once per generated token, so this pipeline repeats until a shard
		// result reports that generation is done. All shards of one task stay on one device, so
		// the worker keeps its key-value cache in memory between rounds instead of sending it
		// over the connection; that is what prefersSameWorkerOnRetry protects when an attempt is
		// retried.
		pipelineId: 'llm_qwen3_0_6b_sharded', version: 1, taskType: 'task_type_llm_qwen3_0_6b_sharded', repeatsUntilDone: true,
		stages: [
			{ name: 'stage_llm_qwen3_0_6b_shard1of3', computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true },
			{ name: 'stage_llm_qwen3_0_6b_shard2of3', computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true },
			{ name: 'stage_llm_qwen3_0_6b_shard3of3', computation: 'llm_qwen3_0_6b_shard', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', prefersSameWorkerOnRetry: true },
		],
	},
	{
		// Chrome's built-in language model is asked for an answer once and then delivers it in
		// pieces, and how many runs of this stage those pieces are read in follows from what the
		// consumer asked for (https://github.com/webai-at-home/webai-at-home/issues/77). A task
		// that asked for nothing has one run read every piece and return the whole answer, so it
		// finishes on its first run. A task that asked for its answer in pieces has one run read
		// one piece, so it takes a run and two gateway messages per piece, plus one final run that
		// finds the answer finished. The pipeline repeats until a stage result reports generation
		// finished, which is what ends the task either way. The lease is longer than the
		// gateway default because creating the model session on a device that has just
		// downloaded the model is slow; a run that outlasts even that lease is carried by the
		// stage heartbeats the worker browser sends while it is generating.
		pipelineId: 'llm_gemma_nano_chrome_full', version: 1, taskType: 'task_type_llm_gemma_nano_chrome_full', repeatsUntilDone: true,
		stages: [
			{ name: 'stage_llm_gemma_nano_chrome_full', computation: 'llm_gemma_nano_chrome_full', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', leaseMs: 60_000, prefersSameWorkerOnRetry: true },
		],
	},
	{
		// Qwen3.5-0.8B is held complete on one device, the same as Chrome's built-in model, so
		// this pipeline follows the same shape: it asks the worker for an answer once and reads
		// it back in pieces or in one piece depending on what the consumer asked for, and it
		// repeats until a stage result reports generation finished. All rounds of one task stay
		// on one device, so the worker keeps its downloaded model and its generation state in
		// memory between rounds instead of sending it over the connection; that is what
		// prefersSameWorkerOnRetry protects when an attempt is retried. The lease is longer than
		// the gateway default for the same reason as the Chrome pipeline above: a device that has
		// just downloaded and loaded the model needs time before its first result, measured at
		// about 163 seconds in a live run against the pinned revision; a run that outlasts even
		// this lease is carried by the stage heartbeats the worker browser sends while it is
		// downloading, loading, or generating.
		pipelineId: 'llm_qwen3_5_0_8b_full', version: 1, taskType: 'task_type_llm_qwen3_5_0_8b_full', repeatsUntilDone: true,
		stages: [
			{ name: 'stage_llm_qwen3_5_0_8b_full', computation: 'llm_qwen3_5_0_8b_full', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', leaseMs: 60_000, prefersSameWorkerOnRetry: true },
		],
	},
	{
		// Llama 3.2 3B is held complete on one device by a local server that speaks the
		// OpenAI-compatible Chat Completions API, such as LM Studio, and the worker that
		// runs this stage is a Node.js process that forwards the prompt to that server rather than
		// a browser tab running the model itself
		// (https://github.com/webai-at-home/webai-at-home/issues/100). The shape is otherwise the
		// same as the Qwen3.5-0.8B pipeline above: the worker is asked for an answer once and it is
		// read back in pieces or in one piece depending on what the consumer asked for, and the
		// pipeline repeats until a stage result reports generation finished. An answer read in
		// pieces stays open in the memory of the worker process producing it, so all rounds of one
		// task must reach that same process, which is what prefersSameWorkerOnRetry protects when
		// an attempt is retried. The lease is longer than the gateway default because the local
		// server loads the model on the first request of a task; a run that outlasts even this
		// lease is carried by the stage heartbeats the worker sends while a completion request is
		// in flight.
		pipelineId: 'llm_llama3_2_3b_full', version: 1, taskType: 'task_type_llm_llama3_2_3b_full', repeatsUntilDone: true,
		stages: [
			{ name: 'stage_llm_llama3_2_3b_full', computation: 'llm_llama3_2_3b_full', inputSchemaId: 'llm@1', outputSchemaId: 'llm@1', encoding: 'inline-json', leaseMs: 60_000, prefersSameWorkerOnRetry: true },
		],
	},
];
