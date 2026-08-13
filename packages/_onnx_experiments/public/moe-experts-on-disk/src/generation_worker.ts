import * as OnnxRuntimeWeb from 'onnxruntime-web';
import type { FileSystemSyncAccessHandle, SyncCapableFileHandle } from './browser_storage_types.js';
import type { GenerationRequest, GenerationResponse } from './generation_worker_messages.js';
import type { ExpertStorage, ModelIndex } from './model_types.js';
import type { ExpertResidency, ResidentExpert } from './moe_generator.js';
import type { ExpertSlot } from './expert_slot_cache.js';
import { ExpertSlotCache } from './expert_slot_cache.js';
import { MoeGenerator } from './moe_generator.js';
import { StagingBufferRing } from './staging_buffer_ring.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GenerationWorker — the whole of milestone 6 of issue #169, in one dedicated worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Everything lives here for the reason milestone 4 found: the synchronous access handle of the Origin Private File
 * System exists only inside a worker, and moving an expert costs a copy on whichever thread does the moving. So the
 * file handle, the WebGPU device, all eighteen graphs, the staging ring, the cache, and the model loop are all here,
 * and an expert goes from disk into graphics memory without crossing a thread boundary once.
 *
 * One thing is done in an order that looks odd and is not. Milestone 0 measured that ONNX Runtime Web ignores a
 * device offered through `env.webgpu.device` before the first session exists: the assignment is accepted, the runtime
 * then runs on a device of its own, and a buffer allocated on the offered device fails at bind group creation while
 * the run quietly returns zeros. So the smallest graph is created first, the device is read back out of the runtime,
 * and every buffer this worker owns is allocated on that one.
 */

/**
 * The name of each model's block file in the Origin Private File System.
 *
 * These are the names milestone 4 and milestone 5 wrote, and they are kept rather than renamed. A rename in the Origin
 * Private File System is a copy, and copying 15.61 gigabytes needs 15.61 gigabytes of free quota that this machine
 * does not have while the original is still there.
 */
const BLOCK_FILE_NAMES: Record<string, string> = {
	'Qwen3-30B-A3B': 'expert_blocks.bin',
	'OLMoE-1B-7B-0924': 'olmoe_expert_blocks.bin',
};
/** How many blocks one download request covers. One request for each block would be 1024 requests. */
const BLOCKS_FOR_EACH_REQUEST = 32;
/** How many times a download request is retried. */
const REQUEST_ATTEMPT_COUNT = 5;
/** How many staging buffers the ring holds. Milestone 4 measured eight to be more than enough at this block size. */
const STAGING_BUFFER_COUNT = 8;
/**
 * Roughly how large each of the main memory run's arrays is, rounded down to a whole number of blocks.
 *
 * Well under any JavaScript engine's cap on a single array, so that what the middle line measures is the machine's
 * memory rather than one array's maximum length.
 */
const MAIN_MEMORY_CHUNK_BYTE_LENGTH = 512 * 1024 * 1024;

/** The parts of a dedicated worker's global scope this file uses, because the DOM types describe a window instead. */
type DedicatedWorkerScope = {
	/**
	 * Listens for messages from the page.
	 *
	 * @param type Always `message`.
	 * @param listener What to call with each message.
	 * @returns Nothing.
	 */
	addEventListener(type: 'message', listener: (event: MessageEvent<GenerationRequest>) => void): void;
	/**
	 * Sends a message back to the page.
	 *
	 * @param message What to send.
	 * @returns Nothing.
	 */
	postMessage(message: GenerationResponse): void;
};

/** The block store, the graphs, the residency layer, and the model loop. */
class GenerationWorker {
	/** Where the graphs are served from, kept from the opening request. */
	private static _graphsUrl: string | undefined;
	/** What `graphs.json` said. */
	private static _index: ModelIndex | undefined;
	/** The open handle on the block file. */
	private static _handle: FileSystemSyncAccessHandle | undefined;
	/** The device the runtime chose, borrowed rather than offered. */
	private static _device: GPUDevice | undefined;
	/** The staging buffers, created once and recycled. */
	private static _ring: StagingBufferRing | undefined;
	/** The expert cache in graphics memory, replaced between runs because the two runs size it differently. */
	private static _cache: ExpertSlotCache | undefined;
	/** The model, once every graph is loaded. */
	private static _generator: MoeGenerator | undefined;
	/** How many bytes this run has read off the disk. */
	private static _readByteLength = 0;
	/** How long this run has spent stalled making experts available, in milliseconds. */
	private static _stalledMilliseconds = 0;
	/** Where this run keeps its expert weights. */
	private static _storage: ExpertStorage = 'disk';
	/**
	 * Every expert block in processor-side arrays, for the run that keeps them in main memory.
	 *
	 * Several arrays rather than one, and that is what makes the middle line honest. A JavaScript engine caps how
	 * large a single array may be, and that cap is well below the 15.61 gigabytes of Qwen3-30B-A3B. Asking for one
	 * array of everything would fail on a machine with room to spare, and the failure would be reported as "main
	 * memory cannot hold this model" when what could not hold it was one array.
	 *
	 * Undefined for the other two runs, and given back at the end of every run. A machine holding these and a graphics
	 * memory cache of the same model at the same time would be measuring its swap file rather than either of them.
	 */
	private static _mainMemoryBlocks: Uint8Array[] | undefined;
	/** How many blocks each of those arrays holds. */
	private static _blocksForEachMainMemoryChunk = 0;

	/**
	 * Starts listening.
	 *
	 * @param scope The worker's global scope.
	 * @returns Nothing.
	 */
	static listen(scope: DedicatedWorkerScope): void {
		scope.addEventListener('message', (event) => {
			void GenerationWorker._handleRequest(scope, event.data);
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Requests
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one request and reports whatever it produced, including a failure.
	 *
	 * @param scope The worker's global scope, to answer on.
	 * @param request What the page asked for.
	 * @returns Resolves when the request has been answered.
	 */
	private static async _handleRequest(scope: DedicatedWorkerScope, request: GenerationRequest): Promise<void> {
		try {
			if (request.kind === 'open-store') {
				scope.postMessage(await GenerationWorker._openStore(request.graphsUrl, request.modelName));
			} else if (request.kind === 'fill-store') {
				await GenerationWorker._fillStore(scope, request.blocksUrl);
			} else if (request.kind === 'load-graphs') {
				scope.postMessage(await GenerationWorker._loadGraphs());
			} else if (request.kind === 'run') {
				await GenerationWorker._run(scope, request);
			}
		} catch (error) {
			scope.postMessage({
				kind: 'failed',
				requestKind: request.kind,
				message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			});
		}
	}

	/**
	 * Reads `graphs.json`, opens the block file, and reports how much of it is already on disk.
	 *
	 * @param graphsUrl Where the graphs are served from.
	 * @param modelName Which model this is, which names its store.
	 * @returns What the store holds.
	 */
	private static async _openStore(graphsUrl: string, modelName: string): Promise<GenerationResponse> {
		GenerationWorker._graphsUrl = graphsUrl;
		const response = await fetch(`${graphsUrl}/graphs.json`);
		if (response.ok === false) {
			throw new Error(
				`${graphsUrl}/graphs.json returned ${response.status}. The artifacts are generated — see ` +
					'packages/_onnx_experiments/tools/README.md.',
			);
		}
		const index = await response.json() as ModelIndex;
		GenerationWorker._index = index;

		const blockFileName = BLOCK_FILE_NAMES[modelName];
		if (blockFileName === undefined) {
			throw new Error(`${modelName} has no block file name, so there is nowhere to keep its experts`);
		}
		const directory = await navigator.storage.getDirectory();
		const fileHandle = (await directory.getFileHandle(blockFileName, {
			create: true,
		})) as SyncCapableFileHandle;
		GenerationWorker._handle = await fileHandle.createSyncAccessHandle();

		const blockByteLength = index.expertBlocks.blockByteLength;
		return {
			kind: 'store-opened',
			index: index,
			presentBlockCount: Math.floor(GenerationWorker._handle.getSize() / blockByteLength),
			wantedBlockCount: index.layerCount * index.expertsForEachLayer,
		};
	}

	/**
	 * Downloads whatever blocks are missing and writes them at their exact offsets.
	 *
	 * The store fills from block zero upwards and its length is the record of how far it got, so nothing is ever
	 * downloaded twice and closing the page loses at most the request in flight.
	 *
	 * @param scope The worker's global scope, to report progress on.
	 * @param blocksUrl Where the expert block file lives.
	 * @returns Resolves when every block is present.
	 */
	private static async _fillStore(scope: DedicatedWorkerScope, blocksUrl: string): Promise<void> {
		const index = GenerationWorker._requireIndex();
		const handle = GenerationWorker._requireHandle();
		const blockByteLength = index.expertBlocks.blockByteLength;
		const wantedBlockCount = index.layerCount * index.expertsForEachLayer;
		const startedAt = performance.now();
		let presentBlockCount = Math.floor(handle.getSize() / blockByteLength);
		let downloadedByteLength = 0;

		while (presentBlockCount < wantedBlockCount) {
			const runBlockCount = Math.min(BLOCKS_FOR_EACH_REQUEST, wantedBlockCount - presentBlockCount);
			const firstByte = presentBlockCount * blockByteLength;
			const byteLength = runBlockCount * blockByteLength;
			const bytes = await GenerationWorker._fetchRange(blocksUrl, firstByte, firstByte + byteLength);
			// What `write` returns is checked rather than discarded. A browser that has run out of storage may refuse
			// the write by throwing, and may also simply write fewer bytes and say so. Ignoring the count leaves a
			// store that is short, a block count that says it is not, and a model that reads whatever happens to be
			// at the offset it wanted — which is exactly the kind of wrong that looks like a hard question about
			// floating point rather than a missing file.
			const writtenByteLength = handle.write(bytes, {
				at: firstByte,
			});
			handle.flush();
			if (writtenByteLength !== bytes.length) {
				const estimate = await navigator.storage.estimate();
				throw new Error(
					`the store took only ${writtenByteLength} of ${bytes.length} bytes at block ${presentBlockCount}. ` +
						`This browser reports ${GenerationWorker._gigabytes(estimate.usage ?? 0)} used of ` +
						`${GenerationWorker._gigabytes(estimate.quota ?? 0)}, and the whole model needs ` +
						`${GenerationWorker._gigabytes(wantedBlockCount * blockByteLength)}.`,
				);
			}
			presentBlockCount += runBlockCount;
			downloadedByteLength += byteLength;
			scope.postMessage({
				kind: 'fill-progress',
				presentBlockCount: presentBlockCount,
				wantedBlockCount: wantedBlockCount,
				bytesEachSecond: downloadedByteLength / ((performance.now() - startedAt) / 1000),
			});
		}

		scope.postMessage({
			kind: 'store-filled',
			seconds: (performance.now() - startedAt) / 1000,
			downloadedByteLength: downloadedByteLength,
		});
	}

	/**
	 * Creates every graph, borrows the device the runtime chose, and reads the embedding table.
	 *
	 * @returns What was loaded.
	 */
	private static async _loadGraphs(): Promise<GenerationResponse> {
		const index = GenerationWorker._requireIndex();
		const graphsUrl = GenerationWorker._graphsUrl;
		const startedAt = performance.now();

		// The smallest graph first, so that the device exists before anything large is created and before any buffer
		// this worker owns is allocated. See the note at the top of this file.
		const expertSession = await GenerationWorker._createSession(`${graphsUrl}/${index.expertGraph}`);
		const device = await OnnxRuntimeWeb.env.webgpu.device as GPUDevice | undefined;
		if (device === undefined) {
			throw new Error('the runtime created a session but gave back no WebGPU device, so no expert can be held');
		}
		GenerationWorker._device = device;
		GenerationWorker._ring = new StagingBufferRing(device, index.expertBlocks.blockByteLength, STAGING_BUFFER_COUNT);

		const layerSessions: OnnxRuntimeWeb.InferenceSession[] = [];
		for (const graph of index.layerGraphs) {
			layerSessions.push(await GenerationWorker._createSession(`${graphsUrl}/${graph.fileName}`));
		}
		const headSession = await GenerationWorker._createSession(`${graphsUrl}/${index.headGraph}`);

		const embeddingResponse = await fetch(`${graphsUrl}/${index.tokenEmbedding.fileName}`);
		if (embeddingResponse.ok === false) {
			throw new Error(`the token embedding returned ${embeddingResponse.status}`);
		}
		const embeddingBytes = await embeddingResponse.arrayBuffer();
		const embedding = index.tokenEmbedding.elementType === 'bfloat16'
			? new Uint16Array(embeddingBytes)
			: new Float32Array(embeddingBytes);
		const expected = index.tokenEmbedding.rowCount * index.tokenEmbedding.columnCount;
		if (embedding.length !== expected) {
			throw new Error(
				`the token embedding holds ${embedding.length} values where ${expected} were expected, so it does not ` +
					'describe this model',
			);
		}

		GenerationWorker._generator = new MoeGenerator(index, layerSessions, headSession, expertSession, embedding);

		const graphByteLength = index.layerGraphs.reduce((total, graph) => total + graph.byteLength, 0);
		return {
			kind: 'graphs-loaded',
			seconds: (performance.now() - startedAt) / 1000,
			byteLength: graphByteLength + embedding.byteLength,
			maximumBufferByteLength: device.limits.maxBufferSize,
		};
	}

	/**
	 * Runs the model once, with the expert weights kept where the request asked for.
	 *
	 * The three storage classes are the three lines the deliverable of issue #168 asks for. Everything else about the
	 * run is identical — the same graphs, the same arithmetic, the same order — so what separates them is only what
	 * has to happen before an expert can be multiplied by anything.
	 *
	 * @param scope The worker's global scope, to report tokens on.
	 * @param request Which run this is and how it is set up.
	 * @returns Resolves when the run has finished.
	 */
	private static async _run(
		scope: DedicatedWorkerScope,
		request: Extract<GenerationRequest, { kind: 'run' }>,
	): Promise<void> {
		const index = GenerationWorker._requireIndex();
		const device = GenerationWorker._requireDevice();
		const generator = GenerationWorker._requireGenerator();
		const expertCount = index.layerCount * index.expertsForEachLayer;
		const slotCount = request.storage === 'graphics-memory' ? expertCount : request.slotCount;

		// A fresh cache for each run, so no run starts with anything another one left behind. The old one is forgotten
		// before the new one is asked for, because asking is what fails when the storage class cannot hold the model,
		// and a cache that has already been destroyed must not be destroyed again by the run after that.
		GenerationWorker._cache?.destroy();
		GenerationWorker._cache = undefined;
		GenerationWorker._cache = new ExpertSlotCache(device, index.expertBlocks.parts, slotCount);
		GenerationWorker._readByteLength = 0;
		GenerationWorker._stalledMilliseconds = 0;
		GenerationWorker._storage = request.storage;

		let preloadMilliseconds = 0;
		if (request.storage === 'main-memory') {
			const preloadStartedAt = performance.now();
			scope.postMessage({
				kind: 'run-preparing',
				message: `reading all ${expertCount} experts into main memory, ` +
					`${GenerationWorker._gigabytes(expertCount * index.expertBlocks.blockByteLength)}`,
			});
			GenerationWorker._mainMemoryBlocks = GenerationWorker._readEveryBlockIntoMainMemory();
			preloadMilliseconds = performance.now() - preloadStartedAt;
		} else {
			GenerationWorker._mainMemoryBlocks = undefined;
		}
		if (request.storage === 'graphics-memory') {
			const preloadStartedAt = performance.now();
			scope.postMessage({
				kind: 'run-preparing',
				message: `reading all ${expertCount} experts into graphics memory, ` +
					`${GenerationWorker._gigabytes(expertCount * index.expertBlocks.blockByteLength)}`,
			});
			await GenerationWorker._preloadEveryExpert();
			preloadMilliseconds = performance.now() - preloadStartedAt;
			GenerationWorker._readByteLength = 0;
		}

		const generateStartedAt = performance.now();
		const produced = await generator.generate(
			request.promptTokenIds,
			request.newTokenCount,
			GenerationWorker._residency(),
			(tokenId) => {
				scope.postMessage({
					kind: 'token',
					label: request.label,
					tokenId: tokenId,
				});
			},
		);
		await device.queue.onSubmittedWorkDone();

		scope.postMessage({
			kind: 'run-finished',
			outcome: {
				label: request.label,
				storage: request.storage,
				slotCount: slotCount,
				everyExpertPreloaded: request.storage === 'graphics-memory',
				tokenIds: produced.tokenIds,
				lookupCount: produced.lookupCount,
				hitCount: produced.hitCount,
				readByteLength: GenerationWorker._readByteLength,
				generateMilliseconds: performance.now() - generateStartedAt,
				preloadMilliseconds: preloadMilliseconds,
				stalledMilliseconds: GenerationWorker._stalledMilliseconds,
				newTokenCount: request.newTokenCount,
			},
		});
		// Main memory is given back before the next run asks for it, because the next run may want the same bytes
		// somewhere else and a machine holding both would be measuring the swap file.
		GenerationWorker._mainMemoryBlocks = undefined;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Residency
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Hands the model loop something that can make an expert resident.
	 *
	 * @returns The residency the loop asks.
	 */
	private static _residency(): ExpertResidency {
		return {
			acquire: async (layerIndex: number, expertNumber: number): Promise<ResidentExpert> => {
				const index = GenerationWorker._requireIndex();
				const cache = GenerationWorker._requireCache();
				const expertIndex = layerIndex * index.expertsForEachLayer + expertNumber;
				const outcome = cache.acquire(expertIndex);
				if (outcome.wasResident === false) {
					const stallStartedAt = performance.now();
					await GenerationWorker._loadExpert(expertIndex, outcome.slot);
					GenerationWorker._stalledMilliseconds += performance.now() - stallStartedAt;
					GenerationWorker._readByteLength += index.expertBlocks.blockByteLength;
				}
				return {
					buffers: outcome.slot.buffers,
					wasResident: outcome.wasResident,
				};
			},
		};
	}

	/**
	 * Reads every expert of the model into the cache before any token is generated.
	 *
	 * This is what makes the first run the control it is meant to be. A cache with a slot for every expert would end
	 * up holding all of them anyway, but only after the tokens that wanted them, so the first tokens would still be
	 * misses and the run would not be the "everything is already there" case it is being read as.
	 *
	 * @returns Resolves once every expert is in graphics memory.
	 */
	private static async _preloadEveryExpert(): Promise<void> {
		const index = GenerationWorker._requireIndex();
		const cache = GenerationWorker._requireCache();
		const expertCount = index.layerCount * index.expertsForEachLayer;
		if (cache.slotCount < expertCount) {
			throw new Error(
				`the cache holds ${cache.slotCount} experts and the model has ${expertCount}, so they cannot all be ` +
					'resident at once',
			);
		}
		for (let expertIndex = 0; expertIndex < expertCount; expertIndex++) {
			const outcome = cache.acquire(expertIndex);
			await GenerationWorker._loadExpert(expertIndex, outcome.slot);
		}
		await GenerationWorker._requireDevice().queue.onSubmittedWorkDone();
	}

	/**
	 * Reads every expert block off the disk into one processor-side array.
	 *
	 * This is the middle line of the deliverable of issue #168: the weights are in main memory rather than on disk,
	 * and rather than in graphics memory. A model too large for this allocation to succeed is a model that line
	 * cannot reach, which is the whole point of drawing it.
	 *
	 * @returns Every block, in the same order the file holds them, split across several arrays.
	 */
	private static _readEveryBlockIntoMainMemory(): Uint8Array[] {
		const index = GenerationWorker._requireIndex();
		const handle = GenerationWorker._requireHandle();
		const blockByteLength = index.expertBlocks.blockByteLength;
		const expertCount = index.layerCount * index.expertsForEachLayer;
		const blocksForEachChunk = Math.max(1, Math.floor(MAIN_MEMORY_CHUNK_BYTE_LENGTH / blockByteLength));
		GenerationWorker._blocksForEachMainMemoryChunk = blocksForEachChunk;

		const held: Uint8Array[] = [];
		for (let firstBlock = 0; firstBlock < expertCount; firstBlock += blocksForEachChunk) {
			const blockCount = Math.min(blocksForEachChunk, expertCount - firstBlock);
			let chunk: Uint8Array;
			try {
				chunk = new Uint8Array(blockCount * blockByteLength);
			} catch (error) {
				const reached = firstBlock * blockByteLength;
				throw new Error(
					`main memory took ${GenerationWorker._gigabytes(reached)} of experts and refused the next ` +
						`${GenerationWorker._gigabytes(blockCount * blockByteLength)}, of ` +
						`${GenerationWorker._gigabytes(expertCount * blockByteLength)} wanted. That is the answer ` +
						`rather than a failure: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const readByteLength = handle.read(chunk, {
				at: firstBlock * blockByteLength,
			});
			if (readByteLength !== chunk.length) {
				throw new Error(
					`the store gave back ${readByteLength} bytes where ${chunk.length} were expected at block ` +
						`${firstBlock}, so it does not hold every expert`,
				);
			}
			held.push(chunk);
		}
		return held;
	}

	/**
	 * Reads one expert into its slot in graphics memory, from wherever this run keeps them.
	 *
	 * This never touches `queue.writeBuffer`. Milestone 2 measured that almost everything `writeBuffer` charges is a
	 * copy on the calling thread, before the queue ever sees the bytes. The bytes go from the synchronous access
	 * handle straight into a mapped WebGPU buffer, and the nine copies that follow are queue work.
	 *
	 * @param expertIndex Which expert, counted across the whole model.
	 * @param slot The slot in graphics memory to fill.
	 * @returns Resolves once the copies are submitted.
	 */
	private static async _loadExpert(expertIndex: number, slot: ExpertSlot): Promise<void> {
		const index = GenerationWorker._requireIndex();
		const handle = GenerationWorker._requireHandle();
		const ring = GenerationWorker._requireRing();
		const device = GenerationWorker._requireDevice();
		const blockByteLength = index.expertBlocks.blockByteLength;

		const staging = await ring.acquire();
		const target = new Uint8Array(staging.mapped);
		const held = GenerationWorker._mainMemoryBlocks;
		if (held !== undefined) {
			// From main memory: one processor-side copy into the mapped buffer, and no file is touched. This is the
			// same work as the disk path minus the read, which is exactly what the middle line has to measure.
			const blocksForEachChunk = GenerationWorker._blocksForEachMainMemoryChunk;
			const chunk = held[Math.floor(expertIndex / blocksForEachChunk)];
			const startsAt = (expertIndex % blocksForEachChunk) * blockByteLength;
			target.set(chunk.subarray(startsAt, startsAt + blockByteLength));
		} else {
			const readByteLength = handle.read(target, {
				at: expertIndex * blockByteLength,
			});
			if (readByteLength !== blockByteLength) {
				ring.unmap(staging);
				ring.recycle(staging);
				throw new Error(
					`expert ${expertIndex} read ${readByteLength} bytes where ${blockByteLength} were expected, so the ` +
						'store does not hold this expert',
				);
			}
		}
		ring.unmap(staging);

		const encoder = device.createCommandEncoder();
		const parts = index.expertBlocks.parts;
		for (let partIndex = 0; partIndex < parts.length; partIndex++) {
			encoder.copyBufferToBuffer(
				staging.buffer,
				parts[partIndex].offset,
				slot.buffers[partIndex],
				0,
				parts[partIndex].byteLength,
			);
		}
		device.queue.submit([encoder.finish()]);
		ring.recycle(staging);

		// The copies must have run before the expert graph reads these buffers. Everywhere else in this project the
		// wait is deferred, because nothing downstream was reading the bytes; here something is, immediately.
		await device.queue.onSubmittedWorkDone();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Creates one session on the WebGPU execution provider.
	 *
	 * @param url Where the graph is.
	 * @returns The created session.
	 */
	private static async _createSession(url: string): Promise<OnnxRuntimeWeb.InferenceSession> {
		return await OnnxRuntimeWeb.InferenceSession.create(url, {
			executionProviders: ['webgpu'],
		});
	}

	/**
	 * Downloads one range of the block file, retrying, and refuses a short answer.
	 *
	 * @param blocksUrl Where the block file lives.
	 * @param firstByte The first byte wanted.
	 * @param lastByte The byte after the last one wanted.
	 * @returns The bytes.
	 */
	private static async _fetchRange(blocksUrl: string, firstByte: number, lastByte: number): Promise<Uint8Array> {
		let lastError: unknown;
		for (let attempt = 0; attempt < REQUEST_ATTEMPT_COUNT; attempt++) {
			try {
				const response = await fetch(blocksUrl, {
					headers: {
						Range: `bytes=${firstByte}-${lastByte - 1}`,
					},
				});
				if (response.ok === false) {
					throw new Error(`${response.status} ${response.statusText}`);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length !== lastByte - firstByte) {
					throw new Error(`${bytes.length} bytes came back where ${lastByte - firstByte} were asked for`);
				}
				return bytes;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
			}
		}
		throw new Error(`${blocksUrl} could not be read after ${REQUEST_ATTEMPT_COUNT} attempts: ${lastError}`);
	}

	/**
	 * Formats a byte count in gigabytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	private static _gigabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} gigabytes`;
	}

	/**
	 * Returns what `graphs.json` said, or throws when the store has not been opened.
	 *
	 * @returns The model index.
	 */
	private static _requireIndex(): ModelIndex {
		if (GenerationWorker._index === undefined) {
			throw new Error('graphs.json has not been read, so nothing knows what shape this model is');
		}
		return GenerationWorker._index;
	}

	/**
	 * Returns the open block file handle, or throws when there is none.
	 *
	 * @returns The handle.
	 */
	private static _requireHandle(): FileSystemSyncAccessHandle {
		if (GenerationWorker._handle === undefined) {
			throw new Error('the block store is not open');
		}
		return GenerationWorker._handle;
	}

	/**
	 * Returns the device the runtime chose, or throws when no graph has been loaded yet.
	 *
	 * @returns The device.
	 */
	private static _requireDevice(): GPUDevice {
		if (GenerationWorker._device === undefined) {
			throw new Error('no graph has been loaded, so there is no device to allocate on');
		}
		return GenerationWorker._device;
	}

	/**
	 * Returns the staging ring, or throws when it has not been created.
	 *
	 * @returns The ring.
	 */
	private static _requireRing(): StagingBufferRing {
		if (GenerationWorker._ring === undefined) {
			throw new Error('the staging ring does not exist');
		}
		return GenerationWorker._ring;
	}

	/**
	 * Returns the expert cache, or throws when no run has created one.
	 *
	 * @returns The cache.
	 */
	private static _requireCache(): ExpertSlotCache {
		if (GenerationWorker._cache === undefined) {
			throw new Error('no run is under way, so there is no expert cache');
		}
		return GenerationWorker._cache;
	}

	/**
	 * Returns the model, or throws when the graphs have not been loaded.
	 *
	 * @returns The generator.
	 */
	private static _requireGenerator(): MoeGenerator {
		if (GenerationWorker._generator === undefined) {
			throw new Error('the graphs have not been loaded');
		}
		return GenerationWorker._generator;
	}
}

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
GenerationWorker.listen(self as unknown as DedicatedWorkerScope);
