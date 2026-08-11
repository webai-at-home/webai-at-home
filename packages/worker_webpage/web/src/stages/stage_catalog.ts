///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageCatalog — the fixed list of every stage this worker webpage can offer to run
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One stage this worker webpage can offer to run, with a short description for the settings panel. */
export type StageCatalogEntry = {
	/** The stage name, exactly as the gateway names it, such as `stage_dev_formula_multiply`. */
	name: string;
	/** A short description of what the stage does, for a volunteer choosing which stages to run. */
	description: string;
};

/**
 * Names every stage this worker webpage carries a helper for, in the order the settings panel
 * lists them.
 *
 * This list is fixed rather than read from the gateway, because it names what this worker webpage
 * itself is able to run, not what pipelines happen to be loaded on the gateway this tab last
 * connected to. See `docs/tasks_and_stages.md` for the complete description of every task type and
 * stage.
 */
export class StageCatalog {
	static readonly entries: readonly StageCatalogEntry[] = [
		{
			name: 'stage_dev_formula_multiply',
			description: 'Multiplies the submitted number by two. Part of the development formula test task, used to exercise the coordination path without a language model.',
		},
		{
			name: 'stage_dev_formula_add',
			description: 'Adds seven to the incoming number. Part of the development formula test task, used to exercise the coordination path without a language model.',
		},
		{
			name: 'stage_llm_qwen3_0_6b_shard1of3',
			description: 'Runs the first shard of the Qwen3-0.6B language model, one of three shards split across cooperating browsers.',
		},
		{
			name: 'stage_llm_qwen3_0_6b_shard2of3',
			description: 'Runs the middle shard of the Qwen3-0.6B language model, one of three shards split across cooperating browsers.',
		},
		{
			name: 'stage_llm_qwen3_0_6b_shard3of3',
			description: 'Runs the last shard of the Qwen3-0.6B language model and chooses the next generated token.',
		},
		{
			name: 'stage_llm_gemma_nano_chrome_full',
			description: 'Generates text with the Gemma Nano language model built into the Chrome browser. No model download needed.',
		},
		{
			name: 'stage_llm_qwen3_5_0_8b_full',
			description: 'Generates text with the complete Qwen3.5-0.8B language model, downloaded and held entirely by this browser tab.',
		},
		{
			name: 'stage_llm_llama3_2_1b_full',
			description: 'Generates text with the complete Llama 3.2 1B Instruct language model, downloaded and held entirely by this browser tab.',
		},
	];
}
