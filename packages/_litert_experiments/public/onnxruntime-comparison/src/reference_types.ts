///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReferenceTypes — the shape of the JSON files the LiteRT.js exporters wrote
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one shard produced at one decode position, reduced to the numbers worth comparing.
 */
export type DecodeStepShardOutput = {
	/** The graph's name. */
	name: string;
	/** The first eight values of its hidden state. */
	firstValues: number[];
	/** The sum of the absolute values of its hidden state. */
	absoluteSum: number;
};

/**
 * One position of the reference decode.
 */
export type DecodeStep = {
	/** The position decoded, counting from zero. */
	position: number;
	/** The token fed in at this position. */
	inputToken: number;
	/** Whether this position belongs to the prompt rather than to the generated text. */
	isPrompt: boolean;
	/** What each decoder shard produced. */
	shardOutputs: DecodeStepShardOutput[];
};

/**
 * What `tools/qwen3_decode_reference/` wrote: the whole decode, in PyTorch, over one prompt.
 */
export type DecodeReference = {
	/** The Hugging Face model that was split. */
	model: string;
	/** The prompt, as text. */
	prompt: string;
	/** The prompt, as tokens. */
	promptTokens: number[];
	/** How many positions every key/value cache holds. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** How many tokens the vocabulary holds. */
	vocabularySize: number;
	/** The tokens the split decomposition generated. */
	generatedTokens: number[];
	/** The text those tokens decode to. */
	generatedText: string;
	/** The tokens the unsplit Hugging Face model generated over the same prompt. */
	unsplitTokens: number[];
	/** The text those tokens decode to. */
	unsplitText: string;
	/** Every decoded position, in order. */
	steps: DecodeStep[];
};

/**
 * One prompt length of the prefill reference.
 */
export type PrefillReference = {
	/** How many tokens the prompt covers. */
	length: number;
	/** The prompt's tokens. */
	tokens: number[];
	/** The token the split decomposition chooses after reading them. */
	argmaxToken: number;
	/** The token the unsplit Hugging Face model chooses after reading them. */
	unsplitArgmaxToken: number;
	/** The size of one activation of this length, at 32-bit floating point. */
	activationBytes: number;
};

/**
 * What `tools/qwen3_prefill_export/` wrote.
 */
export type PrefillIndex = {
	/** The model that was split. */
	model: string;
	/** The hidden size. */
	hiddenSize: number;
	/** How many tokens the vocabulary holds. */
	vocabularySize: number;
	/** One entry per prompt length. */
	prefills: PrefillReference[];
};
