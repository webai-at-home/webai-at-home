///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Model types — the shape of what the two conversion tools of issue #169 wrote
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * This page joins two sets of files written by two different tools, and they are only ever brought together here at
 * run time:
 *
 * - `convert_mixture_of_experts_to_expert_blocks.mjs` wrote `expert_blocks.bin`, 1024 expert blocks of 3,637,248
 *   bytes each, and it is the only thing this page streams.
 * - `build_olmoe_graphs.py` wrote the 16 layer graphs, the head graph, the weightless expert graph, the token
 *   embedding table, and the `graphs.json` these types describe.
 *
 * `build_olmoe_graphs.py` refuses to build unless the published configuration describes the blocks it was pointed at,
 * so the two halves cannot disagree about a size without that check failing first.
 */

/** One part of one expert block, as the conversion pipeline wrote it. */
export type BlockPart = {
	/** What the part holds, such as `gate_proj quantized`. */
	name: string;
	/** Where the part starts inside the block, in bytes. */
	offset: number;
	/** How long the part is, in bytes. */
	byteLength: number;
};

/** One built graph file. */
export type GraphFile = {
	/** The file's name inside the graphs directory. */
	fileName: string;
	/** How long the file is, in bytes. */
	byteLength: number;
};

/** Everything `graphs.json` says, of which this page reads all of it. */
export type ModelIndex = {
	/** The tool that wrote this. */
	producedBy: string;
	/** The Hugging Face repository the weights came from. */
	sourceRepository: string;
	/** The pinned revision of that repository. */
	sourceRevision: string;
	/** The element type every graph works in. */
	elementType: string;
	/** How many decoder layers the model has. */
	layerCount: number;
	/** The width of one token's activation. */
	hiddenSize: number;
	/** The width of one expert's inner projection. */
	expertWidth: number;
	/** How many attention heads each layer has. */
	headCount: number;
	/** How many key and value heads each layer has. OLMoE has as many as it has attention heads. */
	keyValueHeadCount: number;
	/** How wide one head is. */
	headDimension: number;
	/** How many tokens the model knows. */
	vocabularySize: number;
	/** How many experts one layer holds. */
	expertsForEachLayer: number;
	/** How many experts each token chooses in each layer. */
	expertsForEachToken: number;
	/**
	 * Whether the chosen routing weights are divided by their own sum. OLMoE sets this false, so they are raw softmax
	 * probabilities over all 64 experts and do not add up to one. Renormalising them multiplies every expert's
	 * contribution by about 2.64 and leaves the output looking entirely reasonable, which is why this is read rather
	 * than assumed.
	 */
	normalizeTopExpertWeights: boolean;
	/** The base of the rotary position embedding's frequencies. */
	rotaryTheta: number;
	/** Any rotary scaling the checkpoint declares, which for this one is none. */
	rotaryScaling: unknown;
	/** What is added to the variance before its square root in every normalization. */
	normalizationEpsilon: number;
	/** The 16 layer graphs, in order. */
	layerGraphs: GraphFile[];
	/** The file holding the final normalization and the language model head. */
	headGraph: string;
	/** The file holding one expert, with all nine of its weight tensors as runtime inputs. */
	expertGraph: string;
	/** The token embedding table, which is looked up rather than multiplied and so is not a graph. */
	tokenEmbedding: {
		/** The file's name. */
		fileName: string;
		/** How many tokens it holds. */
		rowCount: number;
		/** How wide each row is. */
		columnCount: number;
		/** The element type of its values. */
		elementType: string;
	};
	/** Where the expert blocks are and how they are laid out. */
	expertBlocks: {
		/** The file's name. */
		fileName: string;
		/** How long one block is, in bytes. */
		blockByteLength: number;
		/** In words, how a layer and an expert become a block number. */
		blockIndexFormula: string;
		/** The nine parts one block is made of, in order. */
		parts: BlockPart[];
	};
};

/**
 * Where the expert weights are kept for one run.
 *
 * These are the three lines the deliverable of issue #168 asks for. They are the same model, the same graphs, and the
 * same arithmetic, differing only in what has to happen before an expert can be multiplied by anything.
 */
export type ExpertStorage =
	/** Every expert already in a WebGPU buffer, read in once before any token. Nothing is read while generating. */
	| 'graphics-memory'
	/** Every expert in one processor-side array, copied into a staging buffer when it is chosen. */
	| 'main-memory'
	/** Every expert on disk in the Origin Private File System, read when it is chosen. */
	| 'disk';

/** What one whole run of the model produced and cost. */
export type RunOutcome = {
	/** Which run this was, in words. */
	label: string;
	/** Where the expert weights were kept. */
	storage: ExpertStorage;
	/** How many experts the cache could hold at once. */
	slotCount: number;
	/** Whether every expert of the model was read into the cache before generating. */
	everyExpertPreloaded: boolean;
	/** How long the run spent stalled making experts available, in milliseconds. */
	stalledMilliseconds: number;
	/** How many tokens were generated after the prompt. */
	newTokenCount: number;
	/** The prompt followed by every token generated. */
	tokenIds: number[];
	/** How many expert lookups the run made. */
	lookupCount: number;
	/** How many of them found the expert already in graphics memory. */
	hitCount: number;
	/** How many bytes were read from the Origin Private File System while generating. */
	readByteLength: number;
	/** How long generating took, in milliseconds, not counting any preloading. */
	generateMilliseconds: number;
	/** How long preloading every expert took, in milliseconds, or zero when there was none. */
	preloadMilliseconds: number;
};
