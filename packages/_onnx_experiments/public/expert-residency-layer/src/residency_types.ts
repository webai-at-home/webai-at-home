///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Residency types — the shapes the residency layer of issue #169 milestone 4 passes around
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One part of one expert block, as written by
 * `packages/_onnx_experiments/tools/weight_conversion/convert_mixture_of_experts_to_expert_blocks.ts` and described in the published
 * `manifest.json`.
 */
export type BlockPart = {
	/** What the part holds, such as `gate_proj quantized`. */
	name: string;
	/** Where the part starts inside the block, in bytes. */
	offset: number;
	/** How long the part is, in bytes. */
	byteLength: number;
};

/**
 * The `manifest.json` published beside the expert blocks. Only the fields this page reads are declared, because a
 * page that declared fields it never reads would invite someone to trust them.
 */
export type BlockManifest = {
	/** The Hugging Face repository the blocks were converted from. */
	sourceRepository: string;
	/** The pinned revision of that repository. */
	sourceRevision: string;
	/** How the expert weights are quantized. */
	quantization: {
		/** How many bits one weight occupies. */
		bits: number;
		/** How many weights share one scale. */
		blockSize: number;
		/** Whether each block carries its own zero point or uses the fixed one. */
		scheme: string;
	};
	/** Everything about the expert blocks. */
	experts: {
		/** How many layers the model has. */
		layerCount: number;
		/** How many experts one layer holds. */
		expertsForEachLayer: number;
		/** How many bytes one expert block occupies. */
		blockByteLength: number;
		/** The nine parts one block is made of, in order. */
		parts: BlockPart[];
		/** How many expert blocks the published file holds. */
		convertedExpertCount: number;
	};
};

/**
 * What the residency layer holds in graphics memory for one expert, once that expert is resident.
 *
 * There are nine buffers rather than one because ONNX Runtime Web binds a whole buffer to an input and cannot be
 * given a range inside a larger one. That was measured in milestone 0, and it is the reason the cache cannot be one
 * big arena with offsets into it.
 */
export type ExpertSlotBuffers = {
	/** The quantized weights, the scales, and the zero points of each projection, in the order the block stores them. */
	buffers: GPUBuffer[];
};

/**
 * How the residency layer is set up before any step runs.
 */
export type ResidencyConfiguration = {
	/**
	 * How many bytes of graphics memory the expert cache may hold. This is given rather than discovered, because
	 * milestone 2 measured that WebGPU never refuses an allocation: a page can take 64 gigabytes on a machine with 16
	 * and only get slower. A layer that probed for its own budget would find a number that does not exist.
	 */
	cacheByteBudget: number;
	/** How many staging buffers the ring holds. Each one is one expert block long. */
	stagingBufferCount: number;
	/** How many experts of each layer are pinned, meaning never evicted. */
	pinnedForEachLayer: number;
};

/**
 * What one generated token cost the residency layer.
 */
export type StepMeasurement = {
	/** Which step this was, counted from zero. */
	stepIndex: number;
	/** How many expert lookups this step made, which is the layer count times the experts chosen for each layer. */
	lookupCount: number;
	/** How many of those lookups found the expert already in graphics memory. */
	hitCount: number;
	/** How many bytes were read from the Origin Private File System for this step. */
	readByteLength: number;
	/** How long the step spent waiting for weights that were not resident, in milliseconds. */
	stalledMilliseconds: number;
	/** How long the whole step took, in milliseconds. */
	totalMilliseconds: number;
};

/**
 * What a whole run of steps came to.
 */
export type RunSummary = {
	/** Every step of the run, in order. */
	steps: StepMeasurement[];
	/** Which expert-selection sequence drove the run. */
	selection: SelectionKind;
	/** How many slots the cache held. */
	slotCount: number;
	/** How many experts the model has in total. */
	expertCount: number;
	/** How many of them the cache could hold at once. */
	residentFraction: number;
};

/**
 * Which synthetic sequence of expert selections drives a run.
 *
 * Neither is the real thing. The real sequence comes from the router of Qwen3-30B-A3B reading a real prompt, and that
 * needs the graph milestone 5 builds. These two bracket it instead: `uniform` is the worst case a cache can meet, and
 * `skewed` is what a routed mixture of experts is generally observed to do. Any hit rate quoted from this page must
 * name which of the two produced it.
 */
export type SelectionKind = 'uniform' | 'skewed';
