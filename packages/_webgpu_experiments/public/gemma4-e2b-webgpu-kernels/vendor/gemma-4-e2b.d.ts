///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	gemma-4-e2b.d.ts — the public interface of the vendored gemma-4-e2b.js bundle
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// `gemma-4-e2b.js` is generated JavaScript and carries no type declarations of its own, so this file
// declares the part of it this experiment calls. TypeScript finds this file because it sits next to
// `gemma-4-e2b.js` and shares its name. It is written by hand, not generated: when the bundle is updated,
// this file is checked against the new bundle by hand. See `README.md` next to this file for where the
// bundle comes from.

/**
 * One step of the model load, reported to the `onProgress` callback of `Gemma4Mobile.load`.
 */
export type Gemma4MobileProgressEvent = {
	/** Which phase of the load this event belongs to. */
	status: 'init' | 'tokenizer' | 'weights' | 'ready';
	/** How far this phase has come, from 0 to 1, when the phase can say. */
	fraction?: number;
	/** Whether `loaded` and `total` count bytes downloaded or tensors written to the graphics processor. */
	kind?: 'bytes' | 'tensors';
	/** How much of this phase is done, in bytes or in tensors, matching `kind`. */
	loaded?: number;
	/** How much this phase has in total, in bytes or in tensors, matching `kind`. */
	total?: number;
	/** Whether the weights came from the browser cache instead of from the network. */
	fromCache?: boolean;
	/** A phase-specific message, such as the name of the tensor being written. */
	message?: string;
};

/**
 * One generated token, yielded by `Gemma4Mobile.generate`.
 */
export type Gemma4MobileGeneratedToken = {
	/** The identifier of the token that was generated. */
	token: number;
	/** The text this one token added, already decoded. */
	delta: string;
	/** The whole answer decoded so far, not only the part this token added. */
	text: string;
};

/**
 * One WebGPU compute shader the bundle compiled on this machine's graphics processor.
 */
export type Gemma4MobileRenderedShader = {
	/** The name of the compute shader. */
	name: string;
	/** The WebGPU Shading Language source the bundle compiled. */
	code: string;
};

/**
 * One message of the history handed to `Gemma4Mobile.generate`.
 */
export type Gemma4MobileMessage = {
	/** Who wrote the message, which the chat template reads. */
	role: string;
	/** What the message says. */
	content: string;
};

/**
 * The options `Gemma4Mobile.generate` accepts. There are no sampling options: the bundle always takes the
 * highest scoring token, so the same history always gives the same answer.
 */
export type Gemma4MobileGenerateOptions = {
	/** How many tokens the answer may hold at most. The bundle uses 512 when this is not given. */
	maxNewTokens?: number;
	/** Which token identifier or identifiers end the answer, overriding the model's own. */
	eosTokenId?: number | number[];
	/** Stops the generation when it is aborted. */
	signal?: AbortSignal;
};

/**
 * The WebGPU runtime under the model, which holds the compiled compute shaders.
 */
export type Gemma4MobileRuntime = {
	/**
	 * @returns Every compute shader compiled so far, which is empty until the first generation has run.
	 */
	getRenderedShaders?: () => Gemma4MobileRenderedShader[];
};

/**
 * Gemma 4 E2B running on WebGPU compute kernels written by hand, with no model runtime between the page and
 * the graphics processor.
 */
export class Gemma4Mobile {
	/** The WebGPU runtime under the model, which holds the compiled compute shaders. */
	readonly runtime: Gemma4MobileRuntime;

	/**
	 * Downloads the weights, requests a WebGPU device, and writes the weights to it.
	 *
	 * @param modelId The Hugging Face model to load, or `null` for `DEFAULT_MODEL_ID`.
	 * @param options `onProgress` is called for every step of the load.
	 * @returns The loaded model.
	 */
	static load(
		modelId: string | null,
		options?: {
			onProgress?: (event: Gemma4MobileProgressEvent) => void;
		},
	): Promise<Gemma4Mobile>;

	/**
	 * Runs one short generation, so that every compute shader is compiled before anything is measured.
	 *
	 * @returns Nothing, once the warm-up generation has finished.
	 */
	warmup(): Promise<void>;

	/**
	 * Generates an answer, greedily, one token at a time.
	 *
	 * @param messages The history, oldest message first.
	 * @param options How long the answer may be, what ends it, and what stops it.
	 * @returns An asynchronous iterator over the generated tokens.
	 */
	generate(
		messages: Gemma4MobileMessage[],
		options?: Gemma4MobileGenerateOptions,
	): AsyncIterableIterator<Gemma4MobileGeneratedToken>;

	/**
	 * Empties the key/value cache and the remembered history, so the next generation starts from nothing.
	 *
	 * @returns Nothing.
	 */
	reset(): void;

	/**
	 * Releases the WebGPU device and every buffer the model holds.
	 *
	 * @returns Nothing.
	 */
	dispose(): void;
}

/** The Hugging Face model the bundle loads when `Gemma4Mobile.load` is given `null`. */
export const DEFAULT_MODEL_ID: string;

/**
 * Works out where the weight files of a model are read from.
 *
 * @param modelId The Hugging Face model, or `null` for `DEFAULT_MODEL_ID`.
 * @returns The base address every weight file is read from.
 */
export function resolveModelRoot(modelId: string | null): string;
