/// <reference types="vite/client" />

import * as OnnxRuntimeWeb from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';
import { GeneratedText, StagePayloadFactory, type EncodedTensor, type LlmStagePayload } from '@webai/protocol';
import type { ModelDownloadProgress } from './model_download_progress.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StageHelperLlmQwen3_0_6bSharded — runs one Qwen3-0.6B shard stage in a worker browser
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Adapts the proven shard-loading and tensor-handling logic from
 * packages/_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/src/model_helper.ts
 * to run behind the real stage-assignment pipeline (see https://github.com/webai-at-home/webai-at-home/issues/9)
 * instead of one in-page button.
 *
 * One task's shards are always assigned to the same worker device. The language-model
 * pipeline states `repeatsUntilDone`, so the gateway runs its shard stages again from the
 * first once per generated token, and each of those stages states `prefersSameWorkerOnRetry`
 * so even a retried attempt comes back to the device that already holds the state. That lets
 * each shard keep its own key-value cache in this module's memory, keyed by task identifier,
 * instead of serializing it over the wire — only the small hand-off tensors between shards
 * travel inside stage.result/stage.assign.
 */

/** Hugging Face identifier for the Qwen3 model used by this experiment. */
const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
/** Immutable Hugging Face revision containing the three published model shards. */
const QWEN_SHARD_BASE_URL = 'https://huggingface.co/jerome-etienne/webai-at-home-qwen3-0.6b-shards/resolve/8ba2b869c4dbb96de8b72e448e79b4ec5825ae47/shards/';
/** URLs for the three shards, pinned to the uploaded Hugging Face revision. */
const SHARD_URLS = [
	`${QWEN_SHARD_BASE_URL}shard-1.onnx`,
	`${QWEN_SHARD_BASE_URL}shard-2.onnx`,
	`${QWEN_SHARD_BASE_URL}shard-3.onnx`,
] as const;
/** Direct URL for the tokenizer vocabulary and merge configuration. */
const TOKENIZER_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer.json`;
/** Direct URL for the tokenizer settings. */
const TOKENIZER_CONFIG_URL = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer_config.json`;
/** Cache Storage name for the tokenizer files, separate from the IndexedDB model cache. */
const TOKENIZER_CACHE_NAME = 'webai-qwen3-tokenizer-v1';
/** IndexedDB database name for the downloaded model. */
const MODEL_CACHE_NAME = 'onnxruntime-qwen3-models';
/** IndexedDB schema version for the model cache. */
const MODEL_CACHE_VERSION = 2;
/** End-of-sequence token identifier used to stop generation. */
const EOS_TOKEN_ID = 151645;
/**
 * Maximum number of tokens generated for one task, as a safety bound if the model never emits the
 * end-of-sequence token.
 */
const MAX_NEW_TOKENS = 160;

/** The named tensors passed to and returned from the ONNX model. */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;
type ShardSession = OnnxRuntimeWeb.InferenceSession;
type ModelLoadingPhase = 'downloading' | 'graphics-memory';

const SHARD_BOUNDARIES = [
	undefined,
	{
		normalized: '/model/layers.9/input_layernorm/output_0',
		residual: '/model/layers.9/input_layernorm/output_3',
	},
	{
		normalized: '/model/layers.19/input_layernorm/output_0',
		residual: '/model/layers.19/input_layernorm/output_3',
	},
] as const;

/** Maps an ONNX Runtime tensor type to the typed-array constructor backing its data. */
const TYPED_ARRAY_BY_ONNX_TYPE: Record<
	string,
	(new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType) | undefined
> = {
	float32: Float32Array,
	float64: Float64Array,
	int64: BigInt64Array as unknown as new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType,
	uint64: BigUint64Array as unknown as new (buffer: ArrayBuffer) => OnnxRuntimeWeb.Tensor.DataType,
	int32: Int32Array,
	uint32: Uint32Array,
	int16: Int16Array,
	uint16: Uint16Array,
	float16: Uint16Array,
	int8: Int8Array,
	uint8: Uint8Array,
	bool: Uint8Array,
};

OnnxRuntimeWeb.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}assets/`;
OnnxRuntimeWeb.env.logLevel = 'fatal';

/** Per-task generation state kept in memory for as long as that task's shards run on this device. */
type TaskGenerationState = {
	/** Each shard's own key-value cache from its most recent run, reused on its next run. */
	caches: Array<TensorMap | undefined>;
	/** Token identifiers generated so far, in order. */
	generatedIds: number[];
	/**
	 * The answer as this device last reported it, which is what each round measures its own
	 * piece against.
	 *
	 * A round cannot work out its piece by decoding the token it just generated on its own. A
	 * token is not a character: one may finish a character another began, and how a token reads
	 * depends on the tokens around it. The answer is therefore decoded whole every round, as it
	 * always was, and the piece is what that whole answer has gained since the previous round.
	 * `GeneratedText` is where the two are compared, including what to do about a character the
	 * rounds so far have only half written.
	 */
	reportedText: string;
};

/** Loads the qwen3-0.6b shards and runs the assigned shard for each stage of a task's generation loop. */
export class StageHelperLlmQwen3_0_6bSharded {
	/**
	 * The computation this worker browser implements, named the way a pipeline stage names
	 * its computation.
	 *
	 * A stage is dispatched by its computation and its position in its pipeline, not by its
	 * stage name, so a pipeline may name its shard stages anything as long as it lists three
	 * of them in shard order.
	 */
	static readonly computation = 'llm_qwen3_0_6b_shard';

	/** How many shards this browser can run, which is how many the loaded model was split into. */
	static readonly shardCount = 3;

	/**
	 * Reports whether this helper implements a computation.
	 *
	 * @param computation The computation named by a pipeline stage.
	 * @returns `true` when this helper can run it.
	 */
	static implementsComputation(computation: string): boolean {
		return computation === StageHelperLlmQwen3_0_6bSharded.computation;
	}

	/** The three ordered shard sessions: input, middle, and output. */
	private static shardSessions: Array<ShardSession | undefined> = [];
	/** Tokenizer instance, once tokenizer data has loaded. */
	private static tokenizer: Tokenizer | undefined;
	/** Shared promise that prevents concurrent model loads. */
	private static loadPromise: Promise<void> | undefined;
	/** Generation state for each task currently running its shards on this device. */
	private static stateByTaskId = new Map<string, TaskGenerationState>();

	/**
	 * Runs the shard for one assigned stage against the payload received from the gateway.
	 *
	 * @param shardIndex Which shard to run, taken from the assigned stage's position in its pipeline.
	 * @param taskId The task this stage belongs to, used to look up its key-value cache and generated tokens so far.
	 * @param payload The incoming stage payload (the prompt for shard 1's first round, or the previous
	 * shard's hand-off otherwise).
	 * @returns The outgoing stage payload to send back as the stage result.
	 * @throws If the pipeline asks for a shard beyond the number this browser's model was split into.
	 */
	static async compute(shardIndex: number, taskId: string, payload: LlmStagePayload): Promise<LlmStagePayload> {
		if (shardIndex < 0 || shardIndex >= StageHelperLlmQwen3_0_6bSharded.shardCount) {
			throw new Error(`This browser runs ${StageHelperLlmQwen3_0_6bSharded.shardCount} language-model shards and was asked for shard ${shardIndex + 1}.`);
		}
		await StageHelperLlmQwen3_0_6bSharded.loadModel([shardIndex]);
		const session = StageHelperLlmQwen3_0_6bSharded.shardSessions[shardIndex];
		if (session === undefined) {
			throw new Error(`LLM shard ${shardIndex + 1} was not loaded.`);
		}
		const isFirstShard = shardIndex === 0;
		const isFirstRound = isFirstShard && payload.inputIds === undefined;
		const state = isFirstRound
			? StageHelperLlmQwen3_0_6bSharded.startTask(taskId)
			: (StageHelperLlmQwen3_0_6bSharded.stateByTaskId.get(taskId) ?? StageHelperLlmQwen3_0_6bSharded.startTask(taskId));

		const inputIds = isFirstRound ? StageHelperLlmQwen3_0_6bSharded.encodePrompt(payload.text ?? '') : (payload.inputIds ?? []);
		// Shard 1's first round is the only round that ever sees the prompt text, so it is also the
		// only round that can measure it. Every hop since — shard to shard, round to round — carries
		// this number forward on the wire rather than in memory, because each shard runs on its own
		// device. See milestone 3 of issue #150.
		const promptTokenCount = isFirstRound ? inputIds.length : payload.promptTokenCount;
		const position = payload.position ?? 0;
		const boundary = payload.tensors ? StageHelperLlmQwen3_0_6bSharded.decodeBoundary(payload.tensors) : undefined;

		const outputs = await session.run(
			StageHelperLlmQwen3_0_6bSharded.buildFeeds(session, inputIds, position, state.caches[shardIndex], boundary),
		);
		state.caches[shardIndex] = Object.fromEntries(
			Object.entries(outputs)
				.filter(([name]) => name.startsWith('present.'))
				.map(([name, value]) => [name.replace('present', 'past_key_values'), value]),
		);

		const isLastShard = shardIndex === StageHelperLlmQwen3_0_6bSharded.shardCount - 1;
		if (isLastShard) {
			const nextToken = StageHelperLlmQwen3_0_6bSharded.getNextToken(StageHelperLlmQwen3_0_6bSharded.findLogits(session, outputs));
			state.generatedIds.push(nextToken);
			const text = StageHelperLlmQwen3_0_6bSharded.tokenizer?.decode(state.generatedIds, {
				skip_special_tokens: true,
			}).trim() ?? '';
			const isEndOfSequence = nextToken === EOS_TOKEN_ID;
			const done = isEndOfSequence || state.generatedIds.length >= MAX_NEW_TOKENS;
			// Nothing is held back once the answer is finished: there is no round after this one to
			// report the rest, so what a reader has been shown must add up to the whole answer.
			const reportable = done ? text : GeneratedText.reportable(state.reportedText, text);
			const newText = GeneratedText.addition(state.reportedText, reportable);
			state.reportedText = reportable;
			if (done) {
				StageHelperLlmQwen3_0_6bSharded.clearTask(taskId);
				// The whole answer travels once, on the one result that ends the task, and the piece
				// travels with it so a reader joining the pieces receives the last one as well. See
				// milestone 3 of issue #150 for the usage this stage now reports alongside it.
				return StagePayloadFactory.llmDone(
					text,
					newText,
					StageHelperLlmQwen3_0_6bSharded.usageOf(state, promptTokenCount, isEndOfSequence ? 'end_of_sequence' : 'max_new_tokens'),
				);
			}
			return StagePayloadFactory.llmContinue(newText, nextToken, position + inputIds.length, promptTokenCount);
		}

		const boundaryNames = SHARD_BOUNDARIES[shardIndex + 1];
		if (boundaryNames === undefined) {
			throw new Error(`Missing boundary definition after shard ${shardIndex + 1}.`);
		}
		return StagePayloadFactory.llmHandoff(
			{
				[boundaryNames.normalized]: StageHelperLlmQwen3_0_6bSharded.encodeTensor(outputs[boundaryNames.normalized]),
				[boundaryNames.residual]: StageHelperLlmQwen3_0_6bSharded.encodeTensor(outputs[boundaryNames.residual]),
			},
			inputIds,
			position,
			promptTokenCount,
		);
	}

	/**
	 * Builds the `usage` object for the final {@link StagePayloadFactory.llmDone} call, field by
	 * field, so a value typed `number | undefined` is never assigned into a parameter typed
	 * merely optional, which `exactOptionalPropertyTypes` refuses.
	 *
	 * @param state This task's generation state, holding the tokens generated so far.
	 * @param promptTokenCount The exact number of tokens the prompt was encoded into, carried
	 * forward from shard 1's first round on the wire.
	 * @param stopReason Which of the two ways this stage can finish generating just happened.
	 * @returns The `usage` object to pass to `llmDone`.
	 */
	private static usageOf(
		state: TaskGenerationState,
		promptTokenCount: number | undefined,
		stopReason: 'end_of_sequence' | 'max_new_tokens',
	): { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } {
		const usage: { promptTokenCount?: number; completionTokenCount?: number; stopReason?: 'end_of_sequence' | 'max_new_tokens' | 'interrupted' } = {
			stopReason,
			completionTokenCount: state.generatedIds.length,
		};
		if (promptTokenCount !== undefined) {
			usage.promptTokenCount = promptTokenCount;
		}
		return usage;
	}

	/**
	 * Clears a task's in-memory generation state.
	 *
	 * Called once generation finishes naturally, and should also be called when a task's
	 * stage fails, so an abandoned task does not keep its key-value cache in memory forever.
	 *
	 * @param taskId The task whose generation state should be discarded.
	 */
	static clearTask(taskId: string): void {
		StageHelperLlmQwen3_0_6bSharded.stateByTaskId.delete(taskId);
	}

	/**
	 * Preloads the LLM shards enabled for this worker before gateway connection.
	 *
	 * @param shardIndexes Which shards this worker will be asked to run, taken from the
	 * positions of the enabled language-model stages in their pipeline.
	 * @param onLoadingPhase Called with which broad phase loading has reached.
	 * @param onProgress Called with progress steps while the tokenizer and shard files download.
	 */
	static preload(
		shardIndexes: readonly number[],
		onLoadingPhase?: (phase: ModelLoadingPhase) => void,
		onProgress?: (progress: ModelDownloadProgress) => void,
	): Promise<void> {
		const runnable = shardIndexes.filter(
			(shardIndex) => shardIndex >= 0 && shardIndex < StageHelperLlmQwen3_0_6bSharded.shardCount,
		);
		return runnable.length === 0 ? Promise.resolve() : StageHelperLlmQwen3_0_6bSharded.loadModel(runnable, onLoadingPhase, onProgress);
	}

	/** Creates and stores fresh generation state for a task's first round. */
	private static startTask(taskId: string): TaskGenerationState {
		const state: TaskGenerationState = {
			caches: [undefined, undefined, undefined],
			generatedIds: [],
			reportedText: '',
		};
		StageHelperLlmQwen3_0_6bSharded.stateByTaskId.set(taskId, state);
		return state;
	}


	/**
	 * Loads the tokenizer and creates the three ONNX Runtime Web shard sessions once per page.
	 */
	private static async loadModel(
		requestedShardIndexes: readonly number[],
		onLoadingPhase?: (phase: ModelLoadingPhase) => void,
		onProgress?: (progress: ModelDownloadProgress) => void,
	): Promise<void> {
		const shardIndexes = [...new Set(requestedShardIndexes)];
		const isEveryShardLoaded = shardIndexes.every((shardIndex) => StageHelperLlmQwen3_0_6bSharded.shardSessions[shardIndex]);
		if (isEveryShardLoaded && StageHelperLlmQwen3_0_6bSharded.tokenizer) {
			return;
		}
		if (StageHelperLlmQwen3_0_6bSharded.loadPromise) {
			return StageHelperLlmQwen3_0_6bSharded.loadPromise;
		}

		const hasWebGPU = 'gpu' in navigator;
		onLoadingPhase?.('downloading');
		StageHelperLlmQwen3_0_6bSharded.loadPromise = Promise.all([
			StageHelperLlmQwen3_0_6bSharded.fetchTokenizerJson(TOKENIZER_URL, 'Tokenizer download', onProgress),
			StageHelperLlmQwen3_0_6bSharded.fetchTokenizerJson(TOKENIZER_CONFIG_URL, 'Tokenizer configuration download', onProgress),
			...shardIndexes.map((shardIndex) => StageHelperLlmQwen3_0_6bSharded.fetchModelBytes(SHARD_URLS[shardIndex], onProgress)),
		]).then(async ([tokenizerJson, tokenizerConfig, ...shardBytes]) => {
			onLoadingPhase?.('graphics-memory');
			StageHelperLlmQwen3_0_6bSharded.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
			for (const [shardOffset, bytes] of shardBytes.entries()) {
				StageHelperLlmQwen3_0_6bSharded.shardSessions[shardIndexes[shardOffset]] = await OnnxRuntimeWeb.InferenceSession.create(
					bytes,
					{
						executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
						graphOptimizationLevel: 'all',
					},
				);
			}
		}).catch((error: unknown) => {
			StageHelperLlmQwen3_0_6bSharded.loadPromise = undefined;
			throw error;
		});
		return StageHelperLlmQwen3_0_6bSharded.loadPromise;
	}

	/** Reads a tokenizer JSON file from Cache Storage or downloads and stores it there. */
	private static async fetchTokenizerJson(
		url: string,
		description: string,
		onProgress?: (progress: ModelDownloadProgress) => void,
	): Promise<Record<string, unknown>> {
		let cache: Cache | undefined;
		try {
			cache = await caches.open(TOKENIZER_CACHE_NAME);
			const cachedResponse = await cache.match(url);
			if (cachedResponse !== undefined) {
				return cachedResponse.json();
			}
		} catch {
			// Cache Storage is a speed optimization only; continue with the network request.
		}

		const response = await fetch(url);
		if (response.ok === false) {
			throw new Error(`${description} failed (${response.status}).`);
		}
		if (cache !== undefined) {
			try {
				await cache.put(url, response.clone());
			} catch {
				// Cache Storage is a speed optimization only; inference can use the response directly.
			}
		}
		const bytes = await StageHelperLlmQwen3_0_6bSharded.readResponseBytes(response, url, onProgress);
		return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
	}

	/**
	 * Reads a response body to completion, reporting the base name of `url` and how much of it
	 * has arrived so far, the same progress steps `stage_helper_llm_qwen3_5_0_8b_full.ts` reports
	 * while its own model downloads.
	 *
	 * Falls back to reading the whole body at once, with no progress steps, when the response
	 * carries no `content-length` header or no readable stream — both needed to compute a
	 * percentage as bytes arrive.
	 *
	 * @param response The response whose body to read.
	 * @param url The URL the response was fetched from; only its base name is reported.
	 * @param onProgress Called with progress steps while the body downloads.
	 * @returns The response body, read to completion.
	 */
	private static async readResponseBytes(
		response: Response,
		url: string,
		onProgress?: (progress: ModelDownloadProgress) => void,
	): Promise<ArrayBuffer> {
		const file = url.split('/').pop() ?? url;
		const total = Number(response.headers.get('content-length') ?? 0);
		if (onProgress === undefined || response.body === null || total === 0) {
			return response.arrayBuffer();
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(value);
			loaded += value.length;
			onProgress({ kind: 'file_progress', file, percent: Math.round((loaded / total) * 100) });
		}
		onProgress({ kind: 'file_done', file });
		const merged = new Uint8Array(loaded);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		return merged.buffer;
	}

	/** Opens the IndexedDB database used to store the downloaded ONNX model. */
	private static openModelDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(MODEL_CACHE_NAME, MODEL_CACHE_VERSION);
			request.onupgradeneeded = () => {
				if (request.result.objectStoreNames.contains('models') === false) {
					request.result.createObjectStore('models');
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open the model cache.'));
		});
	}

	/** Reads the shard bytes from IndexedDB, returning no value when unavailable. */
	private static async readCachedModel(cacheKey: string): Promise<ArrayBuffer | undefined> {
		try {
			const database = await StageHelperLlmQwen3_0_6bSharded.openModelDatabase();
			return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
				const request = database.transaction('models', 'readonly').objectStore('models').get(cacheKey);
				request.onsuccess = () => resolve(request.result as ArrayBuffer | undefined);
				request.onerror = () => reject(request.error ?? new Error('Could not read the model cache.'));
			}).finally(() => database.close());
		} catch {
			return undefined;
		}
	}

	/** Stores the downloaded shard bytes in IndexedDB for later page loads. */
	private static async cacheModel(model: ArrayBuffer, cacheKey: string): Promise<void> {
		try {
			const database = await StageHelperLlmQwen3_0_6bSharded.openModelDatabase();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('models', 'readwrite');
				transaction.objectStore('models').put(model, cacheKey);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error ?? new Error('Could not write the model cache.'));
			}).finally(() => database.close());
		} catch {
			// Caching is a speed optimization only; a failed write should not block inference.
		}
	}

	/** Returns shard bytes from IndexedDB or downloads and caches a fresh copy. */
	private static async fetchModelBytes(url: string, onProgress?: (progress: ModelDownloadProgress) => void): Promise<ArrayBuffer> {
		const cached = await StageHelperLlmQwen3_0_6bSharded.readCachedModel(url);
		if (cached) {
			return cached;
		}
		const response = await fetch(url);
		if (response.ok === false) {
			throw new Error(`Shard download failed (${response.status}).`);
		}
		const bytes = await StageHelperLlmQwen3_0_6bSharded.readResponseBytes(response, url, onProgress);
		await StageHelperLlmQwen3_0_6bSharded.cacheModel(bytes, url);
		return bytes;
	}

	/** Encodes a prompt with the Qwen3 chat template and returns its token identifiers. */
	private static encodePrompt(prompt: string): number[] {
		if (StageHelperLlmQwen3_0_6bSharded.tokenizer === undefined) {
			throw new Error('The tokenizer is not loaded.');
		}
		const formattedPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
		return StageHelperLlmQwen3_0_6bSharded.tokenizer.encode(formattedPrompt).ids;
	}

	/**
	 * Builds the inputs for one shard call, reusing that shard's own key-value cache from its
	 * previous round when available.
	 */
	private static buildFeeds(
		session: ShardSession,
		inputIds: number[],
		position: number,
		cache: TensorMap | undefined,
		boundary: TensorMap | undefined,
	): TensorMap {
		const feeds: TensorMap = {
			input_ids: new OnnxRuntimeWeb.Tensor('int64', BigInt64Array.from(inputIds, BigInt), [1, inputIds.length]),
			attention_mask: new OnnxRuntimeWeb.Tensor(
				'int64',
				BigInt64Array.from({
					length: position + inputIds.length,
				}, () => 1n),
				[1, position + inputIds.length],
			),
			position_ids: new OnnxRuntimeWeb.Tensor(
				'int64',
				BigInt64Array.from(inputIds, (_, index) => BigInt(position + index)),
				[1, inputIds.length],
			),
		};
		if (boundary) {
			Object.assign(feeds, boundary);
		}
		for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
			feeds[name] = cache?.[name] ?? new OnnxRuntimeWeb.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
		}
		return feeds;
	}

	/** Selects the token with the highest logit value for greedy decoding. */
	private static getNextToken(logits: OnnxRuntimeWeb.Tensor): number {
		const vocabularySize = logits.dims.at(-1) ?? 0;
		const values = logits.data as Float32Array | Uint16Array;
		const offset = values.length - vocabularySize;
		let bestToken = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let tokenId = 0; tokenId < vocabularySize; tokenId += 1) {
			const value = values[offset + tokenId];
			if (value > bestValue) {
				bestValue = value;
				bestToken = tokenId;
			}
		}
		return bestToken;
	}

	/** Finds the logits tensor among a shard's outputs. */
	private static findLogits(session: ShardSession, outputs: TensorMap): OnnxRuntimeWeb.Tensor {
		const logitsName = session.outputNames.find((name) => name === 'logits' || name.endsWith('.logits'));
		const logits = logitsName ? outputs[logitsName] : undefined;
		if (logits === undefined) {
			throw new Error(`The model did not return logits. Outputs: ${Object.keys(outputs).join(', ')}`);
		}
		return logits;
	}

	/** Encodes a tensor's dimensions, type, and raw bytes as base64 text for a JSON message. */
	private static encodeTensor(tensor: OnnxRuntimeWeb.Tensor): EncodedTensor {
		const view = tensor.data as ArrayBufferView;
		const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
		let binary = '';
		const chunkSize = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
		}
		return {
			dims: [...tensor.dims],
			type: tensor.type,
			dataBase64: btoa(binary),
		};
	}

	/** Decodes the boundary tensors received from the previous shard's stage result. */
	private static decodeBoundary(tensors: Record<string, EncodedTensor>): TensorMap {
		return Object.fromEntries(
			Object.entries(tensors).map(([name, encoded]) => [name, StageHelperLlmQwen3_0_6bSharded.decodeTensor(encoded)]),
		);
	}

	/** Decodes one base64-encoded tensor back into an ONNX Runtime tensor. */
	private static decodeTensor(encoded: EncodedTensor): OnnxRuntimeWeb.Tensor {
		const binary = atob(encoded.dataBase64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		const TypedArrayConstructor = TYPED_ARRAY_BY_ONNX_TYPE[encoded.type];
		if (TypedArrayConstructor === undefined) {
			throw new Error(`Unsupported tensor type for decoding: ${encoded.type}`);
		}
		const data = new TypedArrayConstructor(bytes.buffer);
		return new OnnxRuntimeWeb.Tensor(encoded.type as OnnxRuntimeWeb.Tensor.Type, data, encoded.dims);
	}
}
