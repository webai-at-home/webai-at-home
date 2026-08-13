import type { FileSystemSyncAccessHandle, SyncCapableFileHandle } from './browser_storage_types.js';
import type { BlockManifest, ResidencyConfiguration, SelectionKind, StepMeasurement } from './residency_types.js';
import type { ResidencyRequest, ResidencyResponse } from './residency_worker_messages.js';
import { ExpertSelection } from './expert_selection.js';
import { ExpertSlotCache } from './expert_slot_cache.js';
import { StagingBufferRing } from './staging_buffer_ring.js';
import type { ExpertSlot } from './expert_slot_cache.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResidencyWorker — the whole residency layer of issue #169 milestone 4, in one dedicated worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Everything lives here on purpose. The synchronous access handle of the Origin Private File System only exists inside
 * a worker, and milestone 2 measured that what an expert costs to move is dominated by a copy on whichever thread does
 * the moving. Keeping the file handle, the WebGPU device, the staging ring, and the cache in one worker means an expert
 * goes from disk into a mapped buffer and then into graphics memory without crossing a thread boundary once.
 *
 * The name of the file in the Origin Private File System.
 */
const BLOCK_FILE_NAME = 'expert_blocks.bin';
/** How many blocks one download request covers. One request for each block would be 6144 requests for the whole model. */
const BLOCKS_FOR_EACH_REQUEST = 32;
/** How many times a download request is retried, since filling the store runs for many minutes. */
const REQUEST_ATTEMPT_COUNT = 5;
/** How many steps the warm-up counts before choosing which experts to pin. */
const WARM_UP_STEP_COUNT = 16;

/** The parts of a dedicated worker's global scope this file uses, because the DOM types describe a window instead. */
type DedicatedWorkerScope = {
	/**
	 * Listens for messages from the page.
	 *
	 * @param type Always `message`.
	 * @param listener What to call with each message.
	 * @returns Nothing.
	 */
	addEventListener(type: 'message', listener: (event: MessageEvent<ResidencyRequest>) => void): void;
	/**
	 * Sends a message back to the page.
	 *
	 * @param message What to send.
	 * @returns Nothing.
	 */
	postMessage(message: ResidencyResponse): void;
};

/** The residency layer: the block store on disk, the staging ring, the expert cache, and the measurement loop. */
class ResidencyWorker {
	/** The open handle on the block file, held for the life of the worker rather than reopened for each read. */
	private static _handle: FileSystemSyncAccessHandle | undefined;
	/** The published layout of the blocks. */
	private static _manifest: BlockManifest | undefined;
	/** The device the buffers belong to. */
	private static _device: GPUDevice | undefined;
	/** The staging buffers, created once and recycled. */
	private static _ring: StagingBufferRing | undefined;
	/** The expert cache in graphics memory. */
	private static _cache: ExpertSlotCache | undefined;
	/** How the layer was set up, kept because the pinned count is only acted on once a run knows its sequence. */
	private static _configuration: ResidencyConfiguration | undefined;

	/**
	 * Starts listening.
	 *
	 * @param scope The worker's global scope.
	 * @returns Nothing.
	 */
	static listen(scope: DedicatedWorkerScope): void {
		scope.addEventListener('message', (event) => {
			void ResidencyWorker._handle_request(scope, event.data);
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
	private static async _handle_request(scope: DedicatedWorkerScope, request: ResidencyRequest): Promise<void> {
		try {
			if (request.kind === 'open-store') {
				scope.postMessage(await ResidencyWorker._openStore(request.manifest));
			} else if (request.kind === 'fill-store') {
				await ResidencyWorker._fillStore(scope, request.blocksUrl, request.wantedBlockCount);
			} else if (request.kind === 'start-residency') {
				scope.postMessage(await ResidencyWorker._startResidency(request.configuration));
			} else if (request.kind === 'run-steps') {
				await ResidencyWorker._runSteps(scope, request.stepCount, request.selection, request.selectedForEachLayer);
			} else if (request.kind === 'stop-residency') {
				ResidencyWorker._stopResidency();
				scope.postMessage({
					kind: 'residency-stopped',
				});
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
	 * Opens the block file and reports how much of it is already on disk.
	 *
	 * @param manifest The published layout of the blocks.
	 * @returns What the store holds.
	 */
	private static async _openStore(manifest: BlockManifest): Promise<ResidencyResponse> {
		ResidencyWorker._manifest = manifest;
		if (ResidencyWorker._handle === undefined) {
			const directory = await navigator.storage.getDirectory();
			const fileHandle = (await directory.getFileHandle(BLOCK_FILE_NAME, {
				create: true,
			})) as SyncCapableFileHandle;
			ResidencyWorker._handle = await fileHandle.createSyncAccessHandle();
		}
		const byteLength = ResidencyWorker._handle.getSize();
		return {
			kind: 'store-opened',
			byteLength: byteLength,
			presentBlockCount: Math.floor(byteLength / manifest.experts.blockByteLength),
			publishedBlockCount: manifest.experts.convertedExpertCount,
		};
	}

	/**
	 * Downloads whatever blocks are missing and writes them at their exact offsets.
	 *
	 * The store is filled from block zero upwards and its length is the record of how far it got, so closing the page
	 * loses at most the block in flight. Nothing is downloaded twice.
	 *
	 * @param scope The worker's global scope, to report progress on.
	 * @param blocksUrl Where the published block file lives, at its pinned revision.
	 * @param wantedBlockCount How many blocks to make sure are present.
	 * @returns Resolves when the store holds every wanted block.
	 */
	private static async _fillStore(
		scope: DedicatedWorkerScope,
		blocksUrl: string,
		wantedBlockCount: number,
	): Promise<void> {
		const handle = ResidencyWorker._requireHandle();
		const blockByteLength = ResidencyWorker._requireManifest().experts.blockByteLength;
		const startedAt = performance.now();
		let presentBlockCount = Math.floor(handle.getSize() / blockByteLength);
		let downloadedByteLength = 0;

		while (presentBlockCount < wantedBlockCount) {
			const runBlockCount = Math.min(BLOCKS_FOR_EACH_REQUEST, wantedBlockCount - presentBlockCount);
			const firstByte = presentBlockCount * blockByteLength;
			const byteLength = runBlockCount * blockByteLength;
			const bytes = await ResidencyWorker._fetchRange(blocksUrl, firstByte, firstByte + byteLength);
			handle.write(bytes, {
				at: firstByte,
			});
			handle.flush();
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
			presentBlockCount: presentBlockCount,
			seconds: (performance.now() - startedAt) / 1000,
			downloadedByteLength: downloadedByteLength,
		});
	}

	/**
	 * Creates the device, the staging ring, and the expert cache.
	 *
	 * @param configuration How large the cache and the ring are.
	 * @returns What was created.
	 */
	private static async _startResidency(configuration: ResidencyConfiguration): Promise<ResidencyResponse> {
		const manifest = ResidencyWorker._requireManifest();
		ResidencyWorker._configuration = configuration;
		const adapter = await navigator.gpu.requestAdapter();
		if (adapter === null) {
			throw new Error('no WebGPU adapter, so there is nowhere to keep experts');
		}
		/*
		 * A device takes the WebGPU defaults unless it asks for more, and the default largest buffer is 256 megabytes.
		 * That is plenty for one expert part, the largest of which is 786,432 bytes, so the cache would work either
		 * way. It is asked for anyway so that the limit this page prints is the machine's limit rather than the
		 * specification's default, and because the resident part of milestone 5 holds a 622-megabyte token embedding
		 * that the default would refuse outright.
		 */
		const device = await adapter.requestDevice({
			requiredLimits: {
				maxBufferSize: adapter.limits.maxBufferSize,
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			},
		});
		ResidencyWorker._device = device;

		const blockByteLength = manifest.experts.blockByteLength;
		const slotCount = Math.floor(configuration.cacheByteBudget / blockByteLength);
		if (slotCount < 1) {
			throw new Error(`a budget of ${configuration.cacheByteBudget} bytes does not hold one expert`);
		}
		ResidencyWorker._cache = new ExpertSlotCache(device, manifest.experts.parts, slotCount);
		ResidencyWorker._ring = new StagingBufferRing(device, blockByteLength, configuration.stagingBufferCount);

		return {
			kind: 'residency-started',
			slotCount: slotCount,
			cacheByteLength: ResidencyWorker._cache.byteLength,
			stagingBufferCount: ResidencyWorker._ring.bufferCount,
			maximumBufferByteLength: device.limits.maxBufferSize,
		};
	}

	/**
	 * Runs the measurement loop, one message for each step.
	 *
	 * @param scope The worker's global scope, to report on.
	 * @param stepCount How many steps to run.
	 * @param selection Which synthetic sequence drives them.
	 * @param selectedForEachLayer How many experts each layer selects for each token.
	 * @returns Resolves when every step has run.
	 */
	private static async _runSteps(
		scope: DedicatedWorkerScope,
		stepCount: number,
		selection: SelectionKind,
		selectedForEachLayer: number,
	): Promise<void> {
		const manifest = ResidencyWorker._requireManifest();
		const cache = ResidencyWorker._requireCache();
		const device = ResidencyWorker._requireDevice();
		const expertsForEachLayer = manifest.experts.expertsForEachLayer;
		const layerCount = ResidencyWorker._availableLayerCount();

		await ResidencyWorker._applyPinning(selection, selectedForEachLayer, layerCount);
		ResidencyWorker._requireRing().resetCounters();

		const sequence = new ExpertSelection(selection, layerCount, expertsForEachLayer, selectedForEachLayer, 1);

		for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
			const stepStartedAt = performance.now();
			let hitCount = 0;
			let lookupCount = 0;
			let readByteLength = 0;
			let stalledMilliseconds = 0;

			for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
				for (const expertNumber of sequence.select(layerIndex)) {
					const expertIndex = layerIndex * expertsForEachLayer + expertNumber;
					lookupCount++;
					const outcome = cache.acquire(expertIndex);
					if (outcome.wasResident === true) {
						hitCount++;
						continue;
					}
					const missStartedAt = performance.now();
					await ResidencyWorker._loadExpert(expertIndex, outcome.slot);
					stalledMilliseconds += performance.now() - missStartedAt;
					readByteLength += manifest.experts.blockByteLength;
				}
			}

			await device.queue.onSubmittedWorkDone();
			const measurement: StepMeasurement = {
				stepIndex: stepIndex,
				lookupCount: lookupCount,
				hitCount: hitCount,
				readByteLength: readByteLength,
				stalledMilliseconds: stalledMilliseconds,
				totalMilliseconds: performance.now() - stepStartedAt,
			};
			scope.postMessage({
				kind: 'step-measured',
				measurement: measurement,
			});
		}

		scope.postMessage({
			kind: 'steps-finished',
			slotCount: cache.slotCount,
			layerCount: layerCount,
			expertCount: layerCount * expertsForEachLayer,
			stagingWaitedMilliseconds: ResidencyWorker._requireRing().waitedMilliseconds,
		});
	}

	/**
	 * Releases the ring, the cache, and the device. The block file is left alone, because filling it is expensive and
	 * a second run should reuse it.
	 *
	 * @returns Nothing.
	 */
	private static _stopResidency(): void {
		ResidencyWorker._ring?.destroy();
		ResidencyWorker._cache?.destroy();
		ResidencyWorker._device?.destroy();
		ResidencyWorker._ring = undefined;
		ResidencyWorker._cache = undefined;
		ResidencyWorker._device = undefined;
	}

	/**
	 * Chooses which experts are pinned, and reads them in before the timed steps begin.
	 *
	 * The pinned set is learned by counting which experts a warm-up asks for, and the warm-up runs on a **different
	 * seed** from the timed steps. Learning a pinned set from the very tokens it is then measured against would report
	 * a hit rate no real run could reach. Even with a different seed this is optimistic, because both draws come from
	 * the same fixed distribution while real routing moves with the text; that is a limit of the synthetic sequence and
	 * is written down rather than measured around.
	 *
	 * @param selection Which synthetic sequence the run uses.
	 * @param selectedForEachLayer How many experts each layer selects for each token.
	 * @param layerCount How many layers the store actually holds experts for.
	 * @returns Resolves once every pinned expert is resident.
	 */
	private static async _applyPinning(
		selection: SelectionKind,
		selectedForEachLayer: number,
		layerCount: number,
	): Promise<void> {
		const configuration = ResidencyWorker._requireConfiguration();
		if (configuration.pinnedForEachLayer <= 0) {
			return;
		}
		const manifest = ResidencyWorker._requireManifest();
		const cache = ResidencyWorker._requireCache();
		const expertsForEachLayer = manifest.experts.expertsForEachLayer;

		const wantedPinnedCount = configuration.pinnedForEachLayer * layerCount;
		if (wantedPinnedCount >= cache.slotCount) {
			throw new Error(
				`pinning ${configuration.pinnedForEachLayer} experts of each of ${layerCount} layers wants ` +
					`${wantedPinnedCount} slots, and the cache holds ${cache.slotCount}. Nothing could ever be read in.`,
			);
		}

		const warmUp = new ExpertSelection(selection, layerCount, expertsForEachLayer, selectedForEachLayer, 987654321);
		const counts: number[][] = [];
		for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
			counts.push(new Array<number>(expertsForEachLayer).fill(0));
		}
		for (let stepIndex = 0; stepIndex < WARM_UP_STEP_COUNT; stepIndex++) {
			for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
				for (const expertNumber of warmUp.select(layerIndex)) {
					counts[layerIndex][expertNumber]++;
				}
			}
		}

		for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
			const ranked = counts[layerIndex]
				.map((count, expertNumber) => ({
					count: count,
					expertNumber: expertNumber,
				}))
				.sort((left, right) => right.count - left.count)
				.slice(0, configuration.pinnedForEachLayer);
			for (const entry of ranked) {
				const expertIndex = layerIndex * expertsForEachLayer + entry.expertNumber;
				cache.pin(expertIndex);
				const outcome = cache.acquire(expertIndex);
				await ResidencyWorker._loadExpert(expertIndex, outcome.slot);
			}
		}
		await ResidencyWorker._requireDevice().queue.onSubmittedWorkDone();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Moving one expert
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one expert off disk and into its slot in graphics memory.
	 *
	 * This is the path milestone 2 pointed at, and it never touches `queue.writeBuffer`. The bytes are read from the
	 * synchronous access handle straight into a mapped WebGPU buffer, so they are written once rather than copied into
	 * a staging buffer the browser owns and then copied again. The nine copies that follow are queue work, which
	 * milestone 2 measured at about a thirtieth of the cost of the same move through `writeBuffer`.
	 *
	 * @param expertIndex Which expert to read, counted across the whole model.
	 * @param slot The slot in graphics memory to fill.
	 * @returns Resolves once the copies are submitted, not once they have run. The ring waits for the queue when it
	 *   maps the buffer again, which is a full lap later, so the caller does not wait here.
	 */
	private static async _loadExpert(expertIndex: number, slot: ExpertSlot): Promise<void> {
		const manifest = ResidencyWorker._requireManifest();
		const handle = ResidencyWorker._requireHandle();
		const ring = ResidencyWorker._requireRing();
		const device = ResidencyWorker._requireDevice();
		const blockByteLength = manifest.experts.blockByteLength;

		const staging = await ring.acquire();
		const target = new Uint8Array(staging.mapped);
		const readByteLength = handle.read(target, {
			at: expertIndex * blockByteLength,
		});
		if (readByteLength !== blockByteLength) {
			ring.unmap(staging);
			ring.recycle(staging);
			throw new Error(
				`expert ${expertIndex} read ${readByteLength} bytes where ${blockByteLength} were expected, so the ` +
					'store does not hold this expert and every number computed from it would be wrong',
			);
		}
		ring.unmap(staging);

		const encoder = device.createCommandEncoder();
		const parts = manifest.experts.parts;
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
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Downloads one range of the published block file, retrying, and refuses a short answer.
	 *
	 * @param blocksUrl Where the published block file lives.
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
					throw new Error(
						`${bytes.length} bytes came back where ${lastByte - firstByte} were asked for, so the range ` +
							'request was not honoured and the store would hold the wrong bytes',
					);
				}
				return bytes;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
			}
		}
		throw new Error(`the block file could not be read after ${REQUEST_ATTEMPT_COUNT} attempts: ${String(lastError)}`);
	}

	/**
	 * How many whole layers of experts the store actually holds.
	 *
	 * The store can be filled part way, which is the only way to try this page without waiting for 15.61 gigabytes to
	 * arrive. A run must then simulate only the layers that are really there. Selecting an expert the store does not
	 * hold would read zero bytes and report a hit rate for a model that is not present.
	 *
	 * @returns How many layers may be simulated.
	 */
	private static _availableLayerCount(): number {
		const manifest = ResidencyWorker._requireManifest();
		const presentBlockCount = Math.floor(
			ResidencyWorker._requireHandle().getSize() / manifest.experts.blockByteLength,
		);
		const availableLayerCount = Math.floor(presentBlockCount / manifest.experts.expertsForEachLayer);
		if (availableLayerCount < 1) {
			throw new Error('the store does not hold one whole layer of experts yet');
		}
		return Math.min(manifest.experts.layerCount, availableLayerCount);
	}

	/**
	 * @returns The open block file handle.
	 */
	private static _requireHandle(): FileSystemSyncAccessHandle {
		if (ResidencyWorker._handle === undefined) {
			throw new Error('the block store is not open');
		}
		return ResidencyWorker._handle;
	}

	/**
	 * @returns The published manifest.
	 */
	private static _requireManifest(): BlockManifest {
		if (ResidencyWorker._manifest === undefined) {
			throw new Error('the manifest has not been read');
		}
		return ResidencyWorker._manifest;
	}

	/**
	 * @returns The WebGPU device.
	 */
	private static _requireDevice(): GPUDevice {
		if (ResidencyWorker._device === undefined) {
			throw new Error('the residency layer has not been started');
		}
		return ResidencyWorker._device;
	}

	/**
	 * @returns The expert cache.
	 */
	private static _requireCache(): ExpertSlotCache {
		if (ResidencyWorker._cache === undefined) {
			throw new Error('the residency layer has not been started');
		}
		return ResidencyWorker._cache;
	}

	/**
	 * @returns The staging buffer ring.
	 */
	private static _requireRing(): StagingBufferRing {
		if (ResidencyWorker._ring === undefined) {
			throw new Error('the residency layer has not been started');
		}
		return ResidencyWorker._ring;
	}

	/**
	 * @returns How the layer was set up.
	 */
	private static _requireConfiguration(): ResidencyConfiguration {
		if (ResidencyWorker._configuration === undefined) {
			throw new Error('the residency layer has not been started');
		}
		return ResidencyWorker._configuration;
	}
}

ResidencyWorker.listen(self as unknown as DedicatedWorkerScope);
