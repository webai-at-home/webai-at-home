///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	FixtureTypes — the shape of the two files make_expert_block_graph_fixture.mjs writes
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * This gate cannot invent its own input. The whole question is whether ONNX Runtime Web reads the bytes that
 * `convert_mixture_of_experts_to_expert_blocks.mjs` actually wrote, so the block has to come from that pipeline, and
 * the answer to compare against has to be computed somewhere other than in this browser.
 *
 * `packages/_onnx_experiments/tools/weight_conversion/make_expert_block_graph_fixture.mjs` writes both, and these types describe what it
 * writes.
 */

/** Where one part of an expert block sits inside the block. */
export type BlockPart = {
	/** What the part holds, such as `gate_proj quantized`. */
	name: string;
	/** Where the part starts inside the block, in bytes. */
	offset: number;
	/** How long the part is, in bytes. */
	byteLength: number;
};

/** One real expert block, and an answer for it computed on the processor side outside the browser. */
export type ExpertBlockReference = {
	/** The tool that wrote this file. */
	producedBy: string;
	/** The issue this belongs to. */
	issue: string;
	/** The model the block was converted from, as the conversion pipeline names it. */
	modelName: string;
	/** The Hugging Face repository the weights were read from. */
	sourceRepository: string;
	/** The pinned revision the weights were read at. */
	sourceRevision: string;
	/** Which block of the converted file this is. */
	blockIndex: number;
	/** Which layer the block belongs to. */
	layerIndex: number;
	/** Which expert of that layer the block holds. */
	expertIndex: number;
	/** The model's hidden size, which is the length of the input and of the answer. */
	hiddenSize: number;
	/** The width of the expert's inner projection. */
	expertWidth: number;
	/** How the block was quantized. */
	quantization: {
		/** How many bits one stored weight occupies. */
		bits: number;
		/** How many weights share one scale. */
		blockSize: number;
		/** Which scheme was used. */
		scheme: string;
		/** Whether a zero point is stored for every block. */
		zeroPointIsStored: boolean;
		/** Whether the scales are stored at half precision. */
		scalesAreHalfPrecision: boolean;
		/** How a stored value is restored. */
		storedValueMeaning: string;
	};
	/** How long one whole block is, in bytes. */
	blockByteLength: number;
	/** Where each of the nine parts sits inside the block. */
	parts: BlockPart[];
	/** In words, how the two answers below were arrived at. */
	howTheAnswerWasComputed: string;
	/** The expert input, one value for each hidden channel. */
	input: number[];
	/** The expert output computed in single precision, one value for each hidden channel. */
	output: number[];
	/**
	 * The same expert output with every intermediate value and every running total rounded to half precision. The
	 * graph the browser runs is a half precision graph, because `MatMulNBits` requires the activation and the scales
	 * to share an element type and milestone 3 stored the scales at half precision. This is the far edge of what that
	 * costs: rounding after every single addition is the worst a half precision implementation can do, since a
	 * graphics processor adds in a tree and a tree is more accurate.
	 */
	outputAtHalfPrecision: number[];
};
